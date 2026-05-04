/**
 * /api/score - POST { url } → { total, subs, tier, normalisedUrl }
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

import { notifyOps } from '../lib/notify.js';
import { logAuditCompleted } from '../lib/notion-audit.js';

const APIFY_API     = 'https://api.apify.com/v2/acts';
// LinkedIn profile actor. dev_fusion is reliable but lean - if you want
// richer data (recommendations text, named comments on posts, full work
// history with dates), swap to one of these via the APIFY_LINKEDIN_ACTOR
// env var:
//   - apimaestro~linkedin-profile-detail   (most comprehensive, ~$0.02/profile)
//   - harvestapi~linkedin-profile-scraper  (rich, slightly cheaper)
//   - apify~linkedin-profile-scraper       (official, most reliable, priciest)
// Field mappers below are actor-agnostic - any swap is plug-and-play.
const APIFY_ACTOR           = process.env.APIFY_LINKEDIN_ACTOR  || 'dev_fusion~Linkedin-Profile-Scraper';
// Post-scraper for LinkedIn posts (the profile actor doesn't return them).
const APIFY_POSTS_ACTOR     = process.env.APIFY_POSTS_ACTOR     || 'apimaestro~linkedin-profile-posts';
// Per-platform metrics scrapers. Configurable so you can swap providers without
// code changes. Defaults work with most Apify accounts that have credit.
const APIFY_INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-profile-scraper';
const APIFY_TWITTER_ACTOR   = process.env.APIFY_TWITTER_ACTOR   || 'apidojo~twitter-scraper-lite';
const SERPAPI_API   = 'https://serpapi.com/search.json';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const RATE_LIMIT = new Map();
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '5', 10);
const HOUR_MS = 3_600_000;

const TIERS = [
  { min:0,  max:5,  name:'The Hidden Gem',
    tagline:'Real expertise. The world doesn’t know it yet.',
    blurb:'Nearly invisible - but everything is ahead of you.',
    cta:"See the roadmap" },
  { min:6,  max:10, name:'The Rising Voice',
    tagline:"You're currently building momentum, but a few gaps are holding you back.",
    blurb:'You have something to say. Your brand isn’t amplifying it yet.',
    cta:"See what to build first" },
  { min:11, max:15, name:'The Emerging Authority',
    tagline:'Solid foundations. Time to scale.',
    blurb:'Doing more right than most. Now: consistency.',
    cta:"See the gaps to close" },
  { min:16, max:18, name:'The Recognised Leader',
    tagline:'Strong brand. Make it legacy-level.',
    blurb:'Real authority built. Next: sharpen the signature.',
    cta:"See how to sharpen" }
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
    // Build a fully-qualified LinkedIn URL with trailing slash - some Apify actors
    // (e.g. supreme_coder) reject URLs without it as "not valid".
    const fullUrl = `https://www.${normalised}/`;

    // 1) Fetch the LinkedIn profile FIRST so we can use the real name + company
    //    in the press search. The handle alone produces noisy/wrong results.
    //    +1-2s of latency in exchange for dramatically more relevant Tier-1 detection.
    const profileRes = await fetchApify(fullUrl).then(
      v => ({ status: 'fulfilled', value: v }),
      e => ({ status: 'rejected',  reason: e })
    );

    if (profileRes.status === 'rejected' || !profileRes.value) {
      const errMsg = profileRes.reason?.message || String(profileRes.reason) || 'no value';
      console.error('Apify failed:', errMsg, 'actor=', APIFY_ACTOR);

      // Categorise the failure → user-facing message + ops alert category
      let userError, alertCategory, alertSubject;
      if (/hard limit|subscribe to a paid|free user|usage limit/i.test(errMsg)) {
        userError     = 'Our profile scanner is at capacity for the day. Please try again in a few hours, or reach out at hello@vonpeach.com to get your audit by hand.';
        alertCategory = 'apify-hard-limit';
        alertSubject  = '🚨 Apify scraper hit hard limit - audit is OFFLINE for users';
      } else if (/rate.?limit|blocked|empty profile/i.test(errMsg)) {
        userError     = 'LinkedIn is rate-limiting the scraper right now. Please wait 60 seconds and try again.';
        alertCategory = 'apify-rate-limit';
        alertSubject  = '⚠️ Apify scraper rate-limited by LinkedIn';
      } else if (/401|403|unauthor/i.test(errMsg)) {
        userError     = 'Profile scraper isn’t configured. Check that APIFY_API_TOKEN is set on the deploy.';
        alertCategory = 'apify-auth';
        alertSubject  = '🚨 Apify auth failure - APIFY_API_TOKEN missing or invalid';
      } else if (/404|not.?found/i.test(errMsg)) {
        userError     = 'That LinkedIn profile doesn’t exist. Check the handle in the URL.';
        alertCategory = null; // Don't alert on user-input errors
      } else if (/private/i.test(errMsg)) {
        userError     = 'That profile is private - the audit needs a public LinkedIn URL.';
        alertCategory = null;
      } else {
        userError     = 'We couldn’t fetch that LinkedIn profile. The URL may be wrong, the profile is private, or the scraper is temporarily down.';
        alertCategory = 'apify-unknown';
        alertSubject  = '⚠️ Apify scraper failed (unknown error)';
      }

      // Fire ops alert (throttled to 1/30min per category) - only for system-level failures
      if (alertCategory) {
        notifyOps({
          category: alertCategory,
          subject:  alertSubject,
          body:     `The audit pipeline is failing for users.\n\nApify error:\n${errMsg.slice(0, 600)}\n\nUser will see: "${userError}"`,
          context:  {
            actor:     APIFY_ACTOR,
            url:       normalised,
            role:      body.role || '(none)',
            goal:      body.goal || '(none)',
            ip:        ip
          }
        }).catch(() => {}); // fire-and-forget
      }

      return res.status(502).json({
        error: userError,
        _debug: errMsg.slice(0, 400),
        _actor: APIFY_ACTOR
      });
    }
    const profile = profileRes.value;

    // Press search: TWO parallel SerpAPI calls.
    //   1. All-time: catches established mentions (Forbes piece from 2 years ago etc.)
    //   2. Last 3 months: surfaces fresh mentions, podcast appearances, recent posts
    // Merging both gives the user a complete picture with `recent: true` flagged on fresh hits.
    const queryArgs = {
      firstName:   getFirstName(profile),
      lastName:    getLastName(profile),
      companyName: getCompany(profile)
    };
    // Parallel scans: all-time press, recent press, personal domain probe,
    // multi-platform presence, AND a separate Apify call for the user's posts
    // (the profile scraper doesn't return them). All run concurrently so we
    // pay no extra latency vs the previous flow.
    const [serpAllRes, serpRecentRes, personalSiteRes, presenceRes, postsRes] = await Promise.allSettled([
      fetchSerpFootprint(normalised, queryArgs, false),
      fetchSerpFootprint(normalised, queryArgs, true),
      checkPersonalDomain(queryArgs.firstName, queryArgs.lastName),
      fetchPlatformPresence(queryArgs.firstName, queryArgs.lastName, queryArgs.companyName),
      fetchApifyPosts(normalised)
    ]);
    const serpAll    = serpAllRes.status    === 'fulfilled' ? serpAllRes.value    : null;
    const serpRecent = serpRecentRes.status === 'fulfilled' ? serpRecentRes.value : null;
    const personalSite = personalSiteRes.status === 'fulfilled' ? personalSiteRes.value : null;
    const presence     = presenceRes.status   === 'fulfilled' ? presenceRes.value   : {};
    const rawPosts     = postsRes.status      === 'fulfilled' ? postsRes.value      : [];
    const postsData    = analyzePostsData(rawPosts);     // null if empty
    const serp = serpAll;     // alias for older usage in scoreFootprint
    const press = mergePressResults(serpAll, serpRecent);
    // Google name-position scoring - uses the serpAll we already have, no extra API call.
    const googleRanking = scoreGoogleNamePosition(queryArgs.firstName, queryArgs.lastName, serpAll);
    // Career stage from the experience array - feeds Claude for tenure-aware moves
    const careerStage = analyzeCareerStage(profile);

    // ─── Stage 2 enrichment - depends on stage 1 results ────────────────
    // Now that the SerpAPI presence map has resolved, fire the deeper enrichment
    // calls that need handles or image URLs:
    //   1. Vision analysis on profile photo + banner (Claude vision)
    //   2. Instagram metrics (if SerpAPI returned an IG hit, parse handle, scrape)
    //   3. X metrics (same pattern)
    // All three run in parallel - failure in one doesn't block the others.
    const igHandle = extractHandle(presence.instagram?.hits?.[0]?.url, 'instagram.com');
    const xHandle  = extractHandle(presence.x?.hits?.[0]?.url, 'x.com');
    const [visionRes, igRes, xRes] = await Promise.allSettled([
      analyzeVisualIdentity(profile),
      igHandle ? fetchInstagramData(igHandle) : Promise.resolve(null),
      xHandle  ? fetchXData(xHandle)         : Promise.resolve(null)
    ]);
    const visionAnalysis = visionRes.status === 'fulfilled' ? visionRes.value : null;
    const igData         = igRes.status     === 'fulfilled' ? igRes.value     : null;
    const xData          = xRes.status      === 'fulfilled' ? xRes.value      : null;

    // Merge Instagram/X enriched data INTO the presence map - the page + PDF
    // can now show "Instagram: 4.2k followers" instead of just "Detected".
    if (igData && presence.instagram) {
      presence.instagram.metrics = igData;
    }
    if (xData && presence.x) {
      presence.x.metrics = xData;
    }

    // 2) Compute heuristic sub-scores FIRST so Claude can write commentary using real numbers.
    //    Visual is provisional (depends on clarity); we recompute after Claude returns.
    //    Footprint, authority, network now also factor in cross-platform presence.
    const heuristic = {
      footprint: scoreFootprint(profile, serp, presence, googleRanking, personalSite),
      authority: scoreAuthority(profile, press, presence),
      cadence:   scoreCadence(profile, postsData),
      visual:    scoreVisual(profile, { score: 1 }, visionAnalysis),  // vision overrides when present
      network:   scoreNetwork(profile, presence)
    };

    // Provisional tier - sum the heuristic scores to give Claude a tier hint for
    // tier-aware move templates (Hidden Gem moves should look very different from
    // Recognised Leader moves).
    const provisionalTotal = (heuristic.footprint || 0) + (heuristic.authority || 0)
                           + (heuristic.cadence   || 0) + (heuristic.visual    || 0)
                           + (heuristic.network   || 0) + 1;     // +1 for placeholder clarity
    const provisionalTier  = tierFor(provisionalTotal);

    // 3) Run Claude analysis with profile + heuristic + rich context.
    //    Context unlocks goal-aware, role-aware, tier-aware move generation.
    const analysisCtx = {
      role:           body.role  || '',
      goal:           body.goal  || '',
      tier:           provisionalTier,
      platforms:      presence,         // includes .metrics on instagram/x when enriched
      press:          press,
      personalSite:   personalSite,
      googleRanking:  googleRanking,
      careerStage:    careerStage,
      postsData:      postsData,
      visionAnalysis: visionAnalysis    // null OR { photo: {score, notes}, banner: {score, notes} }
    };
    const analysis = await analyzeProfile(profile, heuristic, analysisCtx).catch(err => {
      console.error('Claude analysis failed:', err);
      return {
        clarityScore: 1, clarityRationale: 'Fallback heuristic - LLM unavailable.',
        executiveSummary: '', dimensionCommentary: {}, moves: [], tierRoadmap: []
      };
    });
    const clarity = { score: analysis.clarityScore, rationale: analysis.clarityRationale };

    // 4) Final sub-scores - re-compute visual with the real clarity now
    const subs = {
      footprint: heuristic.footprint,
      clarity:   clarity.score,
      authority: heuristic.authority,
      cadence:   heuristic.cadence,
      visual:    scoreVisual(profile, clarity, visionAnalysis),
      network:   heuristic.network
    };

    const total = Object.values(subs).reduce((a, b) => a + b, 0);
    const tier  = tierFor(total);
    const nextTier = TIERS.find(t => t.min > tier.max) || tier;

    // Persist the audit row to Notion. Fire-and-forget - never blocks the
    // response, never throws. If NOTION_AUDITS_DATABASE_ID isn't set, it no-ops.
    // Status starts at "audit_completed"; /api/lead and the Calendly webhook
    // upsert the row to "email_submitted" / "walkthrough_booked" later.
    logAuditCompleted({
      linkedinUrl: normalised ? `https://www.${normalised}/` : null,
      firstName:   getFirstName(profile),
      lastName:    getLastName(profile),
      headline:    getHeadline(profile),
      company:     getCompany(profile),
      score:       Math.round((total / 18) * 100),    // 0-100 display
      composite:   total,                              // 0-18 raw
      tier:        tier?.name || '',
      role:        body.role || '',
      goal:        body.goal || '',
      utmSource:   body.attribution?.utm_source   || '',
      utmCampaign: body.attribution?.utm_campaign || '',
      clickId:     body.attribution?.fbclid || body.attribution?.gclid || ''
    }).catch(() => {});

    return res.status(200).json({
      total, subs, tier, nextTier,
      normalisedUrl: normalised,
      // Personalization payload - feeds the on-page reveal and the PDF report
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
      contentIdeas:        analysis.contentIdeas || [],     // legacy
      writingIdeas:        analysis.writingIdeas || [],     // 3 writing prompts
      videoIdeas:          analysis.videoIdeas   || [],     // 3 video prompts
      pressTargets:        analysis.pressTargets || [],
      personalSite:        personalSite,                // { url, found } or null
      // Tier-1 press hits - surfaced for both the landing page and the PDF
      press:               press,
      // Multi-platform presence map: { instagram: {hits, label, metrics?, ...}, x: {...}, ... }
      // Now includes .metrics on instagram/x when the deep scrapers returned data.
      platforms:           presence,
      // Where the user lands in vanilla Google search for their own name
      googleRanking:       googleRanking,
      // Top-performing recent post (text + likes + comments + url) for the
      // "Your best post" finding card on the results page.
      topPost: postsData && postsData.topPostText ? {
        text:     postsData.topPostText,
        likes:    postsData.topPostLikes,
        comments: postsData.topPostComments,
        url:      postsData.topPostUrl
      } : null,
      // Claude vision read on profile photo + banner (null if vision skipped)
      visionAnalysis:      visionAnalysis,
      // Backward-compat: keep older field names mapped from the new payload
      personalSummary:     analysis.executiveSummary,
      reportTeasers:       (analysis.moves || []).map(m => m.title),
      _meta: { clarityRationale: clarity.rationale }
    });
  } catch (err) {
    console.error('score handler error:', err);
    notifyOps({
      category: 'score-handler-crash',
      subject:  '🚨 Visibility Index: /api/score crashed unexpectedly',
      body:     `Uncaught error in the score handler.\n\n${err?.stack || err?.message || String(err)}`,
      context:  { url: normalised, ip, actor: APIFY_ACTOR }
    }).catch(() => {});
    return res.status(500).json({ error: 'Audit failed. Please try again in a minute.' });
  }
}

/* ═══════════════════════════ EXTERNAL CALLS ═══════════════════════════ */

