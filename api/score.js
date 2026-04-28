/**
 * /api/score — POST { url } → { total, subs, tier, normalisedUrl }
 *
 * Pipeline:
 *   1. Validate + normalise the LinkedIn URL
 *   2. Rate-limit by IP (in-memory; resets on cold start)
 *   3. Fan out to Apify (LinkedIn profile) + SerpAPI (Google footprint) in parallel
 *   4. Score brand clarity with Claude Haiku (depends on profile)
 *   5. Compute six dimensions (0-3 each), sum to 0-18, map to tier
 *
 * NOTE: Migrated from ProxyCurl → Apify on 2026-04-27 because Proxycurl's API
 * was decommissioned after LinkedIn's January 2025 lawsuit (every call returns 410).
 */

const APIFY_API     = 'https://api.apify.com/v2/acts';
const APIFY_ACTOR   = process.env.APIFY_LINKEDIN_ACTOR || 'dev_fusion~Linkedin-Profile-Scraper';
const SERPAPI_API   = 'https://serpapi.com/search.json';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const RATE_LIMIT = new Map();
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '5', 10);
const HOUR_MS = 3_600_000;

const TIERS = [
  { min:0,  max:5,  name:'The Hidden Gem',
    tagline:'Real expertise. The world just doesn’t know it yet.',
    blurb:'Your brand is nearly invisible. The good news? Everything is ahead of you. With the right foundations, you can fast-track from unknown to unmissable.',
    cta:"Here's your roadmap from invisible to unmissable" },
  { min:6,  max:10, name:'The Rising Voice',
    tagline:'Building momentum, but gaps are holding you back.',
    blurb:'You have something to say, but your brand isn’t amplifying it yet. Closing a few key gaps could dramatically shift how the right people find and perceive you.',
    cta:"Here's exactly what to build first" },
  { min:11, max:15, name:'The Emerging Authority',
    tagline:'Solid foundations. Time to scale your reach.',
    blurb:'You’re doing more right than most. Your challenge now is consistency and intentionality — turning effort into a brand that reliably attracts the right opportunities.',
    cta:"Here's how to close the gaps fast" },
  { min:16, max:18, name:'The Recognised Leader',
    tagline:'Strong brand. Let’s make it legacy-level.',
    blurb:'You’ve built real authority. The next level is about sharpening your signature, deepening your impact, and ensuring every asset is working as hard as you are.',
    cta:"Here's how to sharpen your edge" }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'You’ve hit the audit limit for this hour. Come back shortly.' });
  }

  const body = req.body || {};
  const normalised = normaliseLinkedIn(body.url);
  if (!normalised) {
    return res.status(400).json({ error: 'Please provide a valid LinkedIn profile URL.' });
  }

  trackRequest(ip);

  try {
    // Build a fully-qualified LinkedIn URL with trailing slash — some Apify actors
    // (e.g. supreme_coder) reject URLs without it as "not valid".
    const fullUrl = `https://www.${normalised}/`;

    // 1) Fan out — profile + serp in parallel
    const [profileRes, serpRes] = await Promise.allSettled([
      fetchApify(fullUrl),
      fetchSerpFootprint(normalised)
    ]);

    if (profileRes.status === 'rejected' || !profileRes.value) {
      const errMsg = profileRes.reason?.message || String(profileRes.reason) || 'no value';
      console.error('Apify failed:', errMsg);
      return res.status(502).json({
        error: 'We couldn’t fetch that LinkedIn profile. The URL may be wrong or the profile is private.',
        _debug: errMsg.slice(0, 400),
        _actor: APIFY_ACTOR
      });
    }
    const profile = profileRes.value;
    const serp    = serpRes.status === 'fulfilled' ? serpRes.value : null;

    // 2) Score brand clarity (LLM) — non-blocking-failure
    const clarity = await scoreBrandClarity(profile).catch(err => {
      console.error('Claude clarity scoring failed:', err);
      return { score: 1, rationale: 'Fallback heuristic — LLM unavailable.' };
    });

    // 3) Compute the six dimensions
    const subs = {
      footprint: scoreFootprint(profile, serp),
      clarity:   clarity.score,
      authority: scoreAuthority(profile),
      cadence:   scoreCadence(profile),
      visual:    scoreVisual(profile, clarity),
      network:   scoreNetwork(profile)
    };

    const total = Object.values(subs).reduce((a, b) => a + b, 0);
    const tier  = tierFor(total);

    return res.status(200).json({
      total, subs, tier,
      normalisedUrl: normalised,
      _meta: {
        clarityRationale: clarity.rationale,
        // TEMP diagnostic:
        profileKeys: Object.keys(profile || {}),
        profileRawTrunc: JSON.stringify(profile || {}).slice(0, 800),
        profileSample: {
          headline: getHeadline(profile),
          aboutLen: (getAbout(profile) || '').length,
          followers: getFollowers(profile),
          connections: getConnections(profile),
          activities: getActivities(profile).length,
          recommendations: getRecommendations(profile).length,
          hasPhoto: !!getPhotoUrl(profile),
          hasBanner: !!getBannerUrl(profile)
        }
      }
    });
  } catch (err) {
    console.error('score handler error:', err);
    return res.status(500).json({ error: 'Audit failed. Please try again in a minute.' });
  }
}

