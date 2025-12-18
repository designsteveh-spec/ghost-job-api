import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();

/* ---------------- CONFIG ---------------- */

const PORT = process.env.PORT || 3000;

/* ---------------- MIDDLEWARE ---------------- */

app.use(cors());
app.use(express.json());

/* ---------------- HEALTH ---------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* ---------------- ANALYZE ---------------- */

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'GhostJobChecker/1.0',
      },
    });

    const status = response.status;
    const lastModified = response.headers.get('last-modified');

    let daysOld = null;

    if (lastModified) {
      const parsed = new Date(lastModified);
      if (!isNaN(parsed.getTime())) {
        daysOld = Math.floor(
          (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }

    let freshness = 'missing';
    if (daysOld !== null) {
      if (daysOld <= 45) freshness = 'fresh';
      else if (daysOld <= 90) freshness = 'aging';
      else freshness = 'stale';
    }

let risk = 0;


// Freshness signal (scaled)
if (daysOld === null) {
  risk += 28;
} else if (daysOld > 180) {
  risk += 42;
} else if (daysOld > 120) {
  risk += 34;
} else if (daysOld > 90) {
  risk += 26;
} else if (daysOld > 60) {
  risk += 18;
} else if (daysOld > 30) {
  risk += 10;
} else {
  risk += 4;
}


const hostname = new URL(url).hostname;

// Evergreen platform weighting
if (hostname.includes('smartrecruiters')) risk += 14;
if (hostname.includes('greenhouse')) risk += 12;
if (hostname.includes('workday')) risk += 10;

// Aggregators often fresher
if (hostname.includes('indeed')) risk -= 6;
if (hostname.includes('linkedin')) risk -= 4;

// URL complexity
const queryCount = (url.match(/=/g) || []).length;
risk += Math.min(queryCount * 2, 10);

// Normalize to probability-style score
risk = Math.max(0, Math.min(100, risk));
const score = Math.round(100 - risk);


    res.json({
      score,
      signals: {
        stale: {
          result: freshness === 'stale',
          delay: 1000,
          info:
            daysOld !== null
              ? `${daysOld} days old`
              : 'No date detected',
        },
        weak: {
          result: false,
          delay: 2200,
        },
        inactivity: {
          result: status !== 200,
          delay: 3400,
        },
      },
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch job page',
    });
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
