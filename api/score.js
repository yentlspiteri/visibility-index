/**
 * /api/score — POST { url } → { total, subs, tier, normalisedUrl }
 *
 * Pipeline:
 *   1. Validate + normalise the LinkedIn URL
 *   2. Rate-limit by IP (in-memory; resets on cold start)
 *   3. Fan out to ProxyCurl + SerpAPI in parallel
 *   4. Score brand clarity with Claude Haiku (depends on profile)
 *   5. Compute six dimensions (0-3 each), sum to 0-18, map to tier
 */

const PROXYCURL_API   = 'https://nubela.co/proxycurl/api/v2/linkedin';
const SERPAPI_API     = 'https://serpapi.com/search.json';
const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
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
  // Same-origin in production; permissive for safety.
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
    const fullUrl = 'https://' + normalised;

    // 1) Fan out — profile + serp in parallel
    const [profileRes, serpRes] = await Promise.allSettled([
      fetchProxyCurl(fullUrl),
      fetchSerpFootprint(normalised)
    ]);

    if (profileRes.status === 'rejected' || !profileRes.value) {
      console.error('ProxyCurl failed:', profileRes.reason || 'no value');
      return res.status(502).json({ error: 'We couldn’t fetch that LinkedIn profile. The URL may be wrong or the profile is private.' });
    }
    const profile = profileRes.value;
    const serp    = serpRes.status === 'fulfilled' ? serpRes.value : null;

    // 2) Score brand clarity (LLM) — non-blocking-failure
    let clarity = await scoreBrandClarity(profile).catch(err => {
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
      _meta: { clarityRationale: clarity.rationale }
    });
  } catch (err) {
    console.error('score handler error:', err);
    return res.status(500).json({ error: 'Audit failed. Please try again in a minute.' });
  }
}

/* ═══════════════════════════ EXTERNAL CALLS ═══════════════════════════ */

async function fetchProxyCurl(linkedinUrl) {
  const params = new URLSearchParams({
    url: linkedinUrl,
    use_cache: 'if-recent',
    skills: 'include',
    inferred_salary: 'exclude',
    personal_email: 'exclude',
    personal_contact_number: 'exclude',
    twitter_profile_id: 'exclude',
    facebook_profile_id: 'exclude',
    github_profile_id: 'exclude',
    extra: 'include'
  });
  const r = await fetch(`${PROXYCURL_API}?${params}`, {
    headers: { 'Authorization': `Bearer ${process.env.PROXYCURL_API_KEY}` }
  });
  if (!r.ok) throw new Error(`ProxyCurl ${r.status}`);
  return r.json();
}

async function fetchSerpFootprint(normalisedUrl) {
  // Extract handle from linkedin.com/in/<handle>
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
  const headline = (profile.headline || '').slice(0, 400);
  const summary  = (profile.summary  || '').slice(0, 2000);

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

/* ═══════════════════════════ SCORING ═══════════════════════════ */

function scoreFootprint(profile, serp) {
  let pts = 0;
  if (profile.profile_pic_url) pts += 0.5;
  if (profile.background_cover_image_url) pts += 0.5;
  if (profile.summary && profile.summary.length > 200) pts += 0.5;

  const results = serp?.organic_results || [];
  if (results.length >= 8) pts += 1.5;
  else if (results.length >= 4) pts += 1;
  else if (results.length >= 1) pts += 0.5;

  if (results.some(r => /forbes|bloomberg|wsj|techcrunch|reuters|tedx|news|press/i.test(r.link || ''))) {
    pts += 0.5;
  }
  return clamp03(Math.round(pts));
}

function scoreAuthority(profile) {
  let pts = 0;
  const recsCount    = (profile.recommendations || []).length;
  const honorsCount  = (profile.accomplishment_honors_awards || profile.honors_and_awards || []).length;
  const orgsCount    = (profile.accomplishment_organisations || []).length;
  const articlesCount = (profile.articles || []).length;

  if (recsCount >= 5)      pts += 1;
  else if (recsCount >= 2) pts += 0.5;

  if (articlesCount >= 3)  pts += 1;
  else if (articlesCount >= 1) pts += 0.5;

  if (honorsCount >= 1) pts += 0.5;
  if (orgsCount >= 1)   pts += 0.25;

  const text = ((profile.headline || '') + ' ' + (profile.summary || '')).toLowerCase();
  if (/featured|forbes|bloomberg|wsj|techcrunch|tedx|keynote|speaker|awarded|recognised|recognized/i.test(text)) {
    pts += 0.75;
  }
  return clamp03(Math.round(pts));
}

function scoreCadence(profile) {
  const activities = profile.activities || [];
  if (activities.length >= 11) return 3;
  if (activities.length >= 4)  return 2;
  if (activities.length >= 1)  return 1;
  return 0;
}

function scoreVisual(profile, clarity) {
  let pts = 0;
  if (profile.profile_pic_url) pts += 1;
  if (profile.background_cover_image_url) pts += 1;
  if (profile.summary && profile.summary.length > 300) pts += 0.75;
  if (clarity?.score >= 2) pts += 0.25;
  return clamp03(Math.round(pts));
}

function scoreNetwork(profile) {
  const followers   = profile.follower_count || 0;
  const connections = profile.connections    || 0;
  const recsCount   = (profile.recommendations || []).length;

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