/* ═══════════════════════════ EXTERNAL CALLS ═══════════════════════════ */

async function fetchApify(linkedinUrl) {
  // Apify "run-sync-get-dataset-items" runs the actor and returns the dataset rows directly.
  // For dev_fusion/Linkedin-Profile-Scraper, input shape is { profileUrls: [...] }.
  const url = `${APIFY_API}/${APIFY_ACTOR}/run-sync-get-dataset-items`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
    },
    // Different LinkedIn actors use different input shapes:
    //   • dev_fusion/*   → profileUrls: ["https://..."]                 (string array)
    //   • supreme_coder* → urls:        [{ url: "https://..." }]        (object array, Apify standard)
    //   • generic Apify  → startUrls:   [{ url: "https://..." }]        (very common pattern)
    // Sending all shapes is safe — each actor validates only its expected field.
    body: JSON.stringify({
      profileUrls: [linkedinUrl],
      urls:        [{ url: linkedinUrl }],
      startUrls:   [{ url: linkedinUrl }]
    })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Apify ${r.status}: ${text.slice(0, 200)}`);
  }
  const items = await r.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Apify returned no items');
  }
  // Some actors wrap their output. Unwrap defensively.
  return items[0].data || items[0];
}

async function fetchSerpFootprint(normalisedUrl) {
  const handle = normalisedUrl.split('/in/')[1]?.split('/')[0] || '';
  const q = handle.replace(/-/g, ' ');
  const params = new URLSearchParams({
    engine: 'google',
    q: q,
    num: '10',
    api_key: process.env.SERPAPI_API_KEY
  });
  const r = await fetch(`${SERPAPI_API}?${params}`);
  if (!r.ok) throw new Error(`SerpAPI ${r.status}`);
  return r.json();
}

async function scoreBrandClarity(profile) {
  const headline = (getHeadline(profile) || '').slice(0, 400);
  const summary  = (getAbout(profile)    || '').slice(0, 2000);

  const prompt = `You are a brand strategist scoring an executive's personal brand clarity from their LinkedIn.

Score the brand clarity from 0 to 3:
- 0: No discernible message. Generic title or empty/vague About section.
- 1: A rough idea is visible but the message is unclear or audience is undefined.
- 2: Clear value proposition and audience, but phrasing is generic or slightly inconsistent.
- 3: Crystal clear: who they help, how they help, what makes them different. Specific, ownable, confident.

LinkedIn headline:
"""${headline}"""

LinkedIn About:
"""${summary}"""

