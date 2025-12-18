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

    let score = 25;

// Freshness signal (only if available)
if (freshness === 'fresh') score += 35;
else if (freshness === 'aging') score += 15;

// Domain heuristics
const hostname = new URL(url).hostname;

if (
  hostname.includes('indeed.com') ||
  hostname.includes('linkedin.com') ||
  hostname.includes('workday') ||
  hostname.includes('greenhouse.io')
) {
  score += 20;
}

// Query-string job IDs (often evergreen)
if (url.includes('?')) {
  score += 10;
}

// Clamp score
score = Math.min(score, 95);


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
