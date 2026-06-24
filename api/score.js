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
import { logAuditStarted, updateAuditRow, logAuditCompleted } from '../lib/notion-audit.js';

// Vercel KV — shared state across function instances.
// Falls back silently to in-memory when KV_REST_API_URL is not set
// (local dev, or before KV is provisioned on the Vercel project).
import { kv as _kv } from '@vercel/kv';

function getKV() {
  return (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ? _kv : null;
}

const APIFY_API     = 'https://api.apify.com/v2/acts';
// LinkedIn profile actor. dev_fusion is reliable but lean - if you want
// richer data (recommendations text, named comments on posts, full work
// history with dates), swap to one of these via the APIFY_LINKEDIN_ACTOR
// env var:
//   - apimaestro~linkedin-profile-detail   (most comprehensive, ~$0.02/profile)
//   - harvestapi~linkedin-profile-scraper  (rich, slightly cheaper)
//   - apify~linkedin-profile-scraper       (official, most reliable, priciest)
// Field mappers below are actor-agnostic - any swap is plug-and-play.
// Defensive: accept a comma-list in EITHER env var name. There's a confusing
// pair — APIFY_LINKEDIN_ACTOR (singular, original) and APIFY_LINKEDIN_ACTORS
// (plural, added when the fallback chain shipped). When ops accidentally
// sets the comma-list on the singular var, the code used to treat the whole
// string as one actor name → "actor not found" 404 → silent fallback to the
// hardcoded second actor → confusing ops alerts on every audit. Splitting
// here lets the singular env var hold a list too, so either spelling works.
const APIFY_ACTOR_LIST_SINGULAR = (process.env.APIFY_LINKEDIN_ACTOR || 'dev_fusion~Linkedin-Profile-Scraper')
  .split(',').map(s => s.trim()).filter(Boolean);
// First actor only, for any legacy single-actor code paths (logs, ops-alert
// context, etc.). The chain below uses the full list when applicable.
const APIFY_ACTOR           = APIFY_ACTOR_LIST_SINGULAR[0];
// Automatic fallback chain. If the primary actor (APIFY_LINKEDIN_ACTOR) fails
// — non-2xx response, throws, returns empty, returns an error item — fetchApify
// transparently retries with the next actor in the chain. Belt-and-suspenders
// for the case where a single actor's proxy goes offline (e.g. supreme_coder's
// hardcoded proxy at 165.227.202.187:4000 going dark). Override via env
// APIFY_LINKEDIN_ACTORS as a comma-separated list. Default: primary, then
// dev_fusion as a known-good fallback.
const APIFY_ACTOR_CHAIN = (process.env.APIFY_LINKEDIN_ACTORS
  ? process.env.APIFY_LINKEDIN_ACTORS.split(',').map(s => s.trim()).filter(Boolean)
  // Singular env var path: use the FULL singular list (already split above)
  // plus the hardcoded dev_fusion safety-net. Dedupe below catches the
  // common case where someone listed dev_fusion in the singular too.
  : [...APIFY_ACTOR_LIST_SINGULAR, 'dev_fusion~Linkedin-Profile-Scraper']
).filter((a, i, arr) => arr.indexOf(a) === i);   // dedupe in case env primary == fallback
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
// 15 audits per IP per hour. Bumped 5 → 15 for the public launch so one
// curious user can audit a handful of profiles (themselves + 2-3 references)
// in a single sitting without hitting the cap. Override at runtime by
// setting RATE_LIMIT_PER_HOUR in Vercel env vars if abuse appears in logs.
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '15', 10);
const HOUR_MS = 3_600_000;

// In-memory result cache. When the SAME LinkedIn URL + role + goal combination
// runs within RESULT_CACHE_TTL, we return the cached payload instead of running
// the full ~30-60s pipeline. Keyed on `${url}::${role}::${goal}` so different
// goal framings still re-fetch (Claude's moves are goal-aware).
// On Vercel serverless, the cache survives within a single invocation only —
// so it primarily helps when a user re-submits within the same warm container,
// or when sample-pill audits land on the same hot instance.
const RESULT_CACHE = new Map();
const RESULT_CACHE_TTL = 60 * 60 * 1000;       // 60 minutes
const RESULT_CACHE_MAX_ENTRIES = 100;

// Max simultaneous Apify scrapes — shared via KV so all instances respect the same ceiling.
const MAX_CONCURRENT_APIFY = parseInt(process.env.MAX_CONCURRENT_APIFY || '5', 10);
const APIFY_SLOT_KEY        = 'apify:inflight';
let _apifyInFlight = 0; // in-memory fallback counter

