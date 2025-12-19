import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

function extractMainText(html, selectors) {
  const lower = html.toLowerCase();
  let total = 0;
  for (const sel of selectors) {
    // simple substring test for structural hints
    if (lower.includes(sel)) total++;
  }
  return total;
}


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

/* ---------- DESCRIPTION PRESENCE SCORING ---------- */

let descSignal = 0;

// Identify site type
const isIndeed = hostname.includes('indeed.com');
const isCareerBuilder = hostname.includes('careerbuilder.com');
const isLinkedIn = hostname.includes('linkedin.com/jobs');
const isZipRecruiter = hostname.includes('ziprecruiter.com');

if (isIndeed) {
  // indeed job description container markers
  const matches = extractMainText(html, [
    'jobsearch-JobComponent-description',
    'jobDescriptionText', 
    'description__text'
  ]);
  if (matches >= 2 && words > 300) descSignal += 12;
  else if (matches === 1 && words > 150) descSignal += 6;
  else descSignal -= 10;
}

if (isCareerBuilder) {
  // careerbuilder main posting
  const matches = extractMainText(html, [
    'job-details-section',
    'JobDetailDescription'
  ]);
  if (matches >= 2 && words > 300) descSignal += 14;
  else if (matches === 1 && words > 150) descSignal += 7;
  else descSignal -= 10;
}

if (isLinkedIn) {
  // linkedin descriptors
  const matches = extractMainText(html, [
    'description__text',
    'jobs-unified-description'
  ]);
  if (matches >= 2 && words > 300) descSignal += 16;
  else if (matches === 1 && words > 150) descSignal += 8;
  else descSignal -= 10;
}

if (isZipRecruiter) {
  // ziprecruiter posting body indicator
  const matches = extractMainText(html, [
    'job-description-text',
    'job-description'
  ]);
  if (matches >= 2 && words > 300) descSignal += 14;
  else if (matches === 1 && words > 150) descSignal += 7;
  else descSignal -= 10;
}

// Apply the description signal to score
score += descSignal;


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
  // Fallback for blocked sites (e.g. Indeed)
  res.json({
    score: 30,
    signals: {
      stale: {
        result: true,
        delay: 900,
        info: 'Page blocked automated access',
      },
      weak: {
        result: true,
        delay: 2000,
      },
      inactivity: {
        result: false,
        delay: 3200,
      },
    },
  });
}

});

/* ---------------- START ---------------- */

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