/* ─────────── VISUAL IDENTITY ANALYSIS (Claude vision) ───────────
   Sends the user's profile photo + banner URLs to Claude with a vision prompt.
   Returns structured judgments on lighting, framing, dating signals, banner
   coherence, and brand fit. This is the unlock that makes the Visual Identity
   dimension meaningfully scored - without it we only know presence/absence. */
async function analyzeVisualIdentity(profile) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const photoUrl  = getPhotoUrl(profile);
  const bannerUrl = getBannerUrl(profile);
  if (!photoUrl && !bannerUrl) return null;

  // Build the multimodal content array - one image block per available URL,
  // followed by the analysis prompt.
  const content = [];
  if (photoUrl) {
    content.push({ type: 'image', source: { type: 'url', url: photoUrl } });
  }
  if (bannerUrl) {
    content.push({ type: 'image', source: { type: 'url', url: bannerUrl } });
  }
  const imageMap = photoUrl && bannerUrl
    ? "Image 1 is the profile photo; Image 2 is the banner."
    : photoUrl ? "The image is the profile photo." : "The image is the banner.";
  content.push({
    type: 'text',
    text: `You're judging an executive's LinkedIn visual identity for a personal-brand audit. ${imageMap}

For each image you can see, return JSON:
{
  "photo": ${photoUrl ? '{ "score": 0|1|2|3, "notes": "<max 30 words. Specific: lighting quality, framing, dating signals (era of style/clothing/glasses), professional vs casual, distractions in background, eye contact and direction>" }' : 'null'},
  "banner": ${bannerUrl ? '{ "score": 0|1|2|3, "notes": "<max 30 words. Specific: template vs custom, narrative coherence with personal brand, visual hierarchy, brand fit, what it communicates about the person>" }' : 'null'}
}

Scoring rubric (be honest, most score 0-2):
- Photo: 0 = missing/unprofessional/very dated; 1 = basic/iPhone-era flat; 2 = solid professional with reasonable craft; 3 = considered, recent, intentional, well-lit, framed for narrative
- Banner: 0 = LinkedIn default or absent; 1 = stock template / generic gradient; 2 = custom but generic message; 3 = bespoke design that reinforces a clear personal-brand narrative

Return JSON ONLY. No prose, no markdown fences. Be direct - skip "great photo!" praise.`
  });

  try {
    // Vision occasionally takes longer than text - cap at 15s. Anthropic has
    // to fetch the image URL (LinkedIn CDN) then run the model. If that hangs
    // we'd rather skip than fail the audit.
    const r = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content }]
      })
    }, 15000);
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('[vision] non-OK', r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);
    return {
      photo: p.photo ? {
        score: Math.max(0, Math.min(3, Math.round(Number(p.photo.score) || 0))),
        notes: String(p.photo.notes || '').slice(0, 240)
      } : null,
      banner: p.banner ? {
        score: Math.max(0, Math.min(3, Math.round(Number(p.banner.score) || 0))),
        notes: String(p.banner.notes || '').slice(0, 240)
      } : null
    };
  } catch (err) {
    console.warn('[vision] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// Helper: extract a platform handle from a result URL like instagram.com/username/
function extractHandle(url, domain) {
  if (!url) return null;
  const re = new RegExp(`(?:${domain.replace('.', '\\.')})/([^/?#]+)`, 'i');
  const m = url.match(re);
  if (!m) return null;
  const handle = m[1].trim();
  if (!handle || handle.length < 2 || handle.length > 30) return null;
  // Common false-positive paths that aren't usernames
  const blocklist = ['p', 'reel', 'reels', 'stories', 'tv', 'tagged', 'hashtag', 'explore', 'web', 'home', 'about', 'help', 'i', 'login', 'signup', 'directory', 'search', 'status'];
  if (blocklist.includes(handle.toLowerCase())) return null;
  return handle;
}

/* ─────────── PER-PLATFORM REAL METRICS (Apify) ───────────
   When SerpAPI's site-targeted scan returns a hit on Instagram or X, parse the
   handle from the URL and call a dedicated platform scraper for real metrics:
   follower count, post count, recent posts, bio. Far richer than "we detected
   an Instagram exists." Both are conditional - if no handle found, skip. */
// Wraps a fetch call with an AbortController-based timeout. Critical for the
// per-platform Apify enrichment calls below: those scrapers can take 20-40
// seconds when the platform is slow, which would push the audit past Vercel's
// 60s function budget. We cap each at 10s and bail to null on timeout.
async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInstagramData(handle) {
  if (!process.env.APIFY_API_TOKEN || !handle) return null;
  const url = `${APIFY_API}/${APIFY_INSTAGRAM_ACTOR}/run-sync-get-dataset-items`;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
      },
      body: JSON.stringify({
        usernames:    [handle],
        username:     [handle],
        directUrls:   [`https://www.instagram.com/${handle}/`],
        resultsLimit: 6,
        resultsType:  'details'
      })
    }, 10000);
    if (!r.ok) return null;
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return null;
    const d = items[0].data || items[0];
    return {
      handle:         d.username || d.handle || handle,
      followersCount: Number(d.followersCount ?? d.followers ?? 0) || null,
      followingCount: Number(d.followsCount   ?? d.following ?? 0) || null,
      postsCount:     Number(d.postsCount     ?? d.posts_count ?? 0) || null,
      bio:            String(d.biography      || d.bio || '').slice(0, 280),
      isVerified:     !!(d.verified || d.isVerified),
      profileUrl:     d.url || `https://www.instagram.com/${handle}/`
    };
  } catch (err) {
    // AbortError when timeout hits; otherwise some other failure - either way, null
    console.warn('[instagram] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

async function fetchXData(handle) {
  if (!process.env.APIFY_API_TOKEN || !handle) return null;
  const url = `${APIFY_API}/${APIFY_TWITTER_ACTOR}/run-sync-get-dataset-items`;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
      },
      body: JSON.stringify({
        handles:        [handle],
        twitterHandles: [handle],
        startUrls:      [{ url: `https://x.com/${handle}` }],
        maxItems:       5
      })
    }, 10000);
    if (!r.ok) return null;
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return null;
    const d = items[0].data || items[0];
    return {
      handle:    d.username  || d.userName  || handle,
      followers: Number(d.followers     ?? d.followersCount ?? 0) || null,
      following: Number(d.following     ?? d.followingCount ?? 0) || null,
      posts:     Number(d.tweetsCount   ?? d.statusesCount  ?? 0) || null,
      bio:       String(d.description || d.bio || '').slice(0, 280),
      isVerified: !!d.verified,
      profileUrl: d.url || `https://x.com/${handle}`
    };
  } catch (err) {
    console.warn('[x] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// Posts-only Apify call. Runs in parallel with the profile scrape so it adds
// no critical-path latency. Failure mode is silent (returns []) - we'd rather
// score with no post data than fail the audit.
async function fetchApifyPosts(linkedinUrl) {
  if (!process.env.APIFY_API_TOKEN || !APIFY_POSTS_ACTOR) return [];
  const url = `${APIFY_API}/${APIFY_POSTS_ACTOR}/run-sync-get-dataset-items`;
  try {
    // 12s cap - posts scraper occasionally takes its time. Beyond this we'd
    // rather skip posts data than fail the audit.
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
      },
      body: JSON.stringify({
        profileUrls:        [linkedinUrl],
        urls:               [{ url: linkedinUrl }],
        startUrls:          [{ url: linkedinUrl }],
        username:           linkedinUrl.split('/in/')[1]?.split('/')[0] || '',
        maxItems:           20,
        maxResults:         20,
        limitPerSource:     20
      })
    }, 12000);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn('[Apify posts] non-OK', r.status, text.slice(0, 200));
      return [];
    }
    const items = await r.json();
    if (!Array.isArray(items)) return [];
    return items.map(it => it.data || it).slice(0, 20);
  } catch (err) {
    console.warn('[Apify posts] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return [];
  }
}

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
    // Sending all shapes is safe - each actor validates only its expected field.
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

  // Detect a truly empty payload - no identity fields at all = something went wrong upstream.
  // The user reported a real profile (yentlspiteri) coming back with 0 followers/connections/headline,
  // which is what happens when LinkedIn rate-limits the actor and it returns a stub instead of throwing.
  const hasIdentity =
    raw && (
      raw.firstName || raw.first_name || raw.firstname ||
      raw.fullName  || raw.full_name  || raw.name      ||
      raw.headline  || raw.headlineText || raw.title
    );
  if (!hasIdentity) {
    throw new Error('Apify returned an empty profile - actor likely rate-limited or LinkedIn blocked the request. Try again in 60 seconds.');
  }

  return raw;
}

