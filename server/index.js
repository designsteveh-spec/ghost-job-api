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

function hasOutboundApply(html) {
  const lower = html.toLowerCase();
  return (
    lower.includes('apply on company site') ||
    lower.includes('apply now') ||
    lower.includes('external job') ||
    lower.includes('rel="nofollow"') ||
    lower.includes('onclick="apply"')
  );
}

function stableHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/* ---------------- DETECTION HELPERS ---------------- */

// A) Canonical Job ID (URL-derived only; safe + deterministic)
function extractCanonicalJobIdFromUrl(u) {
  try {
    const qp = u.searchParams;

    const fromQuery = (
      qp.get('jk') ||
      qp.get('jobId') ||
      qp.get('job_id') ||
      qp.get('job') ||
      ''
    ).trim();

    if (fromQuery) return fromQuery;

    const path = u.pathname || '';
    const last = path.split('/').filter(Boolean).pop() || '';
    if (/^[a-z0-9-]{8,}$/i.test(last)) return last;

    const m = path.match(/\d{5,}/);
    if (m) return m[0];
  } catch {}

  return null;
}

// A) JSON-LD datePosted detection (preferred)
// Returns an ISO-ish date string when found, else null.
function extractJsonLdDatePosted(html) {
  if (!html) return null;

  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;

  const found = [];

  const walk = (node) => {
    if (!node) return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node === 'object') {
      const t = node['@type'];
      const isJobPosting =
        (typeof t === 'string' && t.toLowerCase().includes('jobposting')) ||
        (Array.isArray(t) && t.some((x) => String(x).toLowerCase().includes('jobposting')));

      const dp =
        (typeof node.datePosted === 'string' && node.datePosted.trim()) ? node.datePosted.trim() :
        (typeof node.dateCreated === 'string' && node.dateCreated.trim()) ? node.dateCreated.trim() :
        null;

      if (dp) found.push({ isJobPosting, value: dp });

      for (const k of Object.keys(node)) walk(node[k]);
    }
  };

  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      walk(parsed);
    } catch {
      // ignore parse errors safely
    }
  }

  const preferred = found.find((x) => x.isJobPosting)?.value;
  return preferred || found[0]?.value || null;
}

function formatAgeFromDateString(dateStr) {
  if (!dateStr) return null;

  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  // If date is in the future by a lot, ignore (bad metadata)
  if (diffMs < -6 * 60 * 60 * 1000) return null;

  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffDays <= 0) {
    if (diffHours <= 0) return 'Posted today';
    if (diffHours === 1) return 'Posted 1 hour ago';
    return `Posted ${diffHours} hours ago`;
  }

  if (diffDays === 1) return 'Posted 1 day ago';
  return `Posted ${diffDays} days ago`;
}

// Metadata/time fallback (safe): <time datetime>, <meta content>, or simple json-ish keys
function extractMetaOrTimeDatePosted(html) {
  if (!html) return null;

  // 1) <time datetime="..."> near "posted"
  const timeRe = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = timeRe.exec(html)) !== null) {
    const dt = (m[1] || '').trim();
    if (!dt) continue;

    const idx = m.index || 0;
    const start = Math.max(0, idx - 250);
    const end = Math.min(html.length, idx + 250);
    const windowText = html.slice(start, end).toLowerCase();

    if (windowText.includes('posted')) return dt;
  }

  // 2) meta publish-ish timestamps
  const metaRe = /<meta[^>]+>/gi;
  const keys = [
    'article:published_time',
    'article:modified_time',
    'og:updated_time',
    'pubdate',
    'publishdate',
    'publish_date',
    'date',
    'dc.date',
    'dc.date.issued',
    'sailthru.date',
  ];

  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const tagLower = tag.toLowerCase();

    if (!tagLower.includes('content=')) continue;
    const keyHit = keys.some((k) => tagLower.includes(k));
    if (!keyHit) continue;

    const contentMatch = tag.match(/content=["']([^"']+)["']/i);
    const content = (contentMatch?.[1] || '').trim();
    if (!content) continue;

    if (tagLower.includes('publish') || tagLower.includes('posted') || tagLower.includes('modified')) {
      return content;
    }
  }

  // 3) json-ish fields (not necessarily valid JSON)
  const lower = html.toLowerCase();
  const jsonish = lower.match(
    /(?:dateposted|posteddate|date_posted|publishdate|publishedat)["']?\s*[:=]\s*["']([^"']{6,40})["']/i
  );
  if (jsonish && jsonish[1]) return jsonish[1].trim();

  return null;
}