Respond with JSON only, no prose:
{"score": <0|1|2|3>, "rationale": "<one short sentence>"}`;

  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { score: 1, rationale: 'Parse fallback.' };
  try {
    const parsed = JSON.parse(match[0]);
    const s = Math.max(0, Math.min(3, Math.round(Number(parsed.score) || 0)));
    return { score: s, rationale: String(parsed.rationale || '').slice(0, 200) };
  } catch {
    return { score: 1, rationale: 'Parse fallback.' };
  }
}

/* ═══════════════════════════ FIELD MAPPERS (defensive across actor shapes) ═══════════════════════════ */
// Apify actors don't all use identical field names. These helpers cover the common ones
// so the same scoring code works whether the actor returns `headline` or `headlineText`,
// `followers` or `followersCount`, etc. If the chosen actor uses something else,
// add aliases here — no need to touch the scoring functions.

function getHeadline(p)    { return p.headline || p.headlineText || p.title || ''; }
function getAbout(p)       { return p.about || p.summary || p.description || ''; }
function getPhotoUrl(p)    { return p.profilePic || p.profilePicture || p.profilePicUrl ||
                                    p.profilePicHighQuality || p.profile_pic_url || null; }
function getBannerUrl(p)   { return p.coverPic || p.coverPicture || p.bannerImage ||
                                    p.backgroundCoverImage || p.background_cover_image_url || null; }
function getFollowers(p)   {
  const v = p.followers ?? p.followersCount ?? p.follower_count ?? 0;
  return Number(v) || 0;
}
function getConnections(p) {
  const c = p.connections ?? p.connectionsCount ?? p.connection_count ?? 0;
  if (typeof c === 'string') {
    const m = c.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  return Number(c) || 0;
}
function getRecommendations(p) {
  return p.recommendations || p.recommendationsList || p.received_recommendations || [];
}
function getActivities(p) {
  return p.activities || p.posts || p.recentActivities || p.recent_posts || [];
}
function getArticles(p) {
  return p.articles || p.publications || [];
}
function getHonors(p) {
  return p.honorsAndAwards || p.honors || p.awards ||
         p.accomplishment_honors_awards || [];
}

/* ═══════════════════════════ SCORING ═══════════════════════════ */

function scoreFootprint(profile, serp) {
  let pts = 0;
  if (getPhotoUrl(profile))        pts += 0.5;
  if (getBannerUrl(profile))       pts += 0.5;
  const about = getAbout(profile);
  if (about && about.length > 200) pts += 0.5;

  const results = serp?.organic_results || [];
  if (results.length >= 8)      pts += 1.5;
  else if (results.length >= 4) pts += 1;
  else if (results.length >= 1) pts += 0.5;

  if (results.some(r => /forbes|bloomberg|wsj|techcrunch|reuters|tedx|news|press/i.test(r.link || ''))) {
    pts += 0.5;
  }
  return clamp03(Math.round(pts));
}

function scoreAuthority(profile) {
  let pts = 0;
  const recsCount     = getRecommendations(profile).length;
  const honorsCount   = getHonors(profile).length;
  const articlesCount = getArticles(profile).length;

  if (recsCount >= 5)      pts += 1;
  else if (recsCount >= 2) pts += 0.5;

  if (articlesCount >= 3)  pts += 1;
  else if (articlesCount >= 1) pts += 0.5;

  if (honorsCount >= 1) pts += 0.5;

  const text = (getHeadline(profile) + ' ' + getAbout(profile)).toLowerCase();
  if (/featured|forbes|bloomberg|wsj|techcrunch|tedx|keynote|speaker|awarded|recognised|recognized/i.test(text)) {
    pts += 0.75;
  }
  return clamp03(Math.round(pts));
}

function scoreCadence(profile) {
  const activities = getActivities(profile);
  if (activities.length >= 11) return 3;
  if (activities.length >= 4)  return 2;
  if (activities.length >= 1)  return 1;
  return 0;
}

function scoreVisual(profile, clarity) {
  let pts = 0;
  if (getPhotoUrl(profile))  pts += 1;
  if (getBannerUrl(profile)) pts += 1;
  const about = getAbout(profile);
  if (about && about.length > 300) pts += 0.75;
  if (clarity?.score >= 2) pts += 0.25;
  return clamp03(Math.round(pts));
}

function scoreNetwork(profile) {
  const followers   = getFollowers(profile);
  const connections = getConnections(profile);
  const recsCount   = getRecommendations(profile).length;

  let pts = 0;
  if (followers >= 50_000)      pts += 2;
  else if (followers >= 10_000) pts += 1.5;
  else if (followers >= 2_000)  pts += 1;
  else if (followers >= 500)    pts += 0.5;

  if (connections >= 500) pts += 0.5;
  if (recsCount >= 5)     pts += 0.5;

  return clamp03(Math.round(pts));
}

function tierFor(score) {
  return TIERS.find(t => score >= t.min && score <= t.max) || TIERS[0];
}

/* ═══════════════════════════ HELPERS ═══════════════════════════ */

function clamp03(n) {
  return Math.max(0, Math.min(3, n | 0));
}

function normaliseLinkedIn(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (!s.includes('linkedin.com')) {
    s = s.replace(/^@/, '');
    if (!s.startsWith('in/')) s = 'in/' + s;
    s = 'linkedin.com/' + s;
  }
  s = s.split('?')[0].replace(/\/$/, '');
  if (!s.startsWith('linkedin.com/in/')) return null;
  const handle = s.slice('linkedin.com/in/'.length);
  if (!handle || /[^a-z0-9-_%.]/.test(handle)) return null;
  return s;
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= RATE_LIMIT_PER_HOUR;
}

function trackRequest(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT.set(ip, { count: 1, resetAt: now + HOUR_MS });
  } else {
    entry.count += 1;
  }
}