// Tier-1 press domain allowlist - each hit is a strong Authority signal.
// Order roughly reflects perceived prestige; the actual scoring counts unique outlets.
const TIER_1_PRESS = [
  'forbes.com', 'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com', 'reuters.com',
  'economist.com', 'theatlantic.com', 'newyorker.com', 'wired.com',
  'techcrunch.com', 'fastcompany.com', 'hbr.org', 'inc.com', 'fortune.com',
  'businessinsider.com', 'theguardian.com', 'cnbc.com', 'cnn.com', 'bbc.com',
  'theinformation.com', 'axios.com',
  // Tier-2: smaller-but-real press, podcasts, industry outlets. Surfaces mentions for
  // creators / founders who haven't made Forbes yet but have legit coverage.
  'sifted.eu', 'eu-startups.com', 'tech.eu', 'protocol.com', 'thenextweb.com',
  'venturebeat.com', 'theverge.com', 'arstechnica.com', 'engadget.com',
  'medium.com', 'substack.com',
  'podcasts.apple.com', 'spotify.com', 'youtube.com',
  'linkedin.com/pulse', 'linkedin.com/posts',
  'ted.com', 'tedx.com', 'tedxtalks.ted.com',
  'crunchbase.com', 'producthunt.com'
];

// Friendly outlet name from a domain (forbes.com → Forbes)
function outletNameFromDomain(domain) {
  const map = {
    'forbes.com': 'Forbes', 'bloomberg.com': 'Bloomberg', 'wsj.com': 'Wall Street Journal',
    'nytimes.com': 'New York Times', 'ft.com': 'Financial Times', 'reuters.com': 'Reuters',
    'economist.com': 'The Economist', 'theatlantic.com': 'The Atlantic',
    'newyorker.com': 'The New Yorker', 'wired.com': 'Wired',
    'techcrunch.com': 'TechCrunch', 'fastcompany.com': 'Fast Company',
    'hbr.org': 'Harvard Business Review', 'inc.com': 'Inc.', 'fortune.com': 'Fortune',
    'businessinsider.com': 'Business Insider', 'theguardian.com': 'The Guardian',
    'cnbc.com': 'CNBC', 'cnn.com': 'CNN', 'bbc.com': 'BBC',
    'theinformation.com': 'The Information', 'axios.com': 'Axios'
  };
  return map[domain] || domain.replace(/\.com$|\.org$|\.co$/, '').replace(/^./, c => c.toUpperCase());
}

// ─────────── MULTI-PLATFORM PRESENCE DETECTION ───────────
// Each platform we check is a site-targeted SerpAPI search using only the
// user's LinkedIn-supplied name + company. Detection on each platform
// becomes a citeable signal in the final report and feeds Footprint /
// Authority / Network scoring.
//
//   - social channels (Instagram, X)        → Network Recognition boost
//   - owned channels  (Substack, Medium)    → Digital Footprint boost
//   - authority sites (YouTube, Wikipedia,
//     Crunchbase)                            → Authority Signals boost
//
// Cost: ~6 SerpAPI calls per audit, run in parallel (~$0.03/audit).
const PLATFORMS = [
  { key: 'instagram',  domain: 'instagram.com',  type: 'social',    boost: 'network',    label: 'Instagram' },
  { key: 'x',          domain: 'x.com',          type: 'social',    boost: 'network',    label: 'X / Twitter' },
  { key: 'substack',   domain: 'substack.com',   type: 'owned',     boost: 'footprint',  label: 'Substack' },
  { key: 'medium',     domain: 'medium.com',     type: 'owned',     boost: 'footprint',  label: 'Medium' },
  { key: 'youtube',    domain: 'youtube.com',    type: 'authority', boost: 'authority',  label: 'YouTube' },
  { key: 'crunchbase', domain: 'crunchbase.com', type: 'authority', boost: 'authority',  label: 'Crunchbase' },
  { key: 'wikipedia',  domain: 'wikipedia.org',  type: 'authority', boost: 'authority',  label: 'Wikipedia' }
];