// B) Inline age signal parsing (fallback)
function extractInlinePostedAge(html) {
  const rawLower = (html || '').toLowerCase();
  const lower = rawLower
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  if (lower.includes('just posted')) return 'Just posted';

  // conservative “today”
  if (lower.includes('posted today') || lower.includes('posted: today')) return 'Posted today';

  // AWN: class="posted-days-text">Posted 2 days ago
  let m = rawLower.match(/posted-days-text[^>]*>\s*posted\s*(\d+)\s*day[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} days ago`;

  m = rawLower.match(/posted-days-text[^>]*>\s*posted\s*(\d+)\s*hour[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} hours ago`;

  // Allow punctuation/bullets between "posted" and the number (":", "•", "-", "—", "|")
  // Examples:
  // - "Posted 2 days ago"
  // - "Posted: 2 days ago"
  // - "Posted • 2 days ago"
  m = lower.match(/posted\s*(?:[:\-–—•|]\s*)?(\d+)\+?\s*day[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} days ago`;

  m = lower.match(/posted\s*(?:[:\-–—•|]\s*)?(\d+)\+?\s*hour[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} hours ago`;

  // Some sites omit the word "posted" in the same node; keep fallback
  m = lower.match(/(\d+)\+?\s*day[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} days ago`;

  m = lower.match(/(\d+)\+?\s*hour[s]?\s*ago/);
  if (m && m[1]) return `Posted ${m[1]} hours ago`;

  return null;
}


// Master: JSON-LD first, then inline
function detectPostingAgeFromHtml(html) {

  const jsonLdDate = extractJsonLdDatePosted(html);
  const fromJsonLd = formatAgeFromDateString(jsonLdDate);
  if (fromJsonLd) return fromJsonLd;

  const metaOrTimeDate = extractMetaOrTimeDatePosted(html);
  const fromMetaOrTime = formatAgeFromDateString(metaOrTimeDate);
  if (fromMetaOrTime) return fromMetaOrTime;

  const inline = extractInlinePostedAge(html);
  if (inline) return inline;

  return null;
}


/* ---------------- ANALYZE ---------------- */


app.post('/api/analyze', async (req, res) => {
  const { url: rawUrl, jobDescription: rawJobDescription } = req.body;

  const urlValue = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const descValue =
    typeof rawJobDescription === 'string' ? rawJobDescription.trim() : '';

  // Must provide at least one input
  if (!urlValue && !descValue) {
    return res
      .status(400)
      .json({ error: 'Provide a job link or a job description.' });
  }

  // ✅ Description-only path (Deep Check)
  if (!urlValue && descValue) {
    const text = descValue;
    const lower = text.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean).length;

    let score = 20;

    // Length heuristic
    if (words < 150) score -= 10;
    else if (words < 400) score += 6;
    else if (words < 1000) score += 12;
    else score += 18;

    // Evergreen / “talent community” language
    [
      'always looking',
      'talent community',
      'may be filled at any time',
      'join our network',
      'future opportunities',
    ].forEach((p) => {
      if (lower.includes(p)) score -= 8;
    });

    // Apply language
    if (lower.includes('apply') || lower.includes('application')) score += 8;
    else score -= 6;

    // Add some deterministic variability
    score += stableHash(text.slice(0, 2000)) % 11;

    // Clamp
    score = Math.max(5, Math.min(score, 95));

    return res.json({
      score,
      detected: {
        postingAge: null,
        employerSource: null,
        canonicalJobId: null,
      },
      signals: {
        stale: { result: score < 40, delay: 900 },
        weak: { result: words < 400, delay: 2000 },
        inactivity: { result: false, delay: 3200 },
      },
    });
  }

  // ✅ URL path (existing behavior)
  const url = urlValue;

  // Soft validation: only reject if the URL is malformed / unsupported protocol.
  // This does NOT change behavior for valid working links.
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({
      error: 'That link doesn’t look valid. Please paste the full URL starting with https://',
    });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({
      error: 'Please use a normal http(s) link (starting with https://).',
    });
  }

  // Detected (safe, deterministic). Posting age is filled after we fetch HTML.
  const detectedEmployerSource = parsedUrl.hostname || null;
  const detectedCanonicalJobId = extractCanonicalJobIdFromUrl(parsedUrl);

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

const DEBUG_POSTING_AGE = false; // set true temporarily
if (DEBUG_POSTING_AGE) {
  console.log('[posting-age] host=', detectedEmployerSource);
  console.log('[posting-age] html_len=', html.length);
  console.log('[posting-age] has_jsonld=', /application\/ld\+json/i.test(html));
  console.log('[posting-age] has_posted_word=', /posted/i.test(html));
  console.log('[posting-age] sample_len=', Math.min(500, html.length));
}


    // Posting age detection (JSON-LD datePosted first, then inline "Posted X days ago")
    // NOTE: This does NOT affect scoring unless you later choose to use it.
    const detectedPostingAge = detectPostingAgeFromHtml(html) || null;

    const hostname = parsedUrl.hostname;

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
    const isSimplyHired = hostname.includes('simplyhired.com');

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

    /* ---------- SIMPLYHIRED AGGREGATOR HANDLING ---------- */

    if (isSimplyHired) {
      // SimplyHired is an aggregator shell, not a job host

      // Neutralize harsh low-word penalties
      if (words < 300) score += 8;

      // Outbound apply link = likely real job
      if (hasOutboundApply(html)) {
        score += 12;
      } else {
        score -= 4;
      }

      // Cap confidence range for aggregators
      score = Math.min(score, 70);
      score = Math.max(score, 18);
    }

    if (isSimplyHired) {
      // SimplyHired renders via JS / embedded JSON
      const matches = extractMainText(html, [
        'jobdescription',
        'job-description',
        'jobposting',
        'application/ld+json',
      ]);

      if (matches >= 2 && words > 200) descSignal += 10;
      else if (matches >= 1) descSignal += 4;
      else descSignal -= 6; // softer penalty than unknown sites
    }

    score += descSignal;

    /* ---------- LENGTH HEURISTICS ---------- */

    if (words < 300) {
      if (!isSimplyHired) score -= 10;
    } else if (words < 800) score += 10;
    else if (words < 2000) score += 18;
    else score -= 5;

    /* ---------- INDEED STRUCTURE SIGNALS ---------- */

    if (isIndeed) {
      score -= 4;

      if (lower.includes('jobagedays') || lower.includes('ageindays')) {
        score += 6;
      }

      if (lower.includes('urgently hiring') || lower.includes('actively hiring')) {
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
      if (lower.includes(p) && !isSimplyHired) score -= 8;
    });

    /* ---------- APPLY SIGNAL ---------- */

    if (lower.includes('apply') || lower.includes('application')) {
      score += 8;
    } else if (!isSimplyHired) {
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

    if (isSimplyHired) {
      score += 6; // aggregator trust, lower than Indeed
    }

    /* ---------- JOB-ID ENTROPY ---------- */

    let entropySeed = url;

    if (isSimplyHired) {
      entropySeed = url + words.toString();
    }

    try {
      const u = new URL(url);
      if (u.searchParams.get('jk')) entropySeed = u.searchParams.get('jk');
      const pathMatch = u.pathname.match(/\d{5,}/);
      if (pathMatch) entropySeed += pathMatch[0];
    } catch {}

    score += stableHash(entropySeed) % (isSimplyHired ? 17 : 11);

    /* ---------- SCORE NORMALIZATION ---------- */

    const variationSource =
      hostname + words.toString() + url.length.toString();

    const variation = stableHash(variationSource) % 7;
    score += variation - 3;

    /* ---------- CLAMP ---------- */

    if (isSimplyHired) {
      score = Math.max(18, score);
    }

    score = Math.max(5, Math.min(score, 95));

    /* ---------- RESPONSE ---------- */

    return res.json({
      score,
      detected: {
        postingAge: detectedPostingAge,
        employerSource: detectedEmployerSource,
        canonicalJobId: detectedCanonicalJobId,
      },
      signals: {
        stale: { result: score < 40, delay: 900 },
        weak: { result: words < 400, delay: 2000 },
        inactivity: { result: status !== 200, delay: 3200 },
      },
    });
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    const msg = String(err?.message || '').toLowerCase();

    // Soft handling for unreachable / fake domains (NXDOMAIN / DNS failures)
    const isDnsFailure =
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ERR_NAME_NOT_RESOLVED' ||
      msg.includes('getaddrinfo') ||
      msg.includes('enotfound') ||
      msg.includes('name not resolved');

    if (isDnsFailure) {
      return res.status(400).json({
        error: `We couldn’t reach that domain (${parsedUrl.hostname}). It may be misspelled or offline. Please double-check the link.`,
        detected: {
          postingAge: null,
          employerSource: detectedEmployerSource,
          canonicalJobId: detectedCanonicalJobId,
        },
      });
    }

    // Everything else: keep your existing fallback behavior (no regression)
    return res.json({
      score: 30,
      detected: {
        postingAge: null,
        employerSource: detectedEmployerSource,
        canonicalJobId: detectedCanonicalJobId,
      },
      signals: {
        stale: {
          result: true,
          delay: 900,
          info: 'Network issue while loading this page',
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
