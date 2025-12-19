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

/* ---------- INDEED STRUCTURE SIGNALS ---------- */

if (hostname.includes('indeed.com')) {
  // Indeed serves near-identical HTML to scrapers
  // Penalize uncertainty slightly
  score -= 4;

  // Job age hints embedded in scripts (when present)
  if (lower.includes('jobagedays') || lower.includes('ageindays')) {
    score += 6;
  }

  // Urgency indicators
  if (
    lower.includes('urgently hiring') ||
    lower.includes('actively hiring')
  ) {
    score += 8;
  }
}


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

// Job ID–based entropy (domain-safe)
let entropySeed = url;

try {
  const u = new URL(url);

  // Indeed job key
  if (u.searchParams.get('jk')) {
    entropySeed = u.searchParams.get('jk');
  }

  // Greenhouse / Workday numeric IDs
  const pathMatch = u.pathname.match(/\d{5,}/);
  if (pathMatch) {
    entropySeed += pathMatch[0];
  }
} catch {}

const entropy = stableHash(entropySeed) % 11; // 0–10
score += entropy;

/* ---------- SCORE NORMALIZATION ---------- */

// Small deterministic variation to prevent identical scores
const variationSource =
  hostname +
  words.toString() +
  url.length.toString();

const variation = stableHash(variationSource) % 7; // 0–6
score += variation - 3; // shifts score by -3 to +3

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