async function fetchPlatformPresence(firstName, lastName, companyName) {
  if (!firstName || !lastName || !process.env.SERPAPI_API_KEY) return {};
  const fullName = `"${firstName} ${lastName}"`;
  const company = companyName ? ` ${companyName}` : '';

  // Site-targeted searches for each platform on the PLATFORMS list
  const platformCalls = PLATFORMS.map(p => {
    const params = new URLSearchParams({
      engine: 'google',
      q: `${fullName}${company} site:${p.domain}`,
      num: '5',
      api_key: process.env.SERPAPI_API_KEY
    });
    return fetch(`${SERPAPI_API}?${params}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  });

  // Google News engine - dedicated news-index search, catches mentions across
  // every news source Google indexes (Reuters, AP, BBC, NYT, Bloomberg, FT, plus
  // local/regional outlets the standard tier-1 allowlist would miss).
  const newsCall = fetch(`${SERPAPI_API}?` + new URLSearchParams({
    engine: 'google_news',
    q: `${fullName}${company}`,
    api_key: process.env.SERPAPI_API_KEY
  })).then(r => r.ok ? r.json() : null).catch(() => null);

  const [platformResults, newsResult] = await Promise.all([
    Promise.allSettled(platformCalls),
    newsCall
  ]);

  const presence = {};
  PLATFORMS.forEach((p, i) => {
    const r = platformResults[i];
    if (r.status !== 'fulfilled' || !r.value) return;
    const hits = (r.value.organic_results || [])
      .filter(h => h.link && h.link.toLowerCase().includes(p.domain))
      .slice(0, 2)
      .map(h => ({ url: h.link, title: (h.title || '').slice(0, 120) }));
    if (hits.length) {
      presence[p.key] = {
        domain: p.domain,
        type:   p.type,
        boost:  p.boost,
        label:  p.label,
        hits
      };
    }
  });

  // Google News results - aggregate across news sources, surface the top 3
  if (newsResult?.news_results?.length) {
    const newsHits = newsResult.news_results
      .filter(n => n.link)
      .slice(0, 3)
      .map(n => ({
        url:    n.link,
        title:  (n.title || '').slice(0, 140),
        source: (n.source?.name || n.source || '').toString().slice(0, 80),
        date:   n.date || null
      }));
    if (newsHits.length) {
      presence.googleNews = {
        domain: 'news.google.com',
        type:   'authority',
        boost:  'authority',
        label:  'Google News',
        hits:   newsHits
      };
    }
  }

  return presence;
}

// Score where the user's name lands in vanilla Google search results.
// Uses the all-time serp we already pulled - no extra API call.
//   - topPosition: rank (1-10) of the FIRST result mentioning the user's name
//   - ownedTop10:  count of top-10 results that appear to be about the user
function scoreGoogleNamePosition(firstName, lastName, serp) {
  const orgResults = serp?.organic_results || [];
  const fullName = `${firstName || ''} ${lastName || ''}`.toLowerCase().trim();
  if (!fullName || !orgResults.length) return { topPosition: null, ownedTop10: 0 };
  let topPosition = null;
  let ownedTop10  = 0;
  orgResults.slice(0, 10).forEach((r, idx) => {
    const haystack = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    if (haystack.includes(fullName)) {
      if (topPosition === null) topPosition = idx + 1;
      ownedTop10++;
    }
  });
  return { topPosition, ownedTop10 };
}

// Personal-domain detection — tries common firstname/lastname URL patterns with a fast HEAD request.
// Returns { url, found } if any resolve, null on miss/timeout. Fire-and-forget; never blocks the audit.
async function checkPersonalDomain(firstName, lastName) {
  if (!firstName || !lastName) return null;
  const f = String(firstName).toLowerCase().replace(/[^a-z]/g, '');
  const l = String(lastName).toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l || f.length < 2 || l.length < 2) return null;
  // Patterns ordered by likelihood. firstnamelastname.com is the most common executive personal site.
  // Expanded TLD set: .me / .io / .co are increasingly common for personal sites.
  const candidates = [
    `https://${f}${l}.com`,
    `https://${f}-${l}.com`,
    `https://${f}.${l}.com`,
    `https://www.${f}${l}.com`,
    `https://${f}${l}.me`,
    `https://${f}${l}.io`,
    `https://${f}${l}.co`,
    `https://${f}-${l}.me`,
    `https://${f}-${l}.io`,
    `https://${l}.com`     // surname-only domains (less common but happens for senior execs)
  ];
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      // HEAD request, follow redirects. Some sites refuse HEAD - GET as fallback would be slower.
      const r = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisibilityIndex/1.0)' }
      }).catch(() => null);
      clearTimeout(timer);
      if (r && r.ok) {
        return { url, found: true };
      }
    } catch (_) { /* ignore single-URL failures, try the next */ }
  }
  return null;
}

// Merge two SerpAPI responses (all-time + last-90-days) into one combined press object.
// Hits from the recent search are flagged `recent: true` and surfaced first.
function mergePressResults(serpAll, serpRecent) {
  const allHits    = serpAll    ? extractTier1Press(serpAll).hits    : [];
  const recentHits = serpRecent ? extractTier1Press(serpRecent).hits : [];
  // Mark recent hits + dedupe by link
  const seen = new Set();
  const merged = [];
  recentHits.forEach(h => {
    if (h.link && !seen.has(h.link)) { seen.add(h.link); merged.push({ ...h, recent: true }); }
  });
  allHits.forEach(h => {
    if (h.link && !seen.has(h.link)) { seen.add(h.link); merged.push({ ...h, recent: false }); }
  });
  const finalHits = merged.slice(0, 6);
  return {
    count:       finalHits.length,
    recentCount: finalHits.filter(h => h.recent).length,
    outlets:     finalHits.map(h => h.outlet),
    hits:        finalHits
  };
}

// Extract Tier-1 press hits from raw SerpAPI organic_results.
// Returns: { count, outlets, hits: [{ outlet, title, link, snippet }] } - capped at 5 hits.
function extractTier1Press(serp) {
  const results = serp?.organic_results || [];
  const seen = new Set();
  const hits = [];
  for (const r of results) {
    const url = r.link || '';
    const matchedDomain = TIER_1_PRESS.find(d => url.includes(d));
    if (!matchedDomain) continue;
    if (seen.has(matchedDomain)) continue;     // one hit per outlet - quality over quantity
    seen.add(matchedDomain);
    hits.push({
      outlet:  outletNameFromDomain(matchedDomain),
      domain:  matchedDomain,
      title:   r.title || '',
      link:    url,
      snippet: r.snippet || ''
    });
    if (hits.length >= 5) break;
  }
  return {
    count:   hits.length,
    outlets: hits.map(h => h.outlet),
    hits
  };
}

// SerpAPI footprint search - uses the real name + company when we have them, falls back to handle.
// Quoted name forces exact match; company disambiguates from name overlap.
// `recentOnly` = true → adds tbs=qdr:m3 to restrict to the last 3 months.
async function fetchSerpFootprint(normalisedUrl, profileForQuery, recentOnly = false) {
  let q;
  if (profileForQuery && (profileForQuery.firstName || profileForQuery.lastName)) {
    const fullName = `${profileForQuery.firstName || ''} ${profileForQuery.lastName || ''}`.trim();
    const company  = profileForQuery.companyName ? ` ${profileForQuery.companyName}` : '';
    q = `"${fullName}"${company}`;
  } else {
    const handle = normalisedUrl.split('/in/')[1]?.split('/')[0] || '';
    q = handle.replace(/-/g, ' ');
  }
  const params = new URLSearchParams({
    engine: 'google',
    q: q,
    num: '10',
    api_key: process.env.SERPAPI_API_KEY
  });
  if (recentOnly) params.append('tbs', 'qdr:m3');     // last 3 months
  const r = await fetch(`${SERPAPI_API}?${params}`);
  if (!r.ok) throw new Error(`SerpAPI ${r.status}`);
  return r.json();
}

