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

    // 2) Compute heuristic sub-scores FIRST so Claude can write commentary using real numbers.
    //    Visual is provisional (depends on clarity); we recompute after Claude returns.
    const heuristic = {
      footprint: scoreFootprint(profile, serp),
      authority: scoreAuthority(profile),
      cadence:   scoreCadence(profile),
      visual:    scoreVisual(profile, { score: 1 }),
      network:   scoreNetwork(profile)
    };

    // 3) Run Claude analysis with profile + heuristic scores. Returns clarity + rich content payload.
    const analysis = await analyzeProfile(profile, heuristic).catch(err => {
      console.error('Claude analysis failed:', err);
      return {
        clarityScore: 1, clarityRationale: 'Fallback heuristic — LLM unavailable.',
        executiveSummary: '', dimensionCommentary: {}, moves: [], tierRoadmap: []
      };
    });
    const clarity = { score: analysis.clarityScore, rationale: analysis.clarityRationale };

    // 4) Final sub-scores — re-compute visual with the real clarity now
    const subs = {
      footprint: heuristic.footprint,
      clarity:   clarity.score,
      authority: heuristic.authority,
      cadence:   heuristic.cadence,
      visual:    scoreVisual(profile, clarity),
      network:   heuristic.network
    };

    const total = Object.values(subs).reduce((a, b) => a + b, 0);
    const tier  = tierFor(total);
    const nextTier = TIERS.find(t => t.min > tier.max) || tier;

    return res.status(200).json({
      total, subs, tier, nextTier,
      normalisedUrl: normalised,
      // Personalization payload — feeds the on-page reveal and the PDF report
      profile: {
        firstName:        getFirstName(profile),
        lastName:         getLastName(profile),
        pictureUrl:       getPhotoUrl(profile),
        headline:         getHeadline(profile),
        companyName:      getCompany(profile),
        followerCount:    getFollowers(profile),
        connectionsCount: getConnections(profile),
        isCreator:        !!profile.creator,
        isVerified:       !!profile.isVerified
      },
      executiveSummary:    analysis.executiveSummary,
      dimensionCommentary: analysis.dimensionCommentary,
      moves:               analysis.moves,
      tierRoadmap:         analysis.tierRoadmap,
      // Backward-compat: keep older field names mapped from the new payload
      personalSummary:     analysis.executiveSummary,
      reportTeasers:       (analysis.moves || []).map(m => m.title),
      _meta: { clarityRationale: clarity.rationale }
    });
  } catch (err) {
    console.error('score handler error:', err);
    return res.status(500).json({ error: 'Audit failed. Please try again in a minute.' });
  }
}

/* ═══════════════════════════ EXTERNAL CALLS ═══════════════════════════ */

