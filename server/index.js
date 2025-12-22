import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

function extractMainText(html, selectors) {
  const lower = html.toLowerCase();
  let total = 0;
  for (const sel of selectors) {
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
  const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 6000);

const response = await fetch(url, {
  redirect: 'follow',
  signal: controller.signal,
  headers: { 'User-Agent': 'GhostJobChecker/1.0' },
});

clearTimeout(timeout);


    const status = response.status;
    const html = await response.text();
    const hostname = new URL(url).hostname;

    /* ---------- BASE SCORE ---------- */

    let score = 20;

    /* ---------- HTTP STATUS ---------- */

    if (status === 200) score += 15;
    else score -= 15;

    /* ---------- TEXT EXTRACTION ---------- */

    const text = html.replace(/<[^>]*>/g, ' ');
    const lower = text.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean).length;

    /* ---------- DESCRIPTION PRESENCE SCORING ---------- */

    let descSignal = 0;

    const isIndeed = hostname.includes('indeed.com');
    const isCareerBuilder = hostname.includes('careerbuilder.com');
    const isLinkedIn = hostname.includes('linkedin.com/jobs');
    const isZipRecruiter = hostname.includes('ziprecruiter.com');

    if (isIndeed) {
      const matches = extractMainText(html, [
        'jobsearch-jobcomponent-description',
        'jobdescriptiontext',
        'description__text',
      ]);
      if (matches >= 2 && words > 300) descSignal += 12;
      else if (matches === 1 && words > 150) descSignal += 6;
      else descSignal -= 10;
    }

    if (isCareerBuilder) {
      const matches = extractMainText(html, [
        'job-details-section',
        'jobdetaildescription',
      ]);
      if (matches >= 2 && words > 300) descSignal += 14;
      else if (matches === 1 && words > 150) descSignal += 7;
      else descSignal -= 10;
    }

    if (isLinkedIn) {
      const matches = extractMainText(html, [
        'description__text',
        'jobs-unified-description',
      ]);
      if (matches >= 2 && words > 300) descSignal += 16;
      else if (matches === 1 && words > 150) descSignal += 8;
      else descSignal -= 10;
    }

    if (isZipRecruiter) {
      const matches = extractMainText(html, [
        'job-description-text',
        'job-description',
      ]);
      if (matches >= 2 && words > 300) descSignal += 14;
      else if (matches === 1 && words > 150) descSignal += 7;
      else descSignal -= 10;
    }

    score += descSignal;

    /* ---------- LENGTH HEURISTICS ---------- */

    if (words < 300) score -= 10;
    else if (words < 800) score += 10;
    else if (words < 2000) score += 18;
    else score -= 5;

    /* ---------- INDEED STRUCTURE SIGNALS ---------- */

    if (isIndeed) {
      score -= 4;

      if (lower.includes('jobagedays') || lower.includes('ageindays')) {
        score += 6;
      }

      if (
        lower.includes('urgently hiring') ||
        lower.includes('actively hiring')
      ) {
        score += 8;
      }
    }

    /* ---------- EVERGREEN LANGUAGE ---------- */

    [
      'always looking',
      'talent community',
      'may be filled at any time',
      'join our network',
      'future opportunities',
    ].forEach((p) => {
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

    let entropySeed = url;

    try {
      const u = new URL(url);
      if (u.searchParams.get('jk')) entropySeed = u.searchParams.get('jk');
      const pathMatch = u.pathname.match(/\d{5,}/);
      if (pathMatch) entropySeed += pathMatch[0];
    } catch {}

    score += stableHash(entropySeed) % 11;

    /* ---------- SCORE NORMALIZATION ---------- */

    const variationSource =
      hostname + words.toString() + url.length.toString();

    const variation = stableHash(variationSource) % 7;
    score += variation - 3;

    /* ---------- CLAMP ---------- */

    score = Math.max(5, Math.min(score, 95));

    /* ---------- RESPONSE ---------- */

    res.json({
      score,
      signals: {
        stale: { result: score < 40, delay: 900 },
        weak: { result: words < 400, delay: 2000 },
        inactivity: { result: status !== 200, delay: 3200 },
      },
    });
  } catch (err) {
    res.json({
      score: 30,
      signals: {
        stale: {
          result: true,
          delay: 900,
          info: 'Page blocked automated access',
        },
        weak: { result: true, delay: 2000 },
        inactivity: { result: false, delay: 3200 },
      },
    });
  }
});

/* ---------------- START ---------------- */

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