const TIERS = [
  { min:0,  max:5,  name:'The Hidden Gem',
    tagline:"Real expertise. The world doesn't know it yet.",
    blurb:'Nearly invisible - but everything is ahead of you.',
    cta:"See the roadmap" },
  { min:6,  max:10, name:'The Rising Voice',
    tagline:"You're currently building momentum, but a few gaps are holding you back.",
    blurb:"You have something to say. Your brand isn't amplifying it yet.",
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

// German tier copy. tierFor() picks this set when lang === 'de'. Tier
// `name` values stay English so they remain the canonical key that the PDF
// builder, the client SPA's German I18N TIERS, and the Mailchimp segment
// can all agree on. Only the human-readable tagline/blurb/cta switch.
const TIERS_DE = [
  { min:0,  max:5,  name:'The Hidden Gem',
    tagline:'Echte Expertise. Die Welt weiß es nur noch nicht.',
    blurb:'Nahezu unsichtbar — aber alles liegt noch vor Ihnen.',
    cta:'Den Fahrplan ansehen' },

  { min:6,  max:10, name:'The Rising Voice',
    tagline:'Sie bauen Schwung auf, aber ein paar Lücken bremsen Sie.',
    blurb:'Sie haben etwas zu sagen. Ihre Marke verstärkt es nur noch nicht.',
    cta:'Sehen, was Sie zuerst aufbauen sollten' },
  { min:11, max:15, name:'The Emerging Authority',
    tagline:'Solide Grundlagen. Zeit zu skalieren.',
    blurb:'Sie machen mehr richtig als die meisten. Jetzt: Konsistenz.',
    cta:'Sehen, welche Lücken zu schließen sind' },
  { min:16, max:18, name:'The Recognised Leader',
    tagline:'Starke Marke. Machen wir sie zum Vermächtnis.',
    blurb:'Echte Autorität aufgebaut. Als Nächstes: die Handschrift schärfen.',
    cta:'Sehen, wie Sie Ihre Handschrift schärfen' }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: "You've hit the audit limit for this hour. Come back shortly." });
  }

  const body = req.body || {};
  // Locale signal from the frontend (window.__LANG / path). Only 'de' is
  // recognized; anything else (missing, unknown) falls back to 'en' so the
  // English audit pipeline is the default behavior.
  const lang = (body.lang === 'de' ? 'de' : 'en');
  const normalised = normaliseLinkedIn(body.url);
  if (!normalised) {
    return res.status(400).json({ error: 'Please provide a valid LinkedIn profile URL.' });
  }

  await trackRequest(ip);

  // ── Result cache early-return ──
  // If the same URL + role + goal + lang combination was audited in the last
  // 60 min, return the cached payload instantly. Lang is part of the key so
  // EN and DE audits for the same profile don't collide in the cache.
  const cacheKey = `${normalised}::${(body.role || '').toLowerCase()}::${(body.goal || '').toLowerCase()}::${lang}`;
  const cachedPayload = await getCachedResult(cacheKey);
  if (cachedPayload) {
    return res.status(200).json({ ...cachedPayload, _cached: true });
  }

  // Log the submission to Notion BEFORE the Apify capacity gate, so every
  // handle a user submits gets a row — including ones that bounce off the
  // 503 waitlist or fail the scrape. Fire-and-forget; runs in parallel with
  // everything below and adds zero latency to the critical path.
  const fullUrl = `https://www.${normalised}/`;
  const auditRowIdPromise = logAuditStarted({
    linkedinUrl: fullUrl,
    role:        body.role || '',
    goal:        body.goal || '',
    utmSource:   body.attribution?.utm_source   || '',
    utmCampaign: body.attribution?.utm_campaign || '',
    clickId:     body.attribution?.fbclid || body.attribution?.gclid || ''
  }).catch(() => null);

  // Apify concurrency gate — prevents LinkedIn from blocking our actor token
  // when paid traffic causes many simultaneous scrapes.
  const apifySlotAcquired = await acquireApifySlot();
  if (!apifySlotAcquired) {
    console.warn(`[score] Apify at capacity (>${MAX_CONCURRENT_APIFY} in-flight) — returning waitlist`);
    auditRowIdPromise.then(id => updateAuditRow(id, {
      notes: '[apify-capacity] slot gate refused — user shown waitlist card'
    })).catch(() => {});
    return res.status(503).json({
      error: 'Our scanner is at capacity right now. Leave your email and we\'ll ping you in ~10 minutes.',
      _waitlist: true
    });
  }

  try {
    // Start the posts scraper immediately — it only needs the URL, not the profile.
    // Running in parallel with Stage 1 (fetchApify) removes it from the critical path
    // entirely (~8-12s saved vs. running it in Stage 2 after the profile returns).
    const postsPromise = fetchApifyPosts(normalised);

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
      // _waitlist=true → frontend shows "we're busy, leave your email" card
      // _waitlist=false → user-input error (wrong handle, private profile) — no waitlist
      let userError, alertCategory, alertSubject, waitlist = false;
      if (/hard limit|subscribe to a paid|free user|usage limit/i.test(errMsg)) {
        userError     = 'Our scanner is at capacity right now.';
        alertCategory = 'apify-hard-limit';
        alertSubject  = '🚨 Apify scraper hit hard limit - audit is OFFLINE for users';
        waitlist      = true;
      } else if (/rate.?limit|blocked|empty profile/i.test(errMsg)) {
        userError     = 'We\'re seeing a lot of audits right now and LinkedIn is pushing back.';
        alertCategory = 'apify-rate-limit';
        alertSubject  = '⚠️ Apify scraper rate-limited by LinkedIn';
        waitlist      = true;
      } else if (/401|403|unauthor/i.test(errMsg)) {
        userError     = "Profile scraper isn't configured. Check that APIFY_API_TOKEN is set on the deploy.";
        alertCategory = 'apify-auth';
        alertSubject  = '🚨 Apify auth failure - APIFY_API_TOKEN missing or invalid';
      } else if (/404|not.?found/i.test(errMsg)) {
        userError     = "That LinkedIn profile doesn't exist. Check the handle in the URL.";
        alertCategory = null; // Don't alert on user-input errors
      } else if (/private/i.test(errMsg)) {
        userError     = "That profile is private - the audit needs a public LinkedIn URL.";
        alertCategory = null;
      } else if (/abort|timed?\s?out/i.test(errMsg) || profileRes.reason?.name === 'AbortError') {
        userError     = 'We\'re getting hammered with audits right now and the scanner timed out.';
        alertCategory = 'apify-timeout';
        alertSubject  = '⚠️ Apify scraper timed out (>25s)';
        waitlist      = true;
      } else {
        userError     = 'We\'re seeing unusually high demand right now and hit a snag.';
        alertCategory = 'apify-unknown';
        alertSubject  = '⚠️ Apify scraper failed (unknown error)';
        waitlist      = true;
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

      // Stamp the failure reason into the Notion row so we can see exactly which
      // handles fail and why (404s vs. private vs. rate-limit). Fire-and-forget.
      auditRowIdPromise.then(id => updateAuditRow(id, {
        notes: `[${alertCategory || 'user-error'}] ${errMsg.slice(0, 500)}`
      })).catch(() => {});

      return res.status(502).json({
        error:     userError,
        _waitlist: waitlist || undefined,
        _debug:    errMsg.slice(0, 400),
        _actor:    APIFY_ACTOR
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
    // ─── Stage 2: ALL non-handle-dependent enrichment in one parallel batch ───
    // Moved vision analysis up here (was in Stage 3) since it only needs the
    // profile photo URL — already available from Stage 1. Saves 5-15s on the
    // critical path because vision now runs alongside the SerpAPI calls instead
    // of waiting for them. IG/X metrics still need Stage 3 because they need
    // handles parsed from the SerpAPI response.
    const [
      serpAllRes,
      serpRecentRes,
      personalSiteRes,
      presenceRes,
      postsRes,
      visionRes,
      trendsRes,
      llmVisRes,
      youtubeRes,
      podcastRes,
      booksRes,
      githubRes
    ] = await Promise.allSettled([
      fetchSerpFootprint(normalised, queryArgs, false),
      fetchSerpFootprint(normalised, queryArgs, true),
      checkPersonalDomain(queryArgs.firstName, queryArgs.lastName),
      fetchPlatformPresence(queryArgs.firstName, queryArgs.lastName, queryArgs.companyName),
      postsPromise,                            // already running since before Stage 1 — likely done
      analyzeVisualIdentity(profile, lang),    // moved up — runs in parallel with SerpAPI
      fetchGoogleTrends(queryArgs.firstName, queryArgs.lastName),
      probeLLMVisibility(queryArgs.firstName, queryArgs.lastName, queryArgs.companyName, lang),
      // New enrichment signals — all run in parallel, all silent-fail to null
      fetchYouTubeVideos(queryArgs.firstName, queryArgs.lastName),
      fetchPodcastAppearances(queryArgs.firstName, queryArgs.lastName),
      fetchPublishedBooks(queryArgs.firstName, queryArgs.lastName),
      fetchGitHubProfile(queryArgs.firstName, queryArgs.lastName)
    ]);
    const serpAll    = serpAllRes.status    === 'fulfilled' ? serpAllRes.value    : null;
    const serpRecent = serpRecentRes.status === 'fulfilled' ? serpRecentRes.value : null;
    const personalSite = personalSiteRes.status === 'fulfilled' ? personalSiteRes.value : null;
    const presence     = presenceRes.status   === 'fulfilled' ? presenceRes.value   : {};
    const rawPosts     = postsRes.status      === 'fulfilled' ? postsRes.value      : [];
    const visionAnalysis = visionRes.status === 'fulfilled' ? visionRes.value : null;
    const googleTrends  = trendsRes.status  === 'fulfilled' ? trendsRes.value  : null;
    const llmVisibility  = llmVisRes.status === 'fulfilled' ? llmVisRes.value : null;
    const youtubeVideos  = youtubeRes.status === 'fulfilled' ? youtubeRes.value : null;
    const podcastData    = podcastRes.status === 'fulfilled' ? podcastRes.value : null;
    const booksData      = booksRes.status   === 'fulfilled' ? booksRes.value   : null;
    const githubData     = githubRes.status  === 'fulfilled' ? githubRes.value  : null;
    const postsData    = analyzePostsData(rawPosts, normalised, profile);     // null if empty
    const serp = serpAll;     // alias for older usage in scoreFootprint
    const press = mergePressResults(serpAll, serpRecent);
    // Google name-position scoring - uses the serpAll we already have, no extra API call.
    const googleRanking = scoreGoogleNamePosition(queryArgs.firstName, queryArgs.lastName, serpAll);
    // Career stage from the experience array - feeds Claude for tenure-aware moves
    const careerStage = analyzeCareerStage(profile);

    // ─── Stage 3 + Claude: run in parallel ───────────────────────────────────
    // IG/X enrichment needs handles from Stage 2's presence map (can't move earlier).
    // Claude only needs heuristic scores + profile, which are already available.
    // Running them together saves 5–8s vs. the old sequential order.
    const igHandle = extractHandle(presence.instagram?.hits?.[0]?.url, 'instagram.com');
    const xHandle  = extractHandle(presence.x?.hits?.[0]?.url, 'x.com');

    // 2) Compute heuristic sub-scores so we can kick off Claude immediately.
    //    Visual is provisional (depends on clarity); we recompute after Claude returns.
    const heuristic = {
      footprint: scoreFootprint(profile, serp, presence, googleRanking, personalSite, llmVisibility),
      authority: scoreAuthority(profile, press, presence),
      cadence:   scoreCadence(profile, postsData),
      visual:    scoreVisual(profile, { score: 1 }, visionAnalysis),  // vision overrides when present
      network:   scoreNetwork(profile, presence)
    };

    // Provisional tier - gives Claude a tier hint for tier-aware move templates.
    const provisionalTotal = (heuristic.footprint || 0) + (heuristic.authority || 0)
                           + (heuristic.cadence   || 0) + (heuristic.visual    || 0)
                           + (heuristic.network   || 0) + 1;     // +1 for placeholder clarity
    const provisionalTier  = tierFor(provisionalTotal, lang);

    // 3) Run Claude analysis with profile + heuristic + rich context.
    //    Context unlocks goal-aware, role-aware, tier-aware move generation.
    const analysisCtx = {
      lang,                                 // 'en' | 'de' — drives the response-language directive in analyzeProfile
      role:           body.role  || '',
      goal:           body.goal  || '',
      tier:           provisionalTier,
      platforms:      presence,         // includes .metrics on instagram/x when enriched
      press:          press,
      pressW:         pressScore(press, presence),   // tier×recency weighted total
      personalSite:   personalSite,
      googleRanking:  googleRanking,
      googleTrends:   googleTrends,                  // { avg, peak, points } | null
      careerStage:    careerStage,
      postsData:      postsData,
      visionAnalysis: visionAnalysis,   // null OR { photo: {score, notes}, banner: {score, notes} }
      llmVisibility:  llmVisibility     // null OR { recognized, confidence, summary, themes, topSources, citations, score }
    };

    // Fire Claude + IG/X enrichment at the same time — neither depends on the other.
    const [[igRes, xRes], analysis] = await Promise.all([
      Promise.allSettled([
        igHandle ? fetchInstagramData(igHandle) : Promise.resolve(null),
        xHandle  ? fetchXData(xHandle)         : Promise.resolve(null)
      ]),
      analyzeProfile(profile, heuristic, analysisCtx).catch(err => {
        console.error('Claude analysis failed:', err);
        return {
          clarityScore: 1, clarityRationale: 'Fallback heuristic - LLM unavailable.',
          executiveSummary: '', dimensionCommentary: {}, moves: [], tierRoadmap: [], roadmap: null
        };
      })
    ]);

    const igData = igRes.status === 'fulfilled' ? igRes.value : null;
    const xData  = xRes.status  === 'fulfilled' ? xRes.value  : null;

    // Merge Instagram/X enriched data INTO the presence map - the page + PDF
    // can now show "Instagram: 4.2k followers" instead of just "Detected".
    if (igData && presence.instagram) {
      presence.instagram.metrics = igData;
    }
    if (xData && presence.x) {
      presence.x.metrics = xData;
    }
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

    // Composite = sum of sub-scores + trends modifier (capped at 18).
    // Trends rescues public figures whose LinkedIn signal under-states them
    // (Bill Gates problem) without overruling the LinkedIn-derived dimensions.
    const subTotal     = Object.values(subs).reduce((a, b) => a + b, 0);
    const trendsModifier = trendsBonus(googleTrends);
    const total = Math.min(18, subTotal + trendsModifier);
    const tier  = tierFor(total, lang);
    // nextTier reads from the same lang-aware set so its tagline/blurb match.
    const tierSet = lang === 'de' ? TIERS_DE : TIERS;
    const nextTier = tierSet.find(t => t.min > tier.max) || tier;

    // Persist the audit results to Notion. Fire-and-forget - never blocks the
    // response, never throws. If NOTION_AUDITS_DATABASE_ID isn't set, it no-ops.
    // We PATCH the row created by logAuditStarted earlier (upgrading its status
    // from audit_started to audit_completed); if that row didn't get created for
    // any reason, fall back to a fresh CREATE.
    // /api/lead and the Calendly webhook upsert later to email_submitted / walkthrough_booked.
    const _notionFirst = getFirstName(profile);
    const _notionLast  = getLastName(profile);
    if (!_notionFirst && !_notionLast) {
      // Diagnostic: if names are blank, log the available keys so we can see
      // which key the actor used (check Vercel function logs for "[Notion names blank]").
      console.warn('[Notion names blank] profile keys:', Object.keys(profile || {}).slice(0, 30).join(', '));
    }
    const _auditPayload = {
      linkedinUrl: normalised ? `https://www.${normalised}/` : null,
      firstName:   _notionFirst,
      lastName:    _notionLast,
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
    };
    auditRowIdPromise.then(async id => {
      const patched = await updateAuditRow(id, { ..._auditPayload, status: 'audit_completed' });
      if (!patched) await logAuditCompleted(_auditPayload);
    }).catch(() => {});

    const responsePayload = {
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
      roadmap:             analysis.roadmap || null,     // 90-day structured roadmap (new)
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
      // Search-interest signal (0-100 average over last 12 months) +
      // composite-score bump it produced. Surfaced for transparency on the
      // results page and in the audit log.
      googleTrends:        googleTrends,
      _trendsBonus:        trendsModifier,
      // Top-performing recent post (text + likes + comments + url) for the
      // "Your best post" finding card on the results page.
      topPost: postsData && postsData.topPostText ? {
        text:     postsData.topPostText,
        likes:    postsData.topPostLikes,
        comments: postsData.topPostComments,
        shares:   postsData.topPostShares || 0,
        url:      postsData.topPostUrl
      } : null,
      // Claude vision read on profile photo + banner (null if vision skipped)
      visionAnalysis:      visionAnalysis,
      // GEO / LLM-search visibility — what an LLM with web search knows about
      // them. Used by the "When AI meets your name" finding card on results.
      // null if probe skipped (no API key, timeout, parse fail).
      llmVisibility:       llmVisibility,
      // ── New enrichment signals ──────────────────────────────────────────────
      // YouTube videos featuring the person (via SerpAPI YouTube engine).
      // { videos: [...], count } or null.
      youtubeVideos:       youtubeVideos,
      // Podcast appearances on Apple Podcasts / Spotify (via SerpAPI Google).
      // { appearances: [...], count } or null.
      podcastData:         podcastData,
      // Published books via Google Books API (author lookup, free).
      // { books: [...], count } or null.
      booksData:           booksData,
      // GitHub profile (free API). Only populated for tech-relevant profiles.
      // { login, followers, repos, url, ... } or null.
      githubData:          githubData,
      // Backward-compat: keep older field names mapped from the new payload
      personalSummary:     analysis.executiveSummary,
      reportTeasers:       (analysis.moves || []).map(m => m.title),
      _meta: { clarityRationale: clarity.rationale }
    };

    // ── Cache the fresh payload before returning ──
    await setCachedResult(cacheKey, responsePayload);
    await releaseApifySlot();
    return res.status(200).json(responsePayload);
  } catch (err) {
    await releaseApifySlot().catch(() => {});
    console.error('score handler error:', err);
    notifyOps({
      category: 'score-handler-crash',
      subject:  '🚨 Visibility Index: /api/score crashed unexpectedly',
      body:     `Uncaught error in the score handler.\n\n${err?.stack || err?.message || String(err)}`,
      context:  { url: normalised, ip, actor: APIFY_ACTOR }
    }).catch(() => {});
    return res.status(500).json({ error: 'Something went wrong on our end.', _waitlist: true });
  }
}

/* ═══════════════════════════ EXTERNAL CALLS ═══════════════════════════ */

/* ─────────── VISUAL IDENTITY ANALYSIS (Claude vision) ───────────
   Sends the user's profile photo + banner URLs to Claude with a vision prompt.
   Returns structured judgments on lighting, framing, dating signals, banner
   coherence, and brand fit. This is the unlock that makes the Visual Identity
   dimension meaningfully scored - without it we only know presence/absence. */
// Defensive coercion for image URL helpers. Apify's LinkedIn scrapers return
// pictureUrl as a SIZE-KEYED object — e.g. `{ "400x400": "https://…",
// "200x200": "…", "100x100": "…" }` — not a bare URL string. Banner URLs
// can also come in a `{ url: '…' }` shape. Without normalizing these to a
// plain string, the Anthropic payload's `source.url` becomes a nested
// object and the API rejects it with
// `messages.0.content.0.image.source.url.url: should be a valid string`.
//
// Handles, in order: bare http(s) string → { url: '…' } → LinkedIn
// size-map (preferring larger sizes for vision quality) → any string-
// valued property that looks like a URL. Returns null otherwise, so the
// vision call is skipped cleanly rather than failing.
function coerceImageUrl(v) {
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.url === 'string' && /^https?:\/\//i.test(v.url)) return v.url;
  // LinkedIn size-map (keys like "400x400", "200x200"). Sort largest-first.
  const sizeKeys = Object.keys(v)
    .filter((k) => /^\d+x\d+$/.test(k))
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  for (const k of sizeKeys) {
    if (typeof v[k] === 'string' && /^https?:\/\//i.test(v[k])) return v[k];
  }
  // Last-resort fallback: any http(s) string property at all.
  for (const val of Object.values(v)) {
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
  }
  return null;
}

async function analyzeVisualIdentity(profile, lang = 'en') {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const photoUrl  = coerceImageUrl(getPhotoUrl(profile));
  const bannerUrl = coerceImageUrl(getBannerUrl(profile));
  if (!photoUrl && !bannerUrl) return null;
  // Short qualitative notes are what the user sees — switch them to German
  // when the audit was launched from /de. JSON shape (photo.score, banner.score)
  // stays English-keyed.
  const langDirective = lang === 'de' ? `\n\nWrite the "notes" values in formal German (Sie form, standard German orthography — use "ß" after long vowels/diphthongs, "ss" after short vowels). JSON keys stay English.` : '';

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

Return JSON ONLY. No prose, no markdown fences. Be direct - skip "great photo!" praise.${langDirective}`
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
    }, 5000);
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
    }, 5000);
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
    // 8s cap — posts scraper now starts in parallel with Stage 1 (profile fetch),
    // so by the time Stage 2 resolves it's typically already done. Cap at 8s to
    // avoid holding the pipeline open if it's slow.
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
    }, 8000);
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

// ─────────────────────────────────────────────────────────────────────────────
// GEO probe — "what do LLMs know about this person?"
// ─────────────────────────────────────────────────────────────────────────────
// In 2026 prospects, recruiters, and journalists are searching via ChatGPT /
// Perplexity / Claude before (or instead of) Google. The audit's footprint
// dimension was measuring 2018-era visibility (where do you appear on a SERP).
// This probe measures the modern equivalent: what does an LLM say when someone
// asks "who is X?" — does it know you, what does it think you're known for,
// and what sources is it pulling from?
//
// Implementation: a single Claude call with the web_search tool enabled. We
// give Claude 5 web searches max (more than enough for a "tell me about X"
// query) and force a JSON response so we can parse reliably. We capture the
// citations the model cites so the user can see exactly which pages are
// shaping the LLM's view of them.
//
// Failure mode is silent (returns null) — better to render the audit without
// the GEO card than fail the whole pipeline.
async function probeLLMVisibility(firstName, lastName, companyName, lang = 'en') {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!fullName) return null;
  const companyLine = companyName ? ` They currently work at ${companyName}.` : '';
  // Switch the user-visible "summary" + "themes" into German for DE audits.
  // Keep web_search queries in English to maximise hit quality (sources are
  // mostly English on LinkedIn/press), and keep topSources/citations as
  // domain strings (unchanged by language).
  const langDirective = lang === 'de' ? `\n\nRESPONSE LANGUAGE: Write the "summary" and "themes" values in formal German (Sie form; standard German orthography — use "ß" after long vowels/diphthongs, "ss" after short vowels). Keep your web_search queries in English. JSON keys, "recognized"/"confidence" enum values, and the topSources domain strings stay as specified.` : '';
  const prompt = `You are auditing the public AI-search footprint of a real person. Search the web and tell me what you find about "${fullName}".${companyLine}

Use the web_search tool (up to 5 queries) to find recent, specific public information — their work, what they're known for, notable accomplishments, press mentions, content they've published. Distinguish them from anyone else with the same name.

Then return ONLY a single JSON object in this EXACT shape, no preamble or commentary:

{
  "recognized": true | false,
  "confidence": "specific" | "vague" | "none",
  "summary": "<one or two sentences describing who this person is and what they do, max 240 chars. If recognized=false, write a one-line statement that no specific public information exists>",
  "themes": ["<2-4 short phrases the person is publicly associated with — what they're known for. Empty array if recognized=false>"],
  "topSources": ["<root domain of the most-cited public source>", "<second>", "<third>"]
}

Confidence rubric:
- "specific" = you found multiple specific data points (role, company, named work, named press, distinct point of view)
- "vague" = generic info only ("appears to be a marketing professional"), or you can't fully disambiguate from same-name people
- "none" = no specific public information found

Return ONLY the JSON.${langDirective}`;

  try {
    const r = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 900,
        // web_search tool gives Claude actual current-web access — same kind of
        // lookup ChatGPT/Perplexity do under the hood. max_uses keeps cost
        // bounded; 5 is plenty for a name lookup.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: prompt }]
      })
    }, 18000);  // 18s — web_search adds latency vs plain Claude calls
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('[geo] non-OK', r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    // Response can have multiple content blocks (tool_use, text, server_tool_use,
    // web_search_tool_result, then final text). Concatenate every text block
    // and grab the JSON from the LAST one — that's Claude's final answer.
    const allTextBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '');
    const lastText = allTextBlocks.length ? allTextBlocks[allTextBlocks.length - 1] : '';
    const match = lastText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return null; }

    // Pull citations from the response — the web_search_tool_result blocks
    // contain the URLs Claude actually fetched.
    const citations = [];
    (data.content || []).forEach(b => {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(item => {
          if (item.type === 'web_search_result' && item.url) {
            citations.push({
              url:   String(item.url).slice(0, 400),
              title: String(item.title || '').slice(0, 200)
            });
          }
        });
      }
    });
    // Dedupe citations by root domain — keep the first per domain.
    const seenDomains = new Set();
    const dedupedCitations = [];
    citations.forEach(c => {
      let domain = '';
      try { domain = new URL(c.url).hostname.replace(/^www\./, ''); } catch {}
      if (domain && !seenDomains.has(domain)) {
        seenDomains.add(domain);
        dedupedCitations.push({ ...c, domain });
      }
    });

    return {
      recognized: !!parsed.recognized,
      confidence: ['specific', 'vague', 'none'].includes(parsed.confidence) ? parsed.confidence : 'none',
      summary:    String(parsed.summary || '').slice(0, 280),
      themes:     Array.isArray(parsed.themes) ? parsed.themes.filter(Boolean).slice(0, 4).map(t => String(t).slice(0, 60)) : [],
      topSources: Array.isArray(parsed.topSources) ? parsed.topSources.filter(Boolean).slice(0, 5).map(s => String(s).slice(0, 80)) : [],
      citations:  dedupedCitations.slice(0, 5),
      // Score 0-3 used by the footprint dimension below.
      // none=0, vague + 1-2 sources=1, specific + 2+ sources=2, specific + 3+ + named themes=3
      score: scoreLLMVisibility(parsed, dedupedCitations)
    };
  } catch (err) {
    console.warn('[geo] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

function scoreLLMVisibility(parsed, citations) {
  const conf = parsed?.confidence;
  const themes = Array.isArray(parsed?.themes) ? parsed.themes.filter(Boolean) : [];
  const cites = Array.isArray(citations) ? citations.length : 0;
  if (!parsed?.recognized || conf === 'none') return 0;
  if (conf === 'vague')   return cites >= 2 ? 1 : 0;
  if (conf === 'specific') {
    if (themes.length >= 2 && cites >= 3) return 3;  // strong: LLM knows you, has named angles, multi-source
    if (cites >= 2) return 2;                         // medium: LLM knows you, sourced
    return 1;                                          // recognised but thin
  }
  return 0;
}

// Single-actor attempt. Throws on any failure mode (HTTP error, empty result,
// actor-reported error item). Used by the chain runner below.
async function tryOneApifyActor(actor, linkedinUrl, perCallTimeoutMs) {
  const url = `${APIFY_API}/${actor}/run-sync-get-dataset-items`;
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.APIFY_API_TOKEN}`
    },
    // Send EVERY known input shape for LinkedIn-profile actors so we don't need
    // to hardcode per-actor branching. Each actor validates only its expected
    // field; ignored fields are harmless.
    //   • dev_fusion/Linkedin-Profile-Scraper      → profileUrls: ["url"]
    //   • supreme_coder/linkedin-profile-scraper   → urls: [{ url: "url" }]
    //   • generic Apify scrapers                   → startUrls: [{ url: "url" }]
    //   • some actors                              → linkedInProfileUrls: ["url"]
    body: JSON.stringify({
      profileUrls:         [linkedinUrl],
      urls:                [{ url: linkedinUrl }],
      startUrls:           [{ url: linkedinUrl }],
      linkedInProfileUrls: [linkedinUrl],
      linkedinProfileUrl:  linkedinUrl
    })
  }, perCallTimeoutMs);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Apify ${r.status}: ${text.slice(0, 200)}`);
  }
  const items = await r.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Apify returned no items');
  }
  const raw = items[0].data || items[0];
  if (raw && (raw.error || raw.errorMessage || raw.errorType)) {
    throw new Error(`Apify actor error: ${raw.error || raw.errorMessage || raw.errorType}`);
  }
  // Detect a truly empty payload — no identity fields at all = something went
  // wrong upstream (LinkedIn rate-limited and the actor returned a stub).
  // Throwing here lets the chain move to the next actor instead of returning
  // a useless empty profile.
  const hasIdentity = raw && (
    raw.firstName || raw.first_name || raw.firstname ||
    raw.fullName  || raw.full_name  || raw.name      ||
    raw.headline  || raw.headlineText || raw.title
  );
  if (!hasIdentity) {
    throw new Error('Apify returned an empty profile - actor likely rate-limited or LinkedIn blocked the request.');
  }
  return raw;
}

async function fetchApify(linkedinUrl) {
  // Iterate the configured actor chain. First success wins. If every actor
  // fails, throw the last error so the existing handler error path runs.
  //
  // Per-call timeouts scale with chain length to stay within the 60s Vercel
  // function budget (the audit also needs ~10s of headroom for Claude
  // analysis at the end). The fixed (30s, 25s) pair was correct for 2-actor
  // chains but broke when the chain grew to 3+: total worst-case budget was
  // 30+25+25 = 80s, blowing past the 60s function cap and 504-ing real
  // users. Now scales by chain length:
  //
  //   N = 1 → primary 50s (just one shot, use the whole budget)
  //   N = 2 → primary 30s, fallback 25s (= 55s worst case, original)
  //   N = 3 → primary 22s, fallback 18s each (= 58s worst case)
  //   N ≥ 4 → primary 16s, fallback 14s each (= 58s for 4 actors)
  //
  // We give the primary a slightly larger slice on the assumption it's the
  // user-preferred actor and most-often-successful.
  const N = APIFY_ACTOR_CHAIN.length;
  const PRIMARY_TIMEOUT  = N <= 1 ? 50000 : N === 2 ? 30000 : N === 3 ? 22000 : 16000;
  const FALLBACK_TIMEOUT = N <= 1 ? 50000 : N === 2 ? 25000 : N === 3 ? 18000 : 14000;
  let lastErr;
  for (let i = 0; i < APIFY_ACTOR_CHAIN.length; i++) {
    const actor = APIFY_ACTOR_CHAIN[i];
    const timeoutMs = i === 0 ? PRIMARY_TIMEOUT : FALLBACK_TIMEOUT;
    try {
      const raw = await tryOneApifyActor(actor, linkedinUrl, timeoutMs);
      console.log('[Apify] actor:', actor, '✓ item keys:', Object.keys(raw || {}).slice(0, 30));
      // Tag the profile with which actor succeeded so the handler can surface
      // it in the response (lets you spot "fallback kicked in" in production
      // without log-diving). Non-enumerable so downstream JSON serialisation
      // doesn't include it unless explicitly read.
      try { Object.defineProperty(raw, '_apifyActor', { value: actor, enumerable: false }); } catch (_) {}
      if (i > 0) {
        console.warn(`[Apify] primary actor failed, fallback "${actor}" succeeded`);
        // Alert ops so we know the primary is degraded — throttled by category
        // so we don't spam during a sustained outage.
        notifyOps({
          category: 'apify-primary-degraded',
          subject:  `⚠️ Apify primary actor degraded — running on fallback ${actor}`,
          body:     `The primary LinkedIn actor "${APIFY_ACTOR_CHAIN[0]}" is failing.\nFallback "${actor}" succeeded.\n\nLast error from primary:\n${lastErr?.message?.slice(0, 600) || '(none)'}\n\nCheck the actor's Apify console runs to see if it's a transient burn or needs a permanent swap.`,
          context:  { primary: APIFY_ACTOR_CHAIN[0], fallback: actor }
        }).catch(() => {});
      }
      return raw;
    } catch (err) {
      console.warn(`[Apify] actor "${actor}" failed:`, err?.message?.slice(0, 200));
      lastErr = err;
    }
  }
  // All actors in the chain failed. Throw the last error so the handler's
  // existing apify-error catch (which classifies into user-friendly messages
  // and notifies ops) runs.
  throw lastErr || new Error('All Apify actors in chain failed');
}

// Three-tier press classification. Hit weights compound with recency in
// pressScore(): a Tier-1 NYT mention from last week is worth 6× a Tier-3
// year-old podcast hit. Solves the Bill-Gates problem (a public figure with
// 100 NYT pieces should not score the same as someone with 3 trade-press
// mentions, which the old flat allowlist allowed).
const PRESS_TIER_1 = [
  'nytimes.com', 'ft.com', 'bloomberg.com', 'wsj.com', 'reuters.com',
  'economist.com', 'forbes.com', 'bbc.com', 'theatlantic.com',
  'newyorker.com', 'wired.com', 'hbr.org', 'techcrunch.com'
];
const PRESS_TIER_2 = [
  'inc.com', 'fastcompany.com', 'fortune.com', 'axios.com',
  'theinformation.com', 'businessinsider.com', 'theguardian.com',
  'cnbc.com', 'cnn.com', 'theverge.com', 'venturebeat.com', 'arstechnica.com'
];
const PRESS_TIER_3 = [
  'sifted.eu', 'eu-startups.com', 'tech.eu', 'protocol.com',
  'thenextweb.com', 'engadget.com', 'medium.com', 'substack.com',
  'podcasts.apple.com', 'spotify.com', 'youtube.com',
  'linkedin.com/pulse', 'linkedin.com/posts',
  'ted.com', 'tedx.com', 'tedxtalks.ted.com',
  'crunchbase.com', 'producthunt.com'
];
// Union list — kept as TIER_1_PRESS for backward-compat with extractTier1Press's
// "is this a recognised press domain at all?" matching. Renamed mentally to
// "any tier" but the const name stays so unrelated call sites don't break.
const TIER_1_PRESS = [...PRESS_TIER_1, ...PRESS_TIER_2, ...PRESS_TIER_3];

function tierForUrl(url) {
  if (!url) return null;
  if (PRESS_TIER_1.some(d => url.includes(d))) return 1;
  if (PRESS_TIER_2.some(d => url.includes(d))) return 2;
  if (PRESS_TIER_3.some(d => url.includes(d))) return 3;
  return null;
}

// Recency multiplier for a press hit. Prefers a real date (Google News results
// include one); falls back to the merged "recent" flag (which means the hit
// came from the last-90-days SerpAPI search).
function recencyMultiplier(dateStr, recentFlag) {
  if (dateStr) {
    const t = Date.parse(dateStr);
    if (!isNaN(t)) {
      const days = (Date.now() - t) / 86400000;
      if (days <= 30)  return 2.0;
      if (days <= 90)  return 1.5;
      if (days <= 365) return 1.0;
      return 0.5;
    }
  }
  return recentFlag ? 1.5 : 1.0;
}

// Sum (tier × recency) across press hits + Google News hits. Up to 3 hits per
// outlet count, so "10 NYT mentions" beats "1 NYT mention" without unbounded
// inflation. Returns a raw weight (0 to ~30 typical max) — scoreAuthority
// thresholds it into the 0-3 sub-score band.
function pressScore(press, presence) {
  const seen = new Map();   // domainKey → count
  const candidates = [
    ...((press?.hits) || []).map(h => ({ url: h.link, date: null, recent: !!h.recent })),
    ...((presence?.googleNews?.hits) || []).map(n => ({ url: n.url, date: n.date, recent: false }))
  ];
  let total = 0;
  for (const c of candidates) {
    if (!c.url) continue;
    const tier = tierForUrl(c.url);
    if (!tier) continue;
    const domain = (c.url.match(/^https?:\/\/([^/]+)/) || [])[1] || c.url;
    const key = domain.replace(/^www\./, '');
    const count = seen.get(key) || 0;
    if (count >= 3) continue;
    seen.set(key, count + 1);
    const tierW = { 1: 3, 2: 2, 3: 1 }[tier];
    total += tierW * recencyMultiplier(c.date, c.recent);
  }
  return total;
}

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
    return fetchWithTimeout(`${SERPAPI_API}?${params}`, {}, 8000)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  });

  // Google News engine - dedicated news-index search, catches mentions across
  // every news source Google indexes (Reuters, AP, BBC, NYT, Bloomberg, FT, plus
  // local/regional outlets the standard tier-1 allowlist would miss).
  const newsCall = fetchWithTimeout(`${SERPAPI_API}?` + new URLSearchParams({
    engine: 'google_news',
    q: `${fullName}${company}`,
    api_key: process.env.SERPAPI_API_KEY
  }), {}, 8000).then(r => r.ok ? r.json() : null).catch(() => null);

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

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE VIDEOS — SerpAPI YouTube engine (uses existing SERPAPI_API_KEY, no
// separate YouTube quota). Returns up to 5 video results with thumbnails,
// view counts and channel names so the UI can show a proper visual card.
// Failure is silent — null means the card is skipped, not an audit failure.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchYouTubeVideos(firstName, lastName) {
  if (!firstName || !lastName || !process.env.SERPAPI_API_KEY) return null;
  const params = new URLSearchParams({
    engine:       'youtube',
    search_query: `"${firstName} ${lastName}"`,
    api_key:      process.env.SERPAPI_API_KEY
  });
  try {
    const r = await fetchWithTimeout(`${SERPAPI_API}?${params}`, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const videos = (j.video_results || [])
      .filter(v => v.link && v.title)
      .slice(0, 5)
      .map(v => ({
        id:        v.link?.match(/v=([^&]+)/)?.[1] || '',
        title:     (v.title       || '').slice(0, 120),
        channel:   (v.channel?.name || '').slice(0, 60),
        views:     typeof v.views === 'number' ? v.views : null,
        length:    v.length         || null,
        date:      v.published_date || null,
        thumbnail: v.thumbnail?.static || null,
        url:       v.link
      }));
    return videos.length ? { videos, count: videos.length } : null;
  } catch (err) {
    console.warn('[youtube] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PODCAST APPEARANCES — Google site-search via SerpAPI for Apple Podcasts and
// Spotify episode pages. No new key. Returns up to 4 episode URLs with titles
// and show names so the UI can list "Guest on X podcasts."
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPodcastAppearances(firstName, lastName) {
  if (!firstName || !lastName || !process.env.SERPAPI_API_KEY) return null;
  const fullName = `"${firstName} ${lastName}"`;
  const params = new URLSearchParams({
    engine:  'google',
    q:       `${fullName} (site:podcasts.apple.com OR site:open.spotify.com/episode OR site:podchaser.com)`,
    num:     '6',
    api_key: process.env.SERPAPI_API_KEY
  });
  try {
    const r = await fetchWithTimeout(`${SERPAPI_API}?${params}`, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const PODCAST_DOMAINS = ['podcasts.apple.com', 'open.spotify.com/episode', 'podchaser.com'];
    const hits = (j.organic_results || [])
      .filter(h => h.link && PODCAST_DOMAINS.some(d => h.link.includes(d)))
      .slice(0, 4)
      .map(h => ({
        url:      h.link,
        title:    (h.title   || '')
                    .replace(/ on Apple Podcasts$/, '')
                    .replace(/ \| Spotify$/, '')
                    .replace(/ - Podchaser$/, '')
                    .slice(0, 120),
        show:     (h.source?.domain || h.displayed_link || '').replace('open.spotify.com', 'Spotify').replace('podcasts.apple.com', 'Apple Podcasts').slice(0, 60),
        snippet:  (h.snippet || '').slice(0, 200),
        platform: h.link.includes('spotify.com')  ? 'spotify'
                : h.link.includes('apple.com')    ? 'apple'
                : 'other'
      }));
    return hits.length ? { appearances: hits, count: hits.length } : null;
  } catch (err) {
    console.warn('[podcasts] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISHED BOOKS — Google Books API (free, no key needed for ≤1000 req/day).
// Returns books where the person is listed as an author. Strong authority signal
// — fewer than 5% of executives have published a book.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPublishedBooks(firstName, lastName) {
  if (!firstName || !lastName) return null;
  const query = encodeURIComponent(`inauthor:"${firstName} ${lastName}"`);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=6&printType=books&orderBy=relevance`;
  try {
    const r = await fetchWithTimeout(url, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.totalItems || !j.items?.length) return null;
    const first = firstName.toLowerCase();
    const last  = lastName.toLowerCase();
    const books = j.items
      .map(item => {
        const v = item.volumeInfo || {};
        // Only include if listed as an author (not just mentioned inside)
        const isAuthor = (v.authors || []).some(a => {
          const al = a.toLowerCase();
          return al.includes(first) && al.includes(last);
        });
        if (!isAuthor) return null;
        return {
          title:     (v.title       || '').slice(0, 120),
          subtitle:  (v.subtitle    || '').slice(0, 80),
          publisher: (v.publisher   || '').slice(0, 60),
          date:      (v.publishedDate || '').slice(0, 4),  // year only
          cover:     (v.imageLinks?.thumbnail || '').replace('http:', 'https:') || null,
          url:       v.infoLink || null,
          isbn:      (v.industryIdentifiers || []).find(id => id.type === 'ISBN_13')?.identifier || null
        };
      })
      .filter(Boolean)
      .slice(0, 3);
    return books.length ? { books, count: books.length } : null;
  } catch (err) {
    console.warn('[books] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB PROFILE — GitHub Search API (free, 60 unauthenticated req/hour;
// set GITHUB_TOKEN env var for 5000/hour). Relevant for tech executives.
// Only surfaces profiles with meaningful public activity (≥20 repos or ≥50
// followers) to avoid false positives on common names.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchGitHubProfile(firstName, lastName) {
  if (!firstName || !lastName) return null;
  const token   = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept':     'application/vnd.github.v3+json',
    'User-Agent': 'visibility-index'
  };
  if (token) headers['Authorization'] = `token ${token}`;
  const query = encodeURIComponent(`${firstName} ${lastName} in:name`);
  try {
    const r = await fetchWithTimeout(
      `https://api.github.com/search/users?q=${query}&per_page=3`, { headers }, 6000
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.items?.length) return null;
    // Fetch the top candidate's full profile
    const profileR = await fetchWithTimeout(
      `https://api.github.com/users/${j.items[0].login}`, { headers }, 5000
    );
    if (!profileR.ok) return null;
    const p = await profileR.json();
    // Skip low-signal profiles (likely wrong person or inactive account)
    if ((p.public_repos || 0) < 5 && (p.followers || 0) < 20) return null;
    return {
      login:     p.login,
      name:      (p.name      || '').slice(0, 80),
      bio:       (p.bio       || '').slice(0, 200),
      followers: p.followers     || 0,
      following: p.following     || 0,
      repos:     p.public_repos  || 0,
      stars:     p.public_gists  || 0,   // proxy; star counts need a separate call
      url:       p.html_url,
      avatar:    p.avatar_url    || null,
      company:   (p.company || '').replace(/^@/, '').slice(0, 60)
    };
  } catch (err) {
    console.warn('[github] skipped', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  }
}

// SerpAPI Google Trends — interest-over-time for the user's name. Returns a
// summary { avg, peak, points } where avg/peak are 0-100 (Google's normalised
// search-interest scale, peak = 100 within the queried window). Used as a
// composite-score modifier: a public figure with thin LinkedIn signal still
// scores above zero on Visibility because their name carries search demand.
async function fetchGoogleTrends(firstName, lastName) {
  if (!firstName || !lastName || !process.env.SERPAPI_API_KEY) return null;
  const fullName = `${firstName} ${lastName}`.trim();
  const params = new URLSearchParams({
    engine: 'google_trends',
    q: fullName,
    data_type: 'TIMESERIES',
    date: 'today 12-m',
    api_key: process.env.SERPAPI_API_KEY
  });
  try {
    const r = await fetchWithTimeout(`${SERPAPI_API}?${params}`, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const timeline = j?.interest_over_time?.timeline_data || [];
    const values = timeline
      .map(t => t?.values?.[0]?.extracted_value)
      .filter(v => typeof v === 'number');
    if (!values.length) return { avg: 0, peak: 0, points: 0 };
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { avg: Math.round(avg), peak: Math.max(...values), points: values.length };
  } catch (_) {
    return null;
  }
}

// Composite-score bump from search-interest signal. Conservative: 0/+1/+2 on
// the 0-18 scale so it doesn't dominate the LinkedIn-driven sub-scores, just
// rescues people whose Google footprint outsizes their LinkedIn presence.
function trendsBonus(trends) {
  if (!trends || typeof trends.avg !== 'number') return 0;
  if (trends.avg > 50)  return 2;
  if (trends.avg >= 10) return 1;
  return 0;
}

// Score where the user's name lands in vanilla Google search results.
// Uses the all-time serp we already pulled - no extra API call.
//   - topPosition: rank (1-10) of the FIRST result mentioning the user's name
//   - ownedTop10:  count of top-10 results that appear to be about the user
function scoreGoogleNamePosition(firstName, lastName, serp) {
  const orgResults = serp?.organic_results || [];
  const fullName = `${firstName || ''} ${lastName || ''}`.toLowerCase().trim();
  if (!fullName || !orgResults.length) return { topPosition: null, ownedTop10: 0, topLinks: [] };
  let topPosition = null;
  let ownedTop10  = 0;
  orgResults.slice(0, 10).forEach((r, idx) => {
    const haystack = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    if (haystack.includes(fullName)) {
      if (topPosition === null) topPosition = idx + 1;
      ownedTop10++;
    }
  });
  return {
    topPosition,
    ownedTop10,
    topLinks: extractTopSearchLinks(orgResults, fullName)
  };
}

// Surface the top 3-5 organic results so the audit can SHOW the user where
// they appear on Google — proves the scrape was real and gives them concrete
// evidence of their current footprint. Logic:
//   1. Dedupe by domain (one slot per domain — LinkedIn shouldn't take 4 of 5)
//   2. Prefer results that mention the user's name in title/snippet
//   3. Boost authority domains (LinkedIn, Wikipedia, news outlets, .edu, .gov,
//      GitHub, Crunchbase, personal/branded domains)
//   4. Cap at 5
function extractTopSearchLinks(orgResults, fullName) {
  if (!Array.isArray(orgResults) || !orgResults.length) return [];
  // Authority domains get a relevance boost when ranking — these are the
  // sites a journalist or recruiter would consider "real coverage".
  const AUTHORITY = new Set([
    'linkedin.com', 'wikipedia.org', 'crunchbase.com', 'github.com',
    'forbes.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'reuters.com',
    'techcrunch.com', 'wired.com', 'theverge.com', 'nytimes.com',
    'theguardian.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'cnbc.com',
    'businessinsider.com', 'fastcompany.com', 'inc.com', 'entrepreneur.com',
    'medium.com', 'substack.com', 'about.me', 'producthunt.com',
    'ted.com', 'youtube.com', 'spotify.com', 'apple.com'
  ]);

  function rootDomain(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      // Treat `*.linkedin.com`, `*.medium.com`, `*.substack.com` as one bucket
      const parts = host.split('.');
      if (parts.length >= 2) {
        const last2 = parts.slice(-2).join('.');
        // Handle .co.uk, .com.au type TLDs
        if (parts.length >= 3 && /\.(co|com|org|gov|ac|net)\.[a-z]{2}$/.test(host)) {
          return parts.slice(-3).join('.');
        }
        return last2;
      }
      return host;
    } catch { return ''; }
  }

  const candidates = [];
  const fullNameLc = (fullName || '').toLowerCase();
  orgResults.forEach((r, idx) => {
    const link = r.link || r.url;
    const title = r.title || '';
    const snippet = r.snippet || '';
    if (!link || !title) return;
    const domain = rootDomain(link);
    if (!domain) return;
    const haystack = `${title} ${snippet}`.toLowerCase();
    const mentionsUser = fullNameLc && haystack.includes(fullNameLc);
    const isAuthority  = AUTHORITY.has(domain);
    // Score: lower is better. Position is the base, with discounts for
    // authority + name-match — so a relevant authority result on page 1
    // beats a noisy generic result at position 1.
    let score = idx;                  // raw rank
    if (mentionsUser)  score -= 5;    // name match is the strongest signal
    if (isAuthority)   score -= 3;    // authority boost
    candidates.push({
      link,
      title,
      snippet: snippet.slice(0, 160),
      domain,
      mentionsUser,
      isAuthority,
      score,
      rank: idx + 1
    });
  });

  // Dedupe by domain — keep the best-scoring result per domain.
  const byDomain = new Map();
  candidates
    .sort((a, b) => a.score - b.score)
    .forEach(c => { if (!byDomain.has(c.domain)) byDomain.set(c.domain, c); });

  return Array.from(byDomain.values()).slice(0, 5);
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
  // Deliberately excludes ${l}.com (surname-only) — too many businesses share a last name.
  const candidates = [
    `https://${f}${l}.com`,
    `https://${f}-${l}.com`,
    `https://${f}.${l}.com`,
    `https://www.${f}${l}.com`,
    `https://${f}${l}.me`,
    `https://${f}${l}.io`,
    `https://${f}${l}.co`,
    `https://${f}-${l}.me`,
    `https://${f}-${l}.io`
  ];

  // Parked / for-sale domain patterns we want to reject even when they return 200
  const PARKED_PATTERNS = /parked|for\s*sale|buy\s*this\s*domain|domain\s*is\s*available|godaddy|sedo|hugedomains|dan\.com|namecheap|underconstruction|under\s+construction|coming\s+soon/i;

  for (const url of candidates) {
    try {
      // 1) Quick HEAD to confirm the domain resolves at all
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), 2000);
      const head = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: headCtrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisibilityIndex/1.0)' }
      }).catch(() => null);
      clearTimeout(headTimer);
      if (!head || !head.ok) continue;

      // 2) Validate ownership: fetch the first ~10KB of HTML and confirm this
      //    person's name actually appears. Avoids false positives where the domain
      //    is owned by a different person or a business with the same name.
      const getCtrl  = new AbortController();
      const getTimer = setTimeout(() => getCtrl.abort(), 3000);
      const get = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: getCtrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisibilityIndex/1.0)' }
      }).catch(() => null);
      clearTimeout(getTimer);
      if (!get || !get.ok) continue;

      // Read first ~12KB only — enough for <head> + above-fold content
      const reader  = get.body.getReader();
      const chunks  = [];
      let   totalBytes = 0;
      try {
        while (totalBytes < 12000) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          totalBytes += value.length;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      const html  = new TextDecoder().decode(
        chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array(0))
      ).toLowerCase();

      // Reject parked / for-sale / under-construction pages
      if (PARKED_PATTERNS.test(html)) continue;

      // Require BOTH first and last name to appear somewhere in the visible content.
      // A personal site almost always names the person in the title, bio, or above-fold.
      if (!html.includes(f) || !html.includes(l)) continue;

      return { url, found: true };

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
  const r = await fetchWithTimeout(`${SERPAPI_API}?${params}`, {}, 10000);
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
  credibility: { priority: 'Authority Signals + Network Recognition',         directive: 'Moves should focus on third-party validation - press mentions, named board roles, awards, peer endorsements. If authority score ≥ 2 and ≥ 1 press hit, Wikipedia is the single highest-ROI move: fewer than 0.3% of executives have an entry — it is the most trusted credibility signal on the internet. Explain the 3-step path: (1) 3+ independent verifiable sources, (2) Articles for Creation submission, (3) specialist writer.' },
  legacy:      { priority: 'Brand Clarity + Authority + Sustained POV',       directive: 'Moves should focus on inheritable assets - a book, a named framework, an annual letter, a community that survives platforms.' }
};