// Role-specific framing - what each archetype actually cares about.
// Used to bias move generation toward the audience that matters for THIS user.
const ROLE_FRAMING = {
  ceo:        { audience: 'shareholders, journalists, customer execs', priority: 'credibility + thought leadership',                    tone: 'measured, sharp, considered' },
  founder:    { audience: 'investors, customer founders, journalists', priority: 'authority signals + clarity on what you build',       tone: 'opinionated, direct, generous with insight' },
  investor:   { audience: 'founders, LPs, fellow investors',           priority: 'thesis + portfolio visibility + named takes',         tone: 'confident, contrarian, evidence-led' },
  board:      { audience: 'CEOs, governance committees, headhunters',  priority: 'governance authority + named directorships',          tone: 'institutional, measured, low-frequency' },
  consultant: { audience: 'prospect buyers, hiring committees',        priority: 'specific expertise + named outcomes',                 tone: 'specific, results-led, anti-jargon' },
  marketer:   { audience: 'CMOs, agency heads, brand teams',           priority: 'taste + craft + named campaigns',                     tone: 'voice-driven, opinionated, current' },
  creative:   { audience: 'art directors, agency partners, founders',  priority: 'taste + portfolio + cultural takes',                  tone: 'curated, aesthetic, specific' },
  artist:     { audience: 'collectors, galleries, curators',           priority: 'body of work + reasons + reviews',                    tone: 'authentic, considered, art-world appropriate' },
  creator:    { audience: 'audience members, sponsors, collaborators', priority: 'cadence + craft + community',                         tone: 'warm, consistent, audience-aware' },
  speaker:    { audience: 'conference programmers, agencies, hosts',   priority: 'talks + speaker reel + topic ownership',              tone: 'showmanship + substance, hookable' },
  senior:     { audience: 'peers, recruiters, board nomination cttees',priority: 'industry recognition + sustained POV',                tone: 'measured, precise, low-flash' }
};

// Goal-specific tactical priorities - what moves matter most for THIS goal.
const GOAL_FRAMING = {
  clients:     { priority: 'Brand Clarity + Content Cadence',                directive: 'Moves should make it OBVIOUSLY easy for an ideal client to identify themselves in your positioning, then to see proof you can deliver.' },
  speaking:    { priority: 'Authority Signals + Speaker Reel',                directive: 'Moves should focus on visible speaker credentials - past stages, named talks, a discoverable speaker reel, outbound pitching.' },
  credibility: { priority: 'Authority Signals + Network Recognition',         directive: 'Moves should focus on third-party validation - press mentions, named board roles, awards, Wikipedia eligibility, peer endorsements.' },
  legacy:      { priority: 'Brand Clarity + Authority + Sustained POV',       directive: 'Moves should focus on inheritable assets - a book, a named framework, an annual letter, a community that survives platforms.' }
};

// Tier-specific move templates - completely different prescriptions per tier.
const TIER_DIRECTIVES = {
  'The Hidden Gem':         'Moves are FOUNDATIONAL. Headline rewrite, banner upload, first weekly post commitment, claim a personal domain, take a real photo. Twenty-minute moves, not twelve-week commitments. Aim for the +6pt jump to Rising Voice in three weeks.',
  'The Rising Voice':       'Moves are HABIT-FORMING. Lock cadence (one post/week, same day, three pillars). One outbound press or podcast pitch. Rewrite headline if not already crisp. The bottleneck is sustained outbound, not foundational fixes.',
  'The Emerging Authority': 'Moves are SCALING. One tier-1 press mention per quarter (specific journalist + outlet + angle). Speaker pitch to a named conference. Sharpen the signature - one signature post format used weekly. Stop fixing basics, start owning a corner.',
  'The Recognised Leader':  'Moves are SHARPENING. Inheritable assets - a book, a named framework, an annual letter. Edit OUT diluters (decline 80% of advisory invites, drop the 4th topic pillar). Build the asset that compounds without you posting daily.'
};

