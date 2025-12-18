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

/* ---------------- HELPERS ---------------- */

function stableHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

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
    const html = await response.text();
    const hostname = new URL(url).hostname;

    /* ---------- BASE SCORE ---------- */

    let score = 20;

    /* ---------- HTTP STATUS ---------- */

    if (status === 200) score += 15;
    else score -= 15;

    /* ---------- TEXT LENGTH ---------- */

    const text = html.replace(/<[^>]*>/g, ' ');
    const words = text.split(/\s+/).filter(Boolean).length;

    if (words < 300) score -= 10;
    else if (words < 800) score += 10;
    else if (words < 2000) score += 18;
    else score -= 5; // bloated boilerplate

    /* ---------- EVERGREEN LANGUAGE ---------- */

    const evergreenPhrases = [
      'always looking',
      'talent community',
      'may be filled at any time',
      'join our network',
      'future opportunities',
    ];

    const lower = text.toLowerCase();
    evergreenPhrases.forEach((p) => {
      if (lower.includes(p)) score -= 8;
    });

    /* ---------- APPLY SIGNAL ---------- */

    if (lower.includes('apply') || lower.includes('application')) {
      score += 8;
    } else {
      score -= 12;
    }

    /* ---------- DOMAIN HEURISTICS ---------- */

    if (
      hostname.includes('indeed') ||
      hostname.includes('linkedin') ||
      hostname.includes('greenhouse') ||
      hostname.includes('workday')
    ) {
      score += 10;
    }

    /* ---------- JOB-ID ENTROPY ---------- */

    const entropySource = url.split('?')[0] + hostname;
    const entropy = stableHash(entropySource) % 9; // 0–8
    score += entropy;

    /* ---------- CLAMP ---------- */

    score = Math.max(5, Math.min(score, 95));

    /* ---------- RESPONSE ---------- */

    res.json({
      score,
      signals: {
        stale: {
          result: score < 40,
          delay: 900,
        },
        weak: {
          result: words < 400,
          delay: 2000,
        },
        inactivity: {
          result: status !== 200,
          delay: 3200,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

/* ---------------- START ---------------- */

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