// Tier-specific move templates - completely different prescriptions per tier.
// Override directive used when the user is a globally recognised public figure
// (Trends avg > 50 AND pressScore > 8). Without this branch, the prompt was
// generating "post one signature piece monthly" advice for people like Bill
// Gates — useless for someone who already has a global publishing platform.
const GLOBAL_FIGURE_DIRECTIVE = `
The user is a globally recognised public figure (Google search interest >50/100
and multiple Tier-1 press mentions). They already have media leverage.

NEVER suggest:
  ✗ "post more on LinkedIn" or any cadence-increase move
  ✗ "build a personal brand" — they already have one
  ✗ generic "thought leadership" / "share your expertise" advice
  ✗ "be more active on social media"

Instead, every move MUST do ONE of these:
  1. Convert an existing earned-media moment into a compounding owned asset —
     a book chapter, an essay collection, a framework named after them, a
     signature annual letter, a private mailing list. Reference the SPECIFIC
     press hit or platform you're converting from.
  2. Edit OUT a specific diluter — name the board seat, partnership, topic
     pillar, or recurring obligation that should be dropped to sharpen focus.
     Be concrete about WHAT to drop and WHY it dilutes their signature.
  3. Build something that compounds without their daily attention — a
     podcast they host quarterly (not weekly), a newsletter run by a paid
     editor, a signature event they convene once a year, a fellowship or
     prize that bears their name.

Their bottleneck is NOT visibility. It is signal-to-noise and inheritability.
Moves should sharpen what they're already known for, not multiply outputs.`;