async function analyzeProfile(profile, heuristic, ctx = {}) {
  const firstName    = getFirstName(profile) || 'there';
  const lastName     = getLastName(profile) || '';
  const headline     = (getHeadline(profile) || '').slice(0, 400);
  const about        = (getAbout(profile)    || '').slice(0, 2000);
  const followers    = getFollowers(profile);
  const connections  = getConnections(profile);
  const companyName  = profile.companyName || profile.currentCompany?.name || '';
  const isCreator    = !!profile.creator;
  const isVerified   = !!profile.isVerified;

  // Resolve role + goal context with sensible defaults
  const role        = ctx.role || '';
  const goal        = ctx.goal || '';
  const tierName    = ctx.tier?.name || '';
  const roleFrame   = ROLE_FRAMING[role] || null;
  const goalFrame   = GOAL_FRAMING[goal] || null;
  const tierDirective = TIER_DIRECTIVES[tierName] || '';

  // Career-stage line - tenure context for moves
  const cs = ctx.careerStage || {};
  const careerLine = (() => {
    const parts = [];
    if (cs.totalYears !== null && cs.totalYears !== undefined) parts.push(`${cs.totalYears} years total professional experience`);
    if (cs.currentRoleYears !== null && cs.currentRoleYears !== undefined) {
      const m = cs.currentRoleYears < 1 ? '<1 year' : `${cs.currentRoleYears} year${cs.currentRoleYears > 1 ? 's' : ''}`;
      parts.push(`current role: ${m}`);
    }
    if (cs.isRecentTransition) parts.push('RECENT TRANSITION (just changed roles)');
    if (cs.notablePast?.length) parts.push(`prior companies: ${cs.notablePast.slice(0, 3).join(', ')}`);
    return parts.length ? parts.join(' • ') : 'no career history available';
  })();

  // Posts data line - real cadence + topic + engagement signal
  const pd = ctx.postsData;
  const postsLine = pd
    ? `Posts in last 90 days: ${pd.recentCount}. Avg engagement (likes + 2×comments): ${pd.avgEngagement}. Top post: "${(pd.topPostText || '').slice(0, 140)}". Sample recent posts: ${(pd.samplePosts || []).slice(0, 3).map(s => `"${s.slice(0, 80)}…"`).join(' / ')}`
    : 'No post-scraper data — cadence is unobserved (treat as 0 unless proxied by creator/verified status)';

  // Cross-platform presence summary - now includes real metrics for Instagram
  // and X when the deep scrapers returned data. Claude can reference specific
  // numbers in moves ("your Instagram has 4,200 followers but only 2 posts...")
  const platforms = ctx.platforms || {};
  const detectedPlatforms = Object.entries(platforms).map(([k, p]) => {
    const firstUrl = p.hits?.[0]?.url || '';
    const firstTitle = p.hits?.[0]?.title || '';
    let line = `  - ${p.label || k}: ${firstUrl}${firstTitle ? ` ("${firstTitle.slice(0, 80)}")` : ''}`;
    // If we have real metrics, append them so Claude can use them
    if (p.metrics) {
      const m = p.metrics;
      const bits = [];
      if (m.followersCount || m.followers) bits.push(`${(m.followersCount || m.followers).toLocaleString()} followers`);
      if (m.postsCount || m.posts)         bits.push(`${(m.postsCount || m.posts).toLocaleString()} posts`);
      if (m.bio)                           bits.push(`bio: "${m.bio.slice(0, 80)}"`);
      if (bits.length) line += `\n      → REAL METRICS: ${bits.join(' · ')}`;
    }
    return line;
  }).join('\n') || '  - none detected beyond LinkedIn';

  // Vision analysis - what Claude saw when actually looking at the photo + banner
  const va = ctx.visionAnalysis;
  const visionLine = va
    ? `Vision-analysed photo: ${va.photo ? `${va.photo.score}/3 - ${va.photo.notes}` : 'not provided'}\n- Vision-analysed banner: ${va.banner ? `${va.banner.score}/3 - ${va.banner.notes}` : 'not provided'}`
    : 'Vision analysis unavailable - score Visual heuristically';

  // Press hits summary
  const press = ctx.press || {};
  const pressHits = (press.hits || []).slice(0, 3).map(h =>
    `  - ${h.outlet || 'unknown'}${h.recent ? ' (recent, last 90 days)' : ''}: "${(h.title || '').slice(0, 100)}"`
  ).join('\n') || '  - no tier-1 press detected';

  // Personal site
  const personalSiteLine = ctx.personalSite?.found
    ? `OWNS personal domain: ${ctx.personalSite.url}`
    : `does NOT own a firstname-lastname personal domain`;

  // Google ranking
  const ranking = ctx.googleRanking || {};
  const rankingLine = ranking.topPosition
    ? `Position #${ranking.topPosition} for own name; ${ranking.ownedTop10 || 0} of top-10 are about them`
    : 'Does not appear in top 10 for own name';

  const prompt = `You are a brand strategist running a personalised visibility audit for an executive based on their LinkedIn profile. The audit scores six dimensions on 0-3 each, summed to 0-18.

PROFILE DATA:
- First name: ${firstName}
- Last name: ${lastName}
- Headline: "${headline}"
- About: "${about}"
- Followers: ${followers.toLocaleString()}
- Connections: ${connections.toLocaleString()}
- Company: ${companyName}
- LinkedIn Creator profile: ${isCreator ? 'yes' : 'no'}
- LinkedIn verified: ${isVerified ? 'yes' : 'no'}

USER CONTEXT (they self-selected on the audit form):
- Role: ${role || '(not specified)'}${roleFrame ? `\n  → Their audience: ${roleFrame.audience}\n  → What matters most for this role: ${roleFrame.priority}\n  → Voice/tone fit: ${roleFrame.tone}` : ''}
- Goal: ${goal || '(not specified)'}${goalFrame ? `\n  → Tactical priority for this goal: ${goalFrame.priority}\n  → ${goalFrame.directive}` : ''}

CAREER STAGE (from LinkedIn experience):
- ${careerLine}
- Career stage band: ${cs.careerStage || 'unknown'}
- USE THIS in moves. Reference notable past companies as credibility anchors. If they recently transitioned, that's the framing hook. If they have 20+ years experience, the moves should match (no "first LinkedIn post" suggestions to a senior exec).

POSTING ACTIVITY (from dedicated post scraper):
- ${postsLine}
- If you have real samplePosts text, REFERENCE IT. Quote the topic of their highest-engagement post. If their last 5 posts cover 5 different topics, NAME the topic-scatter problem.

OBSERVED CROSS-CHANNEL EVIDENCE (use this to write SPECIFIC moves, not generic ones):
- Tier: ${tierName || 'unknown'}
- ${personalSiteLine}
- Google name search: ${rankingLine}
- ${visionLine}
- Tier-1 press hits:
${pressHits}
- Other public channels detected (with REAL metrics where shown):
${detectedPlatforms}

INDUSTRY INFERENCE TASK (do this BEFORE writing moves):
First, infer the user's industry from their company name + headline + experience. Common buckets:
  - SaaS / B2B software
  - Climate / cleantech
  - Fintech / financial services
  - Biotech / health
  - Consulting / professional services
  - E-commerce / DTC
  - Media / creator economy
  - Education / edtech
  - Manufacturing / industrial
  - Investment / VC / PE
  - Other (specify)
Then USE the industry to make moves SPECIFIC to that vertical. Examples:
  - SaaS founder → Sifted, TechCrunch, ProductHunt, SaaStr conference
  - Climate exec → Sifted (climate beat), Cipher, Nature Climate, ClimateWeekNYC
  - Fintech → Sifted (fintech), CB Insights, Money 20/20, Finovate
  - Biotech → Endpoints, BioPharma Dive, BIO International
  - Consulting → HBR, Forbes, named industry conferences for their vertical
  - Investment → The Information, Newcomer, LP-targeted publications
The journalist names + outlet names you suggest MUST be real and currently active. If unsure, use the outlet name without naming a journalist - we'd rather skip a name than invent one.

PROVISIONAL SCORES (already computed from public signals - you fill in Brand Clarity):
- Digital Footprint: ${heuristic.footprint}/3
- Brand Clarity: TBD - you score this
- Authority Signals: ${heuristic.authority}/3
- Content Cadence: ${heuristic.cadence}/3
- Visual Identity: ${heuristic.visual}/3
- Network Recognition: ${heuristic.network}/3

TIER-SPECIFIC MOVE DIRECTIVE (read carefully — moves MUST match this tier's stage):
${tierDirective || 'Pick three concrete moves that fit the user\'s evident stage.'}

YOUR JOB - return JSON with EVERY field below. No markdown fences, no prose around it:

{
  "clarityScore": 0|1|2|3,
  "clarityRationale": "<8-12 words max>",
  "executiveSummary": "<TWO sentences. Address ${firstName} by name. Sentence 1: name the biggest single gap, quoting one piece of their actual profile (their headline OR a follower stat). Sentence 2: one specific action that closes it. Max 32 words total. No 'you're doing great' fluff.>",
  "dimensionCommentary": {
    "footprint":  "<max 14 words. One specific observation tied to their score.>",
    "clarity":    "<max 14 words. Reference their actual headline.>",
    "authority":  "<max 14 words. Name one missing or present signal.>",
    "cadence":    "<max 14 words. State the rhythm or its absence.>",
    "visual":     "<max 14 words. Name one specific craft detail.>",
    "network":    "<max 14 words. Quote their follower or connection number.>"
  },
  "moves": [
    {
      "title":"<imperative, 3-6 words>",
      "why":"<ONE sentence, max 18 words. MUST reference SOMETHING specific from this user: a phrase from their headline/About in quotes, a follower count, a detected platform (e.g. their Substack at X), a press outlet they were featured in, a previous employer from their experience, or their company name. Do NOT generate generic advice that could apply to anyone.>",
      "firstStep":"<max 12 words. Concrete first action they can take TODAY.>",
      "weekOne":"<max 14 words. What done by end of week 1.>",
      "month1":"<max 14 words. What done by end of month 1.>",
      "successMetric":"<max 12 words. Observable measure that tells them this worked, e.g. 'follower count up 8-12%', 'one tier-1 reply'.>",
      "timeInvest":"<one of: '20 min', '1 hour', '2 hours', '4 hours', 'weekly hour', '1 day'>",
      "service":"<one of: strategy|content|video|photo|linkedin|speaker|pr>",
      "outreach": null
    },
    {"title":"...","why":"...","firstStep":"...","weekOne":"...","month1":"...","successMetric":"...","timeInvest":"...","service":"...","outreach":null},
    {"title":"...","why":"...","firstStep":"...","weekOne":"...","month1":"...","successMetric":"...","timeInvest":"...","service":"...","outreach":null}
  ],
  "// outreach": "For moves that involve outbound contact (press pitch, podcast pitch, board outreach, conference CFP, advisor cold-email), set outreach to an object: { type: 'press'|'podcast'|'speaker'|'board'|'advisor', recipient: '<who - role + outlet/company>', subject: '<email subject line, ≤60 chars>', body: '<2-4 sentence draft email body the user can copy-paste, addressing the specific recipient with the user's specific angle>' }. For moves that DON'T involve outreach (e.g. headline rewrite, banner upload, weekly cadence commitment), keep outreach as null.",
  "tierRoadmap": [
    "<max 10 words, punchy>",
    "<max 10 words>","<max 10 words>","<max 10 words>","<max 10 words>"
  ],
  "writingIdeas": [
    {
      "title":"<6-12 word post title — concrete, references their actual industry/role/expertise>",
      "hook":"<the literal first line of the post — the line that stops a thumb scroll. ≤22 words. Must be opinionated.>",
      "angle":"<one sentence on the take, why it lands with THEIR audience. ≤24 words. Reference one real thing about them — headline phrase, industry, follower count, prior employer, or detected platform.>",
      "format":"<one of: LinkedIn post | LinkedIn long-form | Newsletter | Twitter thread | Carousel | Substack essay>"
    },
    {"title":"...","hook":"...","angle":"...","format":"..."},
    {"title":"...","hook":"...","angle":"...","format":"..."}
  ],
  "videoIdeas": [
    {
      "title":"<6-12 word video title — concrete, references their domain expertise>",
      "hook":"<the first 5 seconds of the video — what they say or show on camera. ≤22 words. Must earn the next 30 seconds of attention.>",
      "angle":"<one sentence on what they'd actually film and why their audience would watch. ≤24 words. Reference something real about them.>",
      "format":"<one of: 60s talking head | 90s explainer | LinkedIn vertical reel | Podcast clip | Behind-the-scenes B-roll | Whiteboard explainer>",
      "shotIn":"<estimated time to film on a phone, no crew. one of: '15 min, no edit' | '30 min one-take' | '1hr light edit' | '2hr proper shoot'>"
    },
    {"title":"...","hook":"...","angle":"...","format":"...","shotIn":"..."},
    {"title":"...","hook":"...","angle":"...","format":"...","shotIn":"..."}
  ],
  "pressTargets": [
    {"outlet":"<a specific tier-1 publication that fits their niche - e.g. Forbes Leadership, TechCrunch, HBR, Sifted, etc.>","why":"<one sentence on why their story fits this outlet specifically>","pitch":"<a 10-15 word pitch angle / headline they could use>"},
    {"outlet":"...","why":"...","pitch":"..."}
  ]
}

VOICE NOTES - match the FutureMakers brand:
- Confident, aspirational, action-oriented.
- Specific over generic. Quote profile content, don't generalise.
- No chatbot tone. No "great work!" affirmations.

SPECIFICITY MANDATE for moves (very important):
- Every move's "why" MUST anchor on something observable about THIS user. Examples of good anchors:
  - A literal phrase from their headline in quotes
  - A specific follower count
  - A detected platform with its URL ("Your Substack at substack.com/...")
  - A press hit ("Your Sifted feature mentions [X], pitch a follow-up to that journalist")
  - Their company name + tenure
  - The fact they DON'T own firstname-lastname.com (or DO)
- If a move's "why" could be copy-pasted onto any other audit, REWRITE IT.
- Reference detected platforms by name. If they have a YouTube interview, the move is "clip your YouTube interview into 5 LinkedIn posts" - not "go on more podcasts".
- If they have NO press, do NOT pretend they do. If they HAVE press, build moves that compound it.

CONTENT IDEAS — same specificity rule, even harder:
- Each writingIdeas[].title and videoIdeas[].title MUST be a real post/video idea this person could actually make this week. NOT a generic topic header.
- Each "hook" MUST be the literal opening line — write it the way they'd write it. Conversational, opinionated, concrete. NEVER "In today's world…" or "5 lessons I learned about…".
- Each "angle" must reference one observable fact about the user (headline phrase, industry, prior employer, follower count, recent press, detected platform). If you can't, you don't understand them well enough yet.
- Match the format to their actual reach. Someone with 200 followers and zero posts → start with simple LinkedIn posts, not Substack essays. Someone with 5k+ followers and an active podcast guest history → push to long-form / video.
- Video ideas must be SHOOTABLE on a phone in under 2 hours. No "feature documentary" pitches. The shotIn field is a real promise to the user.
- Diversify across the 3 of each — don't give them 3 LinkedIn posts. Mix formats so they can pick the one that fits their week.
- BAD examples to NEVER write:
  ✗ "5 lessons from being a CEO"
  ✗ "My morning routine"
  ✗ "Why authenticity matters in leadership"
  ✗ "Tips for personal branding"
- GOOD examples that earn the spot:
  ✓ "The cap-table mistake that cost me Series B leverage" (for a founder)
  ✓ "Why I stopped writing 'transforming the future of work' on my LinkedIn" (referencing their actual headline)
  ✓ "What 8 years at Goldman taught me that I unlearned at [Current Co]" (referencing their actual experience)

PLAIN-ENGLISH RULES (very important):
- Write at a 6th-grade reading level. Imagine explaining it to a smart 10-year-old.
- Short sentences. One idea per sentence.
- Concrete words. Avoid: "leverage", "amplify", "thought leadership", "compounding", "narrative", "positioning", "visibility architecture", "ecosystem".
- Use: "post", "share", "say", "show", "people", "see you", "find you", "talk about".
- If you can't say it without jargon, find a simpler way.
- Examples of GOOD plain English:
   ✓ "Your headline lists your jobs but not who you help."
   ✓ "You've got 5,000 followers but no one is talking back."
   ✓ "Post once a week. Same day, same time. Pick a topic and stick with it."
- Examples of BAD jargon to avoid:
   ✗ "Architect a thought leadership cadence to amplify your narrative."
   ✗ "Leverage compound visibility through multi-channel orchestration."
   ✗ "Positioning ambiguity dilutes your personal brand equity."

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
      // Bumped from 1500 → 3500 once the move schema added weekOne / month1 /
      // successMetric / outreach.body — the original cap was truncating Claude
      // mid-JSON, leaving the moves array empty and page 4 of the PDF blank.
      max_tokens: 3500,
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
      moves: Array.isArray(p.moves) ? p.moves.slice(0, 3).map(m => {
        // Optional outreach draft - validated and clamped
        let outreach = null;
        if (m?.outreach && typeof m.outreach === 'object') {
          const validTypes = ['press','podcast','speaker','board','advisor','partner','investor'];
          const t = String(m.outreach.type || '').toLowerCase();
          outreach = {
            type:      validTypes.includes(t) ? t : 'press',
            recipient: String(m.outreach.recipient || '').slice(0, 160),
            subject:   String(m.outreach.subject   || '').slice(0, 140),
            body:      String(m.outreach.body      || '').slice(0, 1200)
          };
          // Drop the outreach object entirely if both subject and body are empty
          if (!outreach.subject && !outreach.body) outreach = null;
        }
        const validTimes = ['20 min','1 hour','2 hours','4 hours','weekly hour','1 day'];
        return {
          title:         String(m?.title         || '').slice(0, 140),
          why:           String(m?.why           || '').slice(0, 500),
          firstStep:     String(m?.firstStep     || '').slice(0, 280),
          weekOne:       String(m?.weekOne       || '').slice(0, 280),
          month1:        String(m?.month1        || '').slice(0, 280),
          successMetric: String(m?.successMetric || '').slice(0, 200),
          timeInvest:    validTimes.includes(m?.timeInvest) ? m.timeInvest : '',
          service:       ['strategy','content','video','photo','linkedin','speaker','pr'].includes(m?.service) ? m.service : 'strategy',
          outreach
        };
      }) : [],
      tierRoadmap: Array.isArray(p.tierRoadmap)
        ? p.tierRoadmap.slice(0, 5).map(t => String(t).slice(0, 160))
        : [],
      // Legacy contentIdeas — kept for backward compat with cached deploys / old PDFs.
      // New flow uses writingIdeas + videoIdeas below.
      contentIdeas: Array.isArray(p.contentIdeas)
        ? p.contentIdeas.slice(0, 3).map(c => ({
            topic:  String(c?.topic  || '').slice(0, 200),
            angle:  String(c?.angle  || '').slice(0, 300),
            format: String(c?.format || '').slice(0, 60)
          }))
        : [],
      writingIdeas: Array.isArray(p.writingIdeas)
        ? p.writingIdeas.slice(0, 3).map(c => ({
            title:  String(c?.title  || '').slice(0, 200),
            hook:   String(c?.hook   || '').slice(0, 280),
            angle:  String(c?.angle  || '').slice(0, 300),
            format: String(c?.format || '').slice(0, 60)
          }))
        : [],
      videoIdeas: Array.isArray(p.videoIdeas)
        ? p.videoIdeas.slice(0, 3).map(c => ({
            title:  String(c?.title  || '').slice(0, 200),
            hook:   String(c?.hook   || '').slice(0, 280),
            angle:  String(c?.angle  || '').slice(0, 300),
            format: String(c?.format || '').slice(0, 60),
            shotIn: String(c?.shotIn || '').slice(0, 60)
          }))
        : [],
      pressTargets: Array.isArray(p.pressTargets)
        ? p.pressTargets.slice(0, 3).map(t => ({
            outlet: String(t?.outlet || '').slice(0, 120),
            why:    String(t?.why    || '').slice(0, 280),
            pitch:  String(t?.pitch  || '').slice(0, 280)
          }))
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
// add aliases here - no need to touch the scoring functions.

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

// Normalize the experience array across actor shapes (dev_fusion vs supreme_coder vs generic).
function getExperience(p) {
  const arr = p.experience || p.experiences || p.workHistory || p.positions || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(e => {
    const company = e.companyName || e.company || e.organisationName || e.organization || '';
    const title   = e.title || e.position || e.jobTitle || e.role || '';
    // Date can come as { year, month } object, ISO string, or "Mon YYYY" string. Normalize to year integer.
    const startObj = e.startDate || e.starts_at || e.dates?.start || e.durationDates?.start;
    const endObj   = e.endDate   || e.ends_at   || e.dates?.end   || e.durationDates?.end;
    const startYear = parseDateYear(startObj);
    const endYear   = parseDateYear(endObj);
    const isCurrent = !endObj || e.isCurrent === true || e.current === true;
    return { company, title, startYear, endYear, isCurrent };
  }).filter(e => e.company || e.title);
}

function parseDateYear(d) {
  if (!d) return null;
  if (typeof d === 'number') return d > 1900 && d < 2100 ? d : null;
  if (typeof d === 'string') {
    const m = d.match(/(19|20)\d{2}/);
    return m ? parseInt(m[0], 10) : null;
  }
  if (typeof d === 'object') {
    return d.year || d.years || null;
  }
  return null;
}

// Career-stage inference. Pulls structured signals from the experience array
// so Claude can reference them in moves ("11 months into [Company] after 8 years
// at Goldman" - much more specific than generic role/tier moves).
function analyzeCareerStage(profile) {
  const exp = getExperience(profile);
  if (!exp.length) {
    return { totalYears: null, currentRoleYears: null, isRecentTransition: false, notablePast: [], careerStage: 'unknown' };
  }
  const thisYear = new Date().getFullYear();
  // Total years = (latest end year or now) − earliest start year
  const startYears = exp.map(e => e.startYear).filter(Boolean);
  const earliestStart = startYears.length ? Math.min(...startYears) : null;
  const totalYears = earliestStart ? Math.max(0, thisYear - earliestStart) : null;

  // Current role tenure (years since the start of the most-recent isCurrent role)
  const current = exp.find(e => e.isCurrent) || exp[0];
  const currentRoleYears = (current?.startYear) ? Math.max(0, thisYear - current.startYear) : null;
  const isRecentTransition = currentRoleYears !== null && currentRoleYears < 1.5;

  // Notable past companies (top 3 distinct, not the current one)
  const notablePast = exp
    .filter(e => !e.isCurrent && e.company)
    .map(e => e.company.trim())
    .filter((c, i, arr) => c && arr.indexOf(c) === i)
    .slice(0, 3);

  // Career-stage band - calibrated to the kinds of credibility moves available
  let careerStage = 'unknown';
  if (totalYears !== null) {
    if (totalYears < 5)        careerStage = 'early';      // 0–4 yrs
    else if (totalYears < 12)  careerStage = 'mid';        // 5–11 yrs
    else if (totalYears < 22)  careerStage = 'senior';     // 12–21 yrs
    else                       careerStage = 'late';       // 22+ yrs
  }

  return { totalYears, currentRoleYears, isRecentTransition, notablePast, careerStage };
}

// Posts-data analysis - if Apify post-scraper returned posts, compute real
// cadence + topic + engagement signals. Otherwise null.
function analyzePostsData(posts) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const recent = [];
  const allEngagement = [];
  posts.forEach(p => {
    // Date can be ISO string, timestamp, "X days ago" relative
    const postedAt = parsePostTimestamp(p);
    const likes    = Number(p.numLikes || p.likes || p.reactions || p.reactionCount || 0);
    const comments = Number(p.numComments || p.comments || p.commentCount || 0);
    const eng = likes + (comments * 2);   // comments worth more than likes
    if (postedAt && (now - postedAt) <= NINETY_DAYS) {
      recent.push({ postedAt, text: (p.text || p.postText || '').slice(0, 200), engagement: eng });
    }
    if (eng > 0) allEngagement.push(eng);
  });
  recent.sort((a, b) => b.postedAt - a.postedAt);
  const recentCount = recent.length;
  const avgEngagement = allEngagement.length ? Math.round(allEngagement.reduce((a, b) => a + b, 0) / allEngagement.length) : 0;
  const topPost = posts.slice().sort((a, b) => {
    const ea = Number(a.numLikes || a.likes || 0) + 2 * Number(a.numComments || a.comments || 0);
    const eb = Number(b.numLikes || b.likes || 0) + 2 * Number(b.numComments || b.comments || 0);
    return eb - ea;
  })[0];
  return {
    totalCount:    posts.length,
    recentCount,
    avgEngagement,
    topPostText:   topPost ? (topPost.text || topPost.postText || '').slice(0, 280) : '',
    topPostLikes:    topPost ? Number(topPost.numLikes || topPost.likes || 0) : 0,
    topPostComments: topPost ? Number(topPost.numComments || topPost.comments || 0) : 0,
    topPostUrl:    topPost ? (topPost.url || topPost.postUrl || topPost.link || topPost.permalink || '') : '',
    topPostEng:    topPost ? Number(topPost.numLikes || topPost.likes || 0) + 2 * Number(topPost.numComments || topPost.comments || 0) : 0,
    samplePosts:   recent.slice(0, 5).map(r => r.text)
  };
}
function parsePostTimestamp(post) {
  const v = post.postedAt || post.timestamp || post.date || post.posted_at || post.publishedAt;
  if (!v) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
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
  // supreme_coder doesn't include posts in the basic profile - would need a separate posts-scraper actor.
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

// Digital Footprint scoring (tightened May 2026 to fix score inflation).
// Profile completeness is now a baseline (max 0.5pt) - photo/banner/About are
// the bare minimum, not a differentiator. Real signal comes from external
// channels: Google density, ranking position, owned platforms, news mentions.
function scoreFootprint(profile, serp, presence, ranking, personalSite) {
  let pts = 0;

  // Profile completeness - basics only, max 0.5pt total
  if (getPhotoUrl(profile))        pts += 0.2;
  if (getBannerUrl(profile))       pts += 0.15;
  const about = getAbout(profile);
  if (about && about.length > 200) pts += 0.15;

  // Google name-search density - real footprint signal
  const results = serp?.organic_results || [];
  if (results.length >= 8)      pts += 0.6;
  else if (results.length >= 5) pts += 0.3;

  // Google name-search position - if YOU appear in top 3 for your name, that's strong
  if (ranking?.topPosition && ranking.topPosition <= 3) pts += 0.5;
  if (ranking?.ownedTop10 >= 3) pts += 0.3;

  // Owned-channel breadth: Substack, Medium, GitHub, personal site
  const ownedCount = Object.values(presence || {}).filter(p => p.boost === 'footprint').length
                   + (personalSite?.found ? 1 : 0);
  if (ownedCount >= 2)      pts += 1.0;
  else if (ownedCount >= 1) pts += 0.5;

  // Tier-1 press in result URLs (fallback signal even if our press scan missed)
  if (results.some(r => /forbes|bloomberg|wsj|techcrunch|reuters|tedx|news|press/i.test(r.link || ''))) {
    pts += 0.3;
  }

  return clamp03(Math.round(pts));
}

// Authority Signals scoring (tightened May 2026). Self-claimed authority via
// keywords in About is now worth zero - if we can't observe it, it doesn't count.
// LinkedIn profile signals (recs, honors, articles) get partial credit but are
// no longer a path to a high score on their own.
function scoreAuthority(profile, press, presence) {
  let pts = 0;
  const recsCount     = getRecommendations(profile).length;
  const honorsCount   = getHonors(profile).length;
  const articlesCount = getArticles(profile).length;

  // LinkedIn-only signals - capped low because anyone can earn them internally
  if (recsCount >= 5)      pts += 0.4;
  else if (recsCount >= 2) pts += 0.2;

  if (articlesCount >= 5)  pts += 0.4;
  else if (articlesCount >= 2) pts += 0.2;

  if (honorsCount >= 2) pts += 0.2;

  // Real Tier-1 press hits - the strongest signal we can detect
  const tier1Count = press?.count || 0;
  if (tier1Count >= 3)      pts += 1.4;
  else if (tier1Count >= 1) pts += 0.4 * tier1Count;

  // Cross-platform authority signals (observed, not claimed)
  if (presence?.wikipedia)  pts += 1.0;   // Wikipedia entry is huge
  if (presence?.youtube)    pts += 0.5;   // talks, interviews, podcast clips
  if (presence?.crunchbase) pts += 0.3;   // founder/exec credibility marker
  if (presence?.googleNews) pts += 0.6;   // dedicated news index hit

  // NOTE: We deliberately DO NOT award points for self-claimed press keywords
  // ("featured in Forbes", "TEDx speaker") in About text. If we can't verify
  // it via the actual press scan, it doesn't count. Removing this prevented
  // ~0.3pt of inflation per audit on profiles with bio-padding.

  return clamp03(Math.round(pts));
}

// Cadence scoring (May 2026: now uses the dedicated post-scraper output when
// available - no more "neutral 1" default). Hierarchy:
//   1. If the post-scraper returned posts → score from the real recent count
//   2. Else if the profile actor returned activities → score from those
//   3. Else fall back: creator/verified gets partial credit, otherwise 0
function scoreCadence(profile, postsData) {
  // Tier 1: real post-scraper data
  if (postsData) {
    if (postsData.recentCount >= 12) return 3;       // ≥1/week
    if (postsData.recentCount >= 6)  return 2;       // ≥1/fortnight
    if (postsData.recentCount >= 2)  return 1;       // sporadic
    return 0;                                         // truly silent
  }
  // Tier 2: profile-actor's activities/posts field if present
  const hasActivityField =
    'activities' in profile || 'posts' in profile ||
    'recentActivities' in profile || 'recent_posts' in profile || 'updates' in profile;
  if (hasActivityField) {
    const activities = getActivities(profile);
    if (activities.length >= 12) return 3;
    if (activities.length >= 6)  return 2;
    if (activities.length >= 2)  return 1;
    return 0;
  }
  // Tier 3: fallback - creator/verified implies sustained content
  if (profile.creator || profile.isVerified) return 1;
  return 0;
}

// Visual Identity (tightened May 2026). Photo alone is the LinkedIn default -
// not a signal. Banner alone matters more (it requires intent). Both together
// plus a clarity signal earns max.
// Visual Identity scoring. When Claude vision analysis is available, we trust
// IT over the heuristic - vision actually looks at the image quality, framing,
// dating signals, and banner narrative. The heuristic is the fallback when
// vision is unavailable.
function scoreVisual(profile, clarity, visionAnalysis) {
  // Vision-driven path - average of photo + banner scores from Claude vision
  if (visionAnalysis && (visionAnalysis.photo || visionAnalysis.banner)) {
    const photoScore  = visionAnalysis.photo?.score  ?? null;
    const bannerScore = visionAnalysis.banner?.score ?? null;
    const scores = [photoScore, bannerScore].filter(s => s !== null);
    if (scores.length) {
      // Weight banner higher than photo (banner takes intent)
      const photoWeight  = 0.4;
      const bannerWeight = 0.6;
      let weighted = 0, total = 0;
      if (photoScore !== null)  { weighted += photoScore  * photoWeight;  total += photoWeight; }
      if (bannerScore !== null) { weighted += bannerScore * bannerWeight; total += bannerWeight; }
      return clamp03(Math.round(weighted / total));
    }
  }
  // Heuristic fallback - presence/absence only
  let pts = 0;
  if (getPhotoUrl(profile))  pts += 0.6;
  if (getBannerUrl(profile)) pts += 1.2;
  const about = getAbout(profile);
  if (about && about.length > 400) pts += 0.5;
  if (clarity?.score >= 2) pts += 0.4;
  return clamp03(Math.round(pts));
}

// Network Recognition scoring (tightened May 2026). 500 followers is the LinkedIn
// median - it's not a signal. Bar bumped to 1k/5k/10k/50k. Cross-platform social
// presence remains a small boost.
function scoreNetwork(profile, presence) {
  const followers   = getFollowers(profile);
  const connections = getConnections(profile);
  const recsCount   = getRecommendations(profile).length;

  let pts = 0;
  if (followers >= 50_000)      pts += 1.6;
  else if (followers >= 10_000) pts += 1.1;
  else if (followers >= 5_000)  pts += 0.7;
  else if (followers >= 1_000)  pts += 0.3;
  // < 1k followers earns nothing here - that's the LinkedIn median, not a signal

  if (connections >= 1_000) pts += 0.3;
  if (recsCount >= 8)       pts += 0.3;

  // Cross-platform social presence: detected on Instagram + X = active across
  // multiple channels, which is a stronger network signal than LinkedIn alone.
  const socialCount = Object.values(presence || {}).filter(p => p.type === 'social').length;
  if (socialCount >= 2)      pts += 0.6;
  else if (socialCount >= 1) pts += 0.3;

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
