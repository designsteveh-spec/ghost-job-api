import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ---------------- HEALTH ---------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* ---------------- ANALYZE ---------------- */

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  console.log('[ANALYZE]', url);

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let response;
  let html = '';
  let status = null;

  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
    });

    status = response.status;
    html = await response.text();
  } catch (err) {
    console.error('[FETCH FAILED]', err.message);
    return res.status(200).json({
      score: 20,
      signals: {
        stale: { result: true, delay: 1000, info: 'Fetch blocked' },
        weak: { result: true, delay: 2200 },
        inactivity: { result: true, delay: 3400 },
      },
    });
  }

  /* ---------- DATE SIGNALS ---------- */

  let daysOld = null;

  const dateMatch =
    html.match(/Posted\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
    html.match(/datePosted["']?\s*:\s*["']([^"']+)/i);

  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
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

  /* ---------- FINAL SCORE ---------- */

  let score = 70;
  if (freshness === 'fresh') score = 85;
  if (freshness === 'aging') score = 55;
  if (freshness === 'stale') score = 25;
  if (status !== 200) score = 15;

  res.json({
    score,
    signals: {
      stale: {
        result: freshness === 'stale',
        delay: 1000,
        info:
          daysOld !== null ? `${daysOld} days old` : 'No posting date detected',
      },
      weak: {
        result: html.length < 1200,
        delay: 2200,
      },
      inactivity: {
        result: status !== 200,
        delay: 3400,
      },
    },
  });
});

/* ---------------- START ---------------- */

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