const TIER_DIRECTIVES = {
  'The Hidden Gem':         'Moves are FOUNDATIONAL. Headline rewrite, banner upload, first weekly post commitment, claim a personal domain, take a real photo. Twenty-minute moves, not twelve-week commitments. Aim for the +6pt jump to Rising Voice in three weeks.',
  'The Rising Voice':       'Moves are HABIT-FORMING. Lock cadence (one post/week, same day, three pillars). One outbound press or podcast pitch. Rewrite headline if not already crisp. The bottleneck is sustained outbound, not foundational fixes.',
  'The Emerging Authority': 'Moves are SCALING. One tier-1 press mention per quarter (specific journalist + outlet + angle). Speaker pitch to a named conference. Sharpen the signature - one signature post format used weekly. Stop fixing basics, start owning a corner.',
  'The Recognised Leader':  'Moves are SHARPENING. Inheritable assets - a book, a named framework, an annual letter. Edit OUT diluters (decline 80% of advisory invites, drop the 4th topic pillar). Build the asset that compounds without you posting daily.'
};

async function analyzeProfile(profile, heuristic, ctx = {}) {
  // Locale for the user-facing prose Claude generates. JSON shape stays
  // English-keyed — only the human-readable values change language.
  const lang = ctx.lang === 'de' ? 'de' : 'en';
  const langDirective = lang === 'de' ? `

RESPONSE LANGUAGE: Respond entirely in formal German (use the "Sie" form throughout — never "du"/"dich"/"dein"). Use STANDARD German orthography (target audience is Germany, not Switzerland): write "ß" after long vowels and diphthongs (Straße, groß, größer, weiß, heißt, schließlich, ausschließlich, Maßnahme, regelmäßig, gemäß, draußen), but "ss" after short vowels (muss, dass, Fluss, Anschluss, lassen, wissen). Keep these terms verbatim in English: Visibility Index, Von Peach, FutureMakers, FutureMakers Circle, LinkedIn, "Personal Brand", PDF, Score, Tier, GmbH. Translate everything else into natural, confident, executive German — including the executive summary, dimension commentary, move titles + rationales + steps, outreach email drafts (subjects and body text), writing/video ideas, and press-target descriptions.

LENGTH LIMITS (German tends to overflow the PDF card layout — keep titles short):
- move.title: ≤ 45 characters. Use punchy imperatives ("Banner schärfen", "Neue Headline schreiben"), never full sentences.
- writingIdeas[].title and videoIdeas[].title: ≤ 50 characters.
- pressTargets[].outlet: ≤ 25 characters.
If you can't fit the German idea in the budget, simplify the concept, don't extend.

ALSO TRANSLATE THESE STRING FIELDS to German (they were being missed):
- move.timeToInvest: use German time units, e.g. "20 Min", "1 Std", "wöchentlich 1 Std", "30 Min", "2 Std" — not "20 MIN", "1 HOUR", "WEEKLY HOUR".
- videoIdeas[].format and videoIdeas[].shotIn: write in German, e.g. format "60 Sek Talking Head", shotIn "15 Min, ohne Schnitt" — not "60s talking head" / "15 min, no edit".

CRITICAL: keep all JSON keys, "service" tokens (strategy/content/video/photo/linkedin/speaker/pr), the "type" enum on outreach (press/podcast/speaker/board/advisor/partner/investor), and tier "name" values EXACTLY as specified in English — only the human-readable values switch language.` : '';
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
  // Detect global-figure status from the new Trends + press signals. When
  // both are high the standard tier directive (even Recognised Leader) is
  // too generic — override it with rules tuned for people who already have
  // a global publishing platform.
  const trendsAvg     = ctx.googleTrends?.avg ?? 0;
  const pressW        = ctx.pressW ?? 0;
  const isGlobalFigure = trendsAvg > 50 && pressW > 8;
  const tierDirective = isGlobalFigure
    ? GLOBAL_FIGURE_DIRECTIVE
    : (TIER_DIRECTIVES[tierName] || '');

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
    ? `Posts in last 90 days: ${pd.recentCount} (own posts only — reposts excluded). Avg engagement (likes + 2×comments + 3×shares): ${pd.avgEngagement}. Top post: "${(pd.topPostText || '').slice(0, 140)}". Sample recent posts: ${(pd.samplePosts || []).slice(0, 3).map(s => `"${s.slice(0, 80)}…"`).join(' / ')}`
    : 'No post-scraper data — cadence is unobserved (treat as 0 unless proxied by creator/verified status)';

  // GEO / LLM-search visibility — what an LLM with web search says about them.
  // This is the modern half of the footprint dimension. If an LLM doesn't know
  // them or only has vague info, the moves should call that out specifically.
  const llm = ctx.llmVisibility;
  const llmLine = llm
    ? `When ChatGPT/Perplexity-style search engines are asked about this person, the answer is: "${(llm.summary || '').slice(0, 200)}" [confidence: ${llm.confidence}, recognised: ${llm.recognized}, themes: ${(llm.themes || []).join(' / ') || 'none named'}, top sources: ${(llm.topSources || []).slice(0, 3).join(', ') || 'none'}]`
    : 'GEO probe unavailable — treat AI-search visibility as unobserved.';

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

  const prompt = `You are a brand strategist running a personalised visibility audit for an executive based on their LinkedIn profile. The audit scores six dimensions on 0-3 each, summed to 0-18.${langDirective}

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

GEO / AI-SEARCH VISIBILITY (from a live web-search probe of an LLM):
- ${llmLine}
- This signal matters because in 2026 prospects, recruiters, and journalists open ChatGPT or Perplexity BEFORE Google. If the LLM doesn't know them (recognized=false / confidence=none) — write at least one move about owning a clear "known for" angle that LLMs can index (Substack, recurring podcast guesting, named POV in press). If confidence=vague — the gap is positioning, not visibility: name the wobble. If confidence=specific — reinforce the angle the LLM already gave them.

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
${lang === 'de' ? `
DE OUTPUT BUDGET (CRITICAL for /de — read carefully):
1. For writingIdeas, videoIdeas, and pressTargets: RETURN EMPTY ARRAYS ([]). Do not generate any items. The PDF builder has localised fallback content for these.
2. For ALL OTHER string values, use formal German (Sie-form, never du). Pay special attention to PROSE: executiveSummary, move.why, move.firstStep, move.weekOne, move.month1, roadmap.endState, roadmap.months[].weeks[]. These drift to English most often.
3. JSON keys + enum values (service tokens, outreach types) + tier "name" values stay English exactly as specified.
` : ''}
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
  "// roadmap": "A structured 90-day roadmap rendered as a dedicated section in the PDF. Personalised by THIS user's score, tier, weakest dimensions, role, and goal. Self-directed (no mentor, no submissions) — confident executive tone, no fluff. Each weekly action is one specific verb-led move (≤14 words). Each milestone is checkable (≤16 words). The endState is one sentence (≤30 words) describing the concrete state at day 90.",
  "roadmap": {
    "focus": "<the SINGLE dimension this roadmap centers on — pick the user's WEAKEST sub-score. Use the exact dimension display name in the response language (e.g. 'Brand Clarity' / 'Markenklarheit', 'Authority Signals' / 'Autoritätssignale').>",
    "endState": "<one sentence describing where the user will be at the end of 90 days IF they execute. ≤30 words. Concrete, name the dimension that shifts. Goal-aware: if goal='speaking', reference one booked keynote; 'credibility', one tier-1 press; 'clients', better-fit inbound; 'legacy', a published asset.>",
    "months": [
      {
        "title": "<short month title — ≤6 words, e.g. 'Foundation — fix the gap' / 'Grundlagen — Lücke schließen'. References Month 1's theme.>",
        "theme": "<one-sentence theme line ≤22 words. Names what this month is FOR, not a list.>",
        "weeks": [
          "<Week 1 action — one verb-led specific move. ≤14 words. References something real from the audit (their headline, their follower count, a detected platform, a specific press hit, or a specific dimension stat).>",
          "<Week 2 action — ≤14 words, verb-led, specific.>",
          "<Week 3 action — ≤14 words, verb-led, specific.>",
          "<Week 4 action — ≤14 words, verb-led, specific.>"
        ],
        "milestone": "<by end of Month 1, the user should be able to point at: ___. ≤16 words. Checkable — yes/no.>"
      },
      {
        "title": "<Month 2 title, ≤6 words. Theme moves from foundation to RHYTHM. Examples: 'Cadence — three posts a week' / 'Rhythmus — drei Beiträge pro Woche'.>",
        "theme": "<≤22 words. Names what Month 2 is FOR.>",
        "weeks": [
          "<Week 5 action>",
          "<Week 6 action>",
          "<Week 7 action>",
          "<Week 8 action>"
        ],
        "milestone": "<by end of Month 2, ___. ≤16 words.>"
      },
      {
        "title": "<Month 3 title, ≤6 words. Theme moves from rhythm to COMPOUND/PROOF. Examples: 'Compound — first authority pitch' / 'Verstärkung — erster Authority-Pitch'.>",
        "theme": "<≤22 words. Names what Month 3 is FOR.>",
        "weeks": [
          "<Week 9 action>",
          "<Week 10 action>",
          "<Week 11 action>",
          "<Week 12 action>"
        ],
        "milestone": "<by end of Month 3, ___. ≤16 words. Should connect to the goal directly.>"
      }
    ]
  },
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

NO-HEDGE RULE (zero tolerance):
- Each move commits to ONE thing. NEVER write "A OR B" or "X OR Y or both".
  Hedging signals you didn't choose. Pick the option with stronger evidence
  in their profile and write the why for that one.
- NEVER write "on a single theme" without naming the theme. Pick the theme
  yourself based on their headline / experience / press / detected platforms.
  Wrong: "post on a single theme — climate OR global health OR both"
  Right: "post monthly on cap-table mechanics for first-time founders"

BAD move phrasings to NEVER use (these are corporate-speak tells):
  ✗ "moves your clients to act" / "unlocks value" / "positions you as a thought leader"
  ✗ "so journalists / executives / decision-makers instantly know what to expect"
  ✗ "post one signature piece monthly" — what to post about?
  ✗ "sharpen the signature" — sharpen WHAT, specifically?
  ✗ "amplify your voice" / "elevate your presence" / "establish credibility"
  ✗ "build a personal brand" — anyone reading this has one already
GOOD move phrasings (concrete and falsifiable):
  ✓ "Drop the third bullet from your About section — 'transforming the future' tells nothing"
  ✓ "Pitch a 600-word op-ed to FT Adviser citing the data from your Q2 report"
  ✓ "Convert your TEDx talk into a five-post LinkedIn carousel this week"

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
- pr       = PR advisory

FORMAT REQUIREMENTS (very important — affects parsing):
- Return ONLY the raw JSON object specified above. Begin directly with \`{\` and end with \`}\`.
- Do NOT include any preamble (no "Here is the analysis:" / "Hier ist Ihre Analyse:"). Do NOT include any commentary after the JSON.
- Do NOT wrap the output in markdown code fences. No \`\`\`json blocks.
- All JSON keys, structural strings, and string-VALUE delimiters must use straight ASCII double quotes ("). Do not use typographic quotes („ " » «) as string delimiters; if a quoted phrase appears inside a string value, escape the internal " as \\".
- Output must be valid JSON that JSON.parse() will accept on the first try.`;

  // Retry on 429 (Anthropic rate-limit). 3 total attempts with exponential
  // backoff (~1.5s, 3s). 429 responses are immediate (no wasted budget) and
  // burst rate-limits typically clear within seconds; this restores the core
  // analyzeProfile prose when concurrent audits stack against Anthropic's
  // per-org tokens-per-minute. Other status codes break out immediately and
  // fall through to the existing throw.
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // Bumped 3500 → 5000 after observing /de audits intermittently returning
        // empty moves/executiveSummary/roadmap. Root cause: German output is
        // ~30% longer than English (longer compounds, longer verbs, different
        // word order). The full schema in DE was overflowing 3500 tokens mid-
        // JSON, leaving an unparseable response, the regex extractor failing,
        // and the empty-fallback shape being returned to the SPA. 5000 gives
        // a ~30% safety margin over the longest observed DE response. Cost
        // is ~1-2s extra latency in the (rare) case where the response is
        // actually that long; Claude stops at its real natural completion.
        max_tokens: 5000,
        messages: [{ role: 'user', content: prompt }]
      })
    }, 45000);
    if (r.status !== 429 || attempt === 2) break;
    const waitMs = 1500 * Math.pow(2, attempt); // 1500ms, 3000ms
    console.warn(`[analyzeProfile] Anthropic 429 — retry ${attempt + 1}/2 in ${waitMs}ms`);
    await new Promise((res) => setTimeout(res, waitMs));
  }
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  // Strip markdown code fences before regex-extracting the JSON. Despite the
  // prompt's explicit "no markdown fences" rule, Haiku occasionally still
  // wraps responses in ```json ... ``` — especially under the German
  // RESPONSE LANGUAGE directive. Stripping makes the extractor robust to
  // either output shape; the prompt + this combine for defense in depth.
  const cleanedText = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (/```/.test(m) ? '' : m))
    .replace(/```\s*$/i, '');
  const match = cleanedText.match(/\{[\s\S]*\}/);
  const fallback = {
    clarityScore: 1,
    clarityRationale: 'Parse fallback.',
    executiveSummary: '',
    dimensionCommentary: {},
    moves: [],
    tierRoadmap: [],
    roadmap: null
  };
  if (!match) {
    // Log a short prefix of the raw text on parse-extraction failure so the
    // next Vercel log entry shows WHAT Claude returned. Truncated to keep
    // logs cheap; full debugging requires a dedicated dump.
    console.warn('[analyzeProfile] no JSON braces found in Claude text. Prefix:', text.slice(0, 200));
    return fallback;
  }
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
      // 90-day roadmap structure — extends the report with a dedicated
      // "Your 90-Day Roadmap" page. Three months × four weekly actions +
      // a milestone gate per month + an end-state line. Defensively sliced
      // so an over-eager Claude response (e.g. 5 months, 6 weeks per month)
      // can never blow the PDF layout. Empty-shape on absence so the PDF
      // renderer can quietly skip the page rather than crash.
      roadmap: (p.roadmap && typeof p.roadmap === 'object' && Array.isArray(p.roadmap.months)) ? {
        focus:    String(p.roadmap.focus    || '').slice(0, 120),
        endState: String(p.roadmap.endState || '').slice(0, 360),
        months:   p.roadmap.months.slice(0, 3).map(m => ({
          title:     String(m?.title || '').slice(0, 80),
          theme:     String(m?.theme || '').slice(0, 200),
          weeks:     Array.isArray(m?.weeks)
                       ? m.weeks.slice(0, 4).map(w => String(w || '').slice(0, 180))
                       : [],
          milestone: String(m?.milestone || '').slice(0, 200)
        }))
      } : null,
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
  } catch (err) {
    // Log enough of the matched JSON candidate to diagnose parse failures
    // in Vercel logs without dumping the whole response.
    console.warn('[analyzeProfile] JSON.parse failed:', err?.message || err);
    console.warn('[analyzeProfile] candidate head:', match[0].slice(0, 300));
    console.warn('[analyzeProfile] candidate tail:', match[0].slice(-200));
    return fallback;
  }
}