async function fetchApify(linkedinUrl) {
  // Apify "run-sync-get-dataset-items" runs the actor and returns the dataset rows directly.
  const url = `${APIFY_API}/${APIFY_ACTOR}/run-sync-get-dataset-items`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
    },
    // Different LinkedIn actors use different input shapes:
    //   • dev_fusion/*   → profileUrls: ["https://..."]                 (string array)
    //   • supreme_coder* → urls:        ["https://..."]                 (string array)
    //   • generic Apify  → startUrls:   [{ url: "https://..." }]        (very common pattern)
    // Sending all shapes is safe — each actor validates only its expected field.
    // Send EVERY known input shape for LinkedIn-profile actors so we don't need to
    // hardcode per-actor branching. Each actor validates only its expected field;
    // ignored fields are harmless.
    //   • dev_fusion/Linkedin-Profile-Scraper → profileUrls: ["url"]
    //   • supreme_coder/linkedin-profile-scraper → urls: [{ url: "url" }] (object form)
    //   • generic Apify scrapers → startUrls: [{ url: "url" }]
    //   • some actors → linkedInProfileUrls: ["url"]
    body: JSON.stringify({
      profileUrls:         [linkedinUrl],
      urls:                [{ url: linkedinUrl }],
      startUrls:           [{ url: linkedinUrl }],
      linkedInProfileUrls: [linkedinUrl],
      linkedinProfileUrl:  linkedinUrl
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
  // Some actors wrap their output (`{ data: {...} }`). Unwrap defensively.
  const raw = items[0].data || items[0];

  // Diagnostic: log the top-level keys + a sample of values so we can see actor shape in Vercel logs
  console.log('[Apify] actor:', APIFY_ACTOR, 'item keys:', Object.keys(raw || {}).slice(0, 30));

  // If the actor returned an error item (common when rate-limited or LinkedIn blocked), surface it
  if (raw && (raw.error || raw.errorMessage || raw.errorType)) {
    throw new Error(`Apify actor error: ${raw.error || raw.errorMessage || raw.errorType}`);
  }

  // Detect a truly empty payload — no identity fields at all = something went wrong upstream.
  // The user reported a real profile (yentlspiteri) coming back with 0 followers/connections/headline,
  // which is what happens when LinkedIn rate-limits the actor and it returns a stub instead of throwing.
  const hasIdentity =
    raw && (
      raw.firstName || raw.first_name || raw.firstname ||
      raw.fullName  || raw.full_name  || raw.name      ||
      raw.headline  || raw.headlineText || raw.title
    );
  if (!hasIdentity) {
    throw new Error('Apify returned an empty profile — actor likely rate-limited or LinkedIn blocked the request. Try again in 60 seconds.');
  }

  return raw;
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

async function analyzeProfile(profile, heuristic) {
  const firstName    = getFirstName(profile) || 'there';
  const headline     = (getHeadline(profile) || '').slice(0, 400);
  const about        = (getAbout(profile)    || '').slice(0, 2000);
  const followers    = getFollowers(profile);
  const connections  = getConnections(profile);
  const companyName  = profile.companyName || profile.currentCompany?.name || '';
  const isCreator    = !!profile.creator;
  const isVerified   = !!profile.isVerified;

  const prompt = `You are a brand strategist running a personalised visibility audit for an executive based on their LinkedIn profile. The audit scores six dimensions on 0-3 each, summed to 0-18.

PROFILE DATA:
- First name: ${firstName}
- Headline: "${headline}"
- About: "${about}"
- Followers: ${followers.toLocaleString()}
- Connections: ${connections.toLocaleString()}
- Company: ${companyName}
- LinkedIn Creator profile: ${isCreator ? 'yes' : 'no'}
- LinkedIn verified: ${isVerified ? 'yes' : 'no'}

PROVISIONAL SCORES (already computed from public signals — you fill in Brand Clarity):
- Digital Footprint: ${heuristic.footprint}/3
- Brand Clarity: TBD — you score this
- Authority Signals: ${heuristic.authority}/3
- Content Cadence: ${heuristic.cadence}/3
- Visual Identity: ${heuristic.visual}/3
- Network Recognition: ${heuristic.network}/3

YOUR JOB — return JSON with EVERY field below. No markdown fences, no prose around it:

{
  "clarityScore": 0|1|2|3,
  "clarityRationale": "<one sentence>",
  "executiveSummary": "<3 sentences. Address ${firstName} by name. Quote specific profile content (the actual headline, an excerpt of the About, the follower:connection ratio). Sound like a confident strategist talking to a peer. Tie observations to the score. No fluff. No 'great work!' affirmations.>",
  "dimensionCommentary": {
    "footprint":  "<one sentence on what their footprint score (${heuristic.footprint}/3) means specifically for THIS profile>",
    "clarity":    "<one sentence on the brand-clarity gap or strength based on their actual headline + About>",
    "authority":  "<one sentence referencing their actual recommendations / press / featured items (or absence thereof)>",
    "cadence":    "<one sentence on their actual posting cadence (${heuristic.cadence}/3)>",
    "visual":     "<one sentence on their actual photo / banner / visual polish>",
    "network":    "<one sentence on their actual follower count / connection count and what it signals>"
  },
  "moves": [
    {"title":"<imperative, 4-7 words>","why":"<ONE sentence, max 18 words. Specific to THIS executive — quote actual profile content where possible.>","firstStep":"<ONE short sentence, max 14 words. Concrete.>","service":"<one of: strategy|content|video|photo|linkedin|speaker|pr>"},
    {"title":"...","why":"...","firstStep":"...","service":"..."},
    {"title":"...","why":"...","firstStep":"...","service":"..."}
  ],
  "tierRoadmap": [
    "<tactic to reach the next tier — punchy, ~10-14 words>",
    "<another>","<another>","<another>","<one more>"
  ]
}

VOICE NOTES — match the FutureMakers brand:
- Confident, aspirational, action-oriented.
- Echo the brand: "done playing small", "ideas that deserve the spotlight".
- Specific over generic. Quote profile content, don't generalise.
- No chatbot tone. No "great work!" affirmations.

SERVICES KEY (use exact lowercase tokens for the "service" field):
- strategy = Personal Brand Strategy & Discovery (1-on-1 session)
- content  = Strategic content plan + production
- video    = Video content production (ideas in motion, podcast-style interviews)
- photo    = Personal photoshoot & visual branding
- linkedin = LinkedIn & platform optimisation
- speaker  = Keynote speaking kit + public-speaking coaching
- pr       = PR advisory`;

  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  const fallback = {
    clarityScore: 1,
    clarityRationale: 'Parse fallback.',
    executiveSummary: '',
    dimensionCommentary: {},
    moves: [],
    tierRoadmap: []
  };
  if (!match) return fallback;
  try {
    const p = JSON.parse(match[0]);
    return {
      clarityScore:     Math.max(0, Math.min(3, Math.round(Number(p.clarityScore) || 0))),
      clarityRationale: String(p.clarityRationale || '').slice(0, 200),
      executiveSummary: String(p.executiveSummary  || '').slice(0, 800),
      dimensionCommentary: (p.dimensionCommentary && typeof p.dimensionCommentary === 'object') ? {
        footprint: String(p.dimensionCommentary.footprint || '').slice(0, 240),
        clarity:   String(p.dimensionCommentary.clarity   || '').slice(0, 240),
        authority: String(p.dimensionCommentary.authority || '').slice(0, 240),
        cadence:   String(p.dimensionCommentary.cadence   || '').slice(0, 240),
        visual:    String(p.dimensionCommentary.visual    || '').slice(0, 240),
        network:   String(p.dimensionCommentary.network   || '').slice(0, 240)
      } : {},
      moves: Array.isArray(p.moves) ? p.moves.slice(0, 3).map(m => ({
        title:     String(m?.title     || '').slice(0, 140),
        why:       String(m?.why       || '').slice(0, 500),
        firstStep: String(m?.firstStep || '').slice(0, 280),
        service:   ['strategy','content','video','photo','linkedin','speaker','pr'].includes(m?.service) ? m.service : 'strategy'
      })) : [],
      tierRoadmap: Array.isArray(p.tierRoadmap)
        ? p.tierRoadmap.slice(0, 5).map(t => String(t).slice(0, 160))
        : []
    };
  } catch {
    return fallback;
  }
}

/* ═══════════════════════════ FIELD MAPPERS (defensive across actor shapes) ═══════════════════════════ */
// Apify actors don't all use identical field names. These helpers cover the common ones
// so the same scoring code works whether the actor returns `headline` or `headlineText`,
// `followers` or `followersCount`, etc. If the chosen actor uses something else,
// add aliases here — no need to touch the scoring functions.

function getFirstName(p) {
  // supreme_coder: firstName. Others: first_name / firstname / split fullName.
  if (p.firstName)  return String(p.firstName).trim();
  if (p.first_name) return String(p.first_name).trim();
  if (p.firstname)  return String(p.firstname).trim();
  const full = p.fullName || p.name || p.full_name || '';
  if (full) return String(full).trim().split(/\s+/)[0] || '';
  return '';
}
function getLastName(p) {
  if (p.lastName)  return String(p.lastName).trim();
  if (p.last_name) return String(p.last_name).trim();
  if (p.lastname)  return String(p.lastname).trim();
  const full = p.fullName || p.name || p.full_name || '';
  if (full) {
    const parts = String(full).trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(' ') : '';
  }
  return '';
}
function getCompany(p) {
  return p.companyName ||
         p.currentCompany?.name ||
         p.current_company?.name ||
         p.experience?.[0]?.companyName ||
         p.experiences?.[0]?.company ||
         '';
}
function getHeadline(p) {
  return p.headline || p.headlineText || p.title || '';
}
function getAbout(p) {
  return p.about || p.summary || p.description || p.aboutMe || p.bio || '';
}
function getPhotoUrl(p) {
  // supreme_coder: pictureUrl. dev_fusion: profilePic / profilePicUrl. Generic: profilePicture.
  return p.pictureUrl || p.profilePic || p.profilePicture || p.profilePicUrl ||
         p.profilePicHighQuality || p.profile_pic_url || null;
}
function getBannerUrl(p) {
  // supreme_coder: coverImageUrl. dev_fusion: bannerImage / backgroundCoverImage.
  return p.coverImageUrl || p.coverPic || p.coverPicture || p.bannerImage ||
         p.backgroundCoverImage || p.background_cover_image_url || null;
}
function getFollowers(p) {
  // supreme_coder uses singular `followerCount`. Others use `followersCount` / `followers`.
  const v = p.followerCount ?? p.followers ?? p.followersCount ?? p.follower_count ?? 0;
  return Number(v) || 0;
}
function getConnections(p) {
  const c = p.connectionsCount ?? p.connections ?? p.connection_count ?? 0;
  if (typeof c === 'string') {
    const m = c.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  return Number(c) || 0;
}
function getRecommendations(p) {
  return p.recommendations || p.recommendationsList ||
         p.received_recommendations || p.recommendationsReceived || [];
}
function getActivities(p) {
  // supreme_coder doesn't include posts in the basic profile — would need a separate posts-scraper actor.
  return p.activities || p.posts || p.recentActivities ||
         p.recent_posts || p.updates || [];
}
function getArticles(p) {
  return p.articles || p.publications || [];
}
function getHonors(p) {
  return p.honors || p.honorsAndAwards || p.awards ||
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