/* ═══════════════════════════ FIELD MAPPERS (defensive across actor shapes) ═══════════════════════════ */
// Apify actors don't all use identical field names. These helpers cover the common ones
// so the same scoring code works whether the actor returns `headline` or `headlineText`,
// `followers` or `followersCount`, etc. If the chosen actor uses something else,
// add aliases here - no need to touch the scoring functions.

function getFirstName(p) {
  // Ordered by actor prevalence:
  // supreme_coder → firstName
  // dev_fusion → first_name / firstname
  // generic LinkedIn APIs → givenName / given_name
  // Apify generic → split fullName / full_name / name / displayName
  if (p.firstName)   return String(p.firstName).trim();
  if (p.first_name)  return String(p.first_name).trim();
  if (p.firstname)   return String(p.firstname).trim();
  if (p.givenName)   return String(p.givenName).trim();
  if (p.given_name)  return String(p.given_name).trim();
  const full = p.fullName || p.full_name || p.displayName || p.display_name || p.name || '';
  if (full) return String(full).trim().split(/\s+/)[0] || '';
  return '';
}
function getLastName(p) {
  if (p.lastName)    return String(p.lastName).trim();
  if (p.last_name)   return String(p.last_name).trim();
  if (p.lastname)    return String(p.lastname).trim();
  if (p.familyName)  return String(p.familyName).trim();
  if (p.family_name) return String(p.family_name).trim();
  const full = p.fullName || p.full_name || p.displayName || p.display_name || p.name || '';
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
//
// IMPORTANT — the post-scraper's raw output is NOT clean:
//   • It includes reposts/reshares (where the user clicked "Repost" on
//     someone else's content). Those shouldn't count as the user's own work.
//   • It can include posts authored by other people (rare, but we've seen it).
//   • Engagement counts include likes + comments + shares, but the legacy
//     formula only weighted likes + 2×comments and ignored shares.
//   • "Best post" was previously sorted across ALL posts ever returned, so
//     a 5-year-old viral post would beat a recent one. We now restrict the
//     top-post pick to the last 90 days so it's a current signal.
//
// We pass `profileUrl` (normalised LinkedIn URL like `linkedin.com/in/yentl`)
// and the raw `profile` object so we can match author. When the scraper tags
// a post with an author, we drop anything where the author isn't the user.
function analyzePostsData(posts, profileUrl, profile) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

  // Build identity hints so we can verify author = user.
  // We accept ANY of: handle in URL, full name match (case-insensitive),
  // public-id, or LinkedIn member ID.
  const handle = (profileUrl || '').split('/in/')[1]?.replace(/\/.*$/, '').toLowerCase() || '';
  const firstName = profile ? (getFirstName(profile) || '') : '';
  const lastName  = profile ? (getLastName(profile)  || '') : '';
  const fullName  = (firstName + ' ' + lastName).trim().toLowerCase() ||
    String(profile?.fullName || profile?.name || '').toLowerCase();
  const publicId  = String(profile?.publicIdentifier || profile?.publicId || handle || '').toLowerCase();

  function isOwnPost(p) {
    // 1. Reject explicit reposts.
    if (p.is_repost === true || p.isRepost === true || p.reposted === true) return false;
    if (p.repostedBy || p.repostedFrom || p.reshared || p.sharedFrom) return false;
    // Some scrapers tag with `type: 'repost'` or `actionType: 'reshare'`.
    const type = String(p.type || p.postType || p.actionType || '').toLowerCase();
    if (type.includes('repost') || type.includes('reshare') || type.includes('share')) return false;

    // 2. Match author when the scraper tags one. If we can determine the post
    //    has an author AND the author isn't the user, reject. If we can't tell
    //    who authored it, default to keeping it (the scraper presumably only
    //    fetched the user's feed in the first place).
    const authorObj = p.author || p.authorInfo || p.user || null;
    const authorUrl = String(
      authorObj?.profileUrl || authorObj?.profile_url || authorObj?.url ||
      authorObj?.linkedinUrl || p.authorUrl || p.authorProfileUrl || ''
    ).toLowerCase();
    const authorName = String(
      authorObj?.name || authorObj?.fullName ||
      [authorObj?.firstName, authorObj?.lastName].filter(Boolean).join(' ') ||
      p.authorName || p.author_name || ''
    ).toLowerCase().trim();
    const authorPublicId = String(
      authorObj?.publicIdentifier || authorObj?.public_id ||
      authorObj?.username || authorObj?.handle || ''
    ).toLowerCase();

    if (authorUrl && handle && authorUrl.includes(`/in/${handle}`)) return true;
    if (authorPublicId && publicId && authorPublicId === publicId)  return true;
    if (authorName && fullName && authorName === fullName)          return true;
    // If we have author info but none of it matches the user, reject.
    if (authorUrl || authorName || authorPublicId) return false;
    // No author info — default to keep.
    return true;
  }

  // Score formula: likes + 2×comments + 3×shares. Shares are the strongest
  // signal of "this post moved beyond my immediate audience". They were
  // missing from the previous formula.
  function engagement(p) {
    const likes    = Number(p.numLikes    || p.likes    || p.reactions || p.reactionCount || p.stats?.total_reactions || p.stats?.likes || 0);
    const comments = Number(p.numComments || p.comments || p.commentCount || p.stats?.comments || 0);
    const shares   = Number(p.numShares   || p.shares   || p.shareCount   || p.reposts || p.repostCount || p.stats?.reposts || p.stats?.shares || 0);
    return likes + (2 * comments) + (3 * shares);
  }

  const ownPosts = posts.filter(isOwnPost);
  // If author-filtering wiped everything, fall back to raw posts so we don't
  // return null (some scrapers don't tag author at all and trip the
  // mismatch path). Better to surface something than nothing.
  const candidates = ownPosts.length ? ownPosts : posts;

  // Cadence + avg engagement: only count posts we've kept.
  const recent = [];
  const allEngagement = [];
  candidates.forEach(p => {
    const postedAt = parsePostTimestamp(p);
    const eng = engagement(p);
    if (postedAt && (now - postedAt) <= NINETY_DAYS) {
      recent.push({ postedAt, text: (p.text || p.postText || p.content || '').slice(0, 200), engagement: eng, raw: p });
    }
    if (eng > 0) allEngagement.push(eng);
  });
  recent.sort((a, b) => b.postedAt - a.postedAt);
  const recentCount = recent.length;
  const avgEngagement = allEngagement.length
    ? Math.round(allEngagement.reduce((a, b) => a + b, 0) / allEngagement.length)
    : 0;

  // "Best post" = highest engagement among RECENT (last 90 days) own posts.
  // Falls back to all own posts if none were within 90 days (e.g. user posts
  // quarterly). Final fallback is everything in `candidates`.
  const recentRanked = recent.slice().sort((a, b) => b.engagement - a.engagement);
  let topPost = recentRanked[0]?.raw || null;
  if (!topPost) {
    const ownRanked = candidates.slice().sort((a, b) => engagement(b) - engagement(a));
    topPost = ownRanked[0] || null;
  }

  // Don't surface a "top post" that has zero engagement — it'd be a worse
  // signal than no top-post at all. Set null instead so the finding card
  // hides cleanly.
  const topPostEng = topPost ? engagement(topPost) : 0;
  const showTopPost = topPost && topPostEng >= 5;

  return {
    totalCount:    posts.length,
    ownCount:      ownPosts.length,
    recentCount,
    avgEngagement,
    topPostText:   showTopPost ? (topPost.text || topPost.postText || topPost.content || '').slice(0, 280) : '',
    topPostLikes:    showTopPost ? Number(topPost.numLikes || topPost.likes || topPost.stats?.total_reactions || topPost.stats?.likes || 0) : 0,
    topPostComments: showTopPost ? Number(topPost.numComments || topPost.comments || topPost.stats?.comments || 0) : 0,
    topPostShares:   showTopPost ? Number(topPost.numShares || topPost.shares || topPost.shareCount || topPost.stats?.reposts || topPost.stats?.shares || 0) : 0,
    topPostUrl:    showTopPost ? (topPost.url || topPost.postUrl || topPost.link || topPost.permalink || topPost.shareUrl || '') : '',
    topPostEng:    showTopPost ? topPostEng : 0,
    samplePosts:   recent.slice(0, 5).map(r => r.text)
  };
}
function parsePostTimestamp(post) {
  // Try direct fields first.
  let v = post.postedAt || post.timestamp || post.date || post.posted_at || post.publishedAt || post.time;
  // apimaestro~linkedin-profile-posts uses a NESTED `posted_at` object:
  //   { date: 'YYYY-MM-DD HH:MM:SS', timestamp: 1700000000000, relative: '2d' }
  if (v && typeof v === 'object') {
    v = v.timestamp || v.date || v.iso || v.relative || null;
  }
  if (!v) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    // Handle relative strings like "2d", "3w", "1mo" as a last resort.
    const m = v.match(/^(\d+)\s*(s|m|h|d|w|mo|y)/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const ms = unit === 's' ? 1000
              : unit === 'm' ? 60000
              : unit === 'h' ? 3.6e6
              : unit === 'd' ? 8.64e7
              : unit === 'w' ? 6.048e8
              : unit === 'mo' ? 2.628e9
              : 3.154e10;
      return Date.now() - n * ms;
    }
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
function scoreFootprint(profile, serp, presence, ranking, personalSite, llmVisibility) {
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

  // GEO / LLM-search visibility — modern half of the footprint dimension.
  // Probe score is 0–3; we cap its contribution at 0.6pt so it can't dominate
  // the dimension on its own (a person could be famous in LLMs but invisible
  // on Google — both halves matter). Adds genuine signal because Google and
  // LLM training corpora draw from overlapping but distinct sources.
  const llmScore = Number(llmVisibility?.score || 0);
  if (llmScore >= 3)      pts += 0.6;
  else if (llmScore >= 2) pts += 0.4;
  else if (llmScore >= 1) pts += 0.2;

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

  // Press scoring: tier × recency weighted (replaces flat tier1Count).
  // pressScore() folds in Google News hits (with real dates) plus the merged
  // SerpAPI organic press hits (with a recent flag from the last-90-days
  // search). Thresholds calibrated so:
  //   • Bill Gates / Tier-1 with recency stacking → max bracket (1.6pt)
  //   • A solid Tier-1 hit + supporting trade press     → middle (1.0pt)
  //   • Any recognised press at all                     → minimum (0.5pt)
  // googleNews boost is now part of pressScore — removing the standalone
  // +0.6 here avoids double-counting.
  const pressW = pressScore(press, presence);
  if (pressW >= 8)       pts += 1.6;
  else if (pressW >= 4)  pts += 1.0;
  else if (pressW >= 1)  pts += 0.5;

  // Cross-platform authority signals (observed, not claimed)
  if (presence?.wikipedia)  pts += 1.0;   // Wikipedia entry is huge
  if (presence?.youtube)    pts += 0.5;   // talks, interviews, podcast clips
  if (presence?.crunchbase) pts += 0.3;   // founder/exec credibility marker

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

function tierFor(score, lang = 'en') {
  const set = lang === 'de' ? TIERS_DE : TIERS;
  return set.find(t => score >= t.min && score <= t.max) || set[0];
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

// ── KV-backed result cache ─────────────────────────────────────────────────
async function getCachedResult(cacheKey) {
  const store = getKV();
  if (store) {
    try {
      const v = await store.get(`cache:${cacheKey}`);
      if (v) { console.log('[score] KV cache hit:', cacheKey); return v; }
    } catch (e) {
      console.warn('[kv] cache get failed:', e.message);
    }
  }
  // Memory fallback
  const cached = RESULT_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.t) < RESULT_CACHE_TTL) {
    console.log('[score] memory cache hit:', cacheKey);
    return cached.payload;
  }
  return null;
}

async function setCachedResult(cacheKey, payload) {
  const store = getKV();
  if (store) {
    try {
      await store.set(`cache:${cacheKey}`, payload, { ex: Math.floor(RESULT_CACHE_TTL / 1000) });
    } catch (e) {
      console.warn('[kv] cache set failed (payload may be too large):', e.message);
    }
  }
  // Always write memory cache too (fast local hit within warm instance)
  if (RESULT_CACHE.size >= RESULT_CACHE_MAX_ENTRIES) {
    const oldest = [...RESULT_CACHE.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if (oldest) RESULT_CACHE.delete(oldest[0]);
  }
  RESULT_CACHE.set(cacheKey, { t: Date.now(), payload });
}

// ── Apify concurrency gate ─────────────────────────────────────────────────
// Prevents thundering-herd bursts from firing dozens of Apify scrapes at once
// (LinkedIn blocks actors that issue rapid bursts from the same token).
async function acquireApifySlot() {
  const store = getKV();
  if (store) {
    try {
      const count = await store.incr(APIFY_SLOT_KEY);
      await store.expire(APIFY_SLOT_KEY, 120); // auto-clean if function crashes
      if (count > MAX_CONCURRENT_APIFY) {
        await store.decr(APIFY_SLOT_KEY);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[kv] acquireApifySlot failed, using memory:', e.message);
    }
  }
  // Memory fallback
  if (_apifyInFlight >= MAX_CONCURRENT_APIFY) return false;
  _apifyInFlight++;
  return true;
}

async function releaseApifySlot() {
  const store = getKV();
  if (store) {
    try { await store.decr(APIFY_SLOT_KEY); } catch (_) {}
  } else {
    _apifyInFlight = Math.max(0, _apifyInFlight - 1);
  }
}

// ── KV-backed rate limiter (falls back to in-memory) ──────────────────────
async function isRateLimited(ip) {
  const store = getKV();
  if (store) {
    try {
      const count = await store.get(`rl:${ip}`);
      if (count === null || count === undefined) return false;
      return Number(count) >= RATE_LIMIT_PER_HOUR;
    } catch (e) {
      console.warn('[kv] isRateLimited failed, using memory:', e.message);
    }
  }
  // Memory fallback
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= RATE_LIMIT_PER_HOUR;
}

async function trackRequest(ip) {
  const store = getKV();
  if (store) {
    try {
      const key = `rl:${ip}`;
      const count = await store.incr(key);
      if (count === 1) await store.expire(key, 3600); // set TTL on first hit
      return;
    } catch (e) {
      console.warn('[kv] trackRequest failed, using memory:', e.message);
    }
  }
  // Memory fallback
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT.set(ip, { count: 1, resetAt: now + HOUR_MS });
  } else {
    entry.count += 1;
  }
}
