/**
 * /api/lead - POST { email, goal, role, score, subs, tier, ... }
 *
 * Pipeline:
 *   1. Validate email
 *   2. Build the personalised PDF (lib/buildReport.js - pdf-lib, no Chromium)
 *   3. Email it via Resend with the PDF attached
 *   4. Upsert the lead into Mailchimp with merge fields + tags (segmentation)
 *   5. Return { ok, pdf: base64 } - frontend offers instant download
 *
 * Mailchimp audience setup (one-time):
 *   Audience → Settings → Audience fields and *|MERGE|* tags
 *   Add the following tag/name pairs (all type "Text" except VIS_SCORE which is "Number"):
 *     VIS_SCORE   (Number) - composite 0-18
 *     VIS_TIER    (Text) - e.g. "The Rising Voice"
 *     VIS_GOAL    (Text) - clients / speaking / credibility / legacy
 *     VIS_LINKEDIN(Text) - normalised linkedin URL
 *     UTM_SOURCE  (Text)
 *     UTM_CAMP    (Text)
 *     UTM_MED     (Text)
 *
 * Tags applied automatically: tier:<slug>, goal:<value>, role:<value>, campaign:<utm_campaign>
 */

import { createHash } from 'node:crypto';
import { buildReportPDF } from '../lib/buildReport.js';
import { notifyOps }    from '../lib/notify.js';
import { upsertAuditOnLead } from '../lib/notion-audit.js';
import { sendGAMpEvent } from '../lib/ga-mp.js';
import { kv as _kv } from '@vercel/kv';

const RESEND_API = 'https://api.resend.com/emails';

// Rate limit: max 5 lead submissions per IP per hour.
// Protects Resend quota and Mailchimp list from bot spam under paid traffic.
const LEAD_RATE_MAP = new Map();    // in-memory fallback
const LEAD_RATE_LIMIT = parseInt(process.env.LEAD_RATE_LIMIT || '5', 10);
const HOUR_MS = 3_600_000;

function getLeadKV() {
  return (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ? _kv : null;
}
async function isLeadRateLimited(ip) {
  const store = getLeadKV();
  if (store) {
    try {
      const count = await store.get(`ll:${ip}`);
      if (count === null || count === undefined) return false;
      return Number(count) >= LEAD_RATE_LIMIT;
    } catch(e) { console.warn('[lead-kv] isRateLimited fallback:', e.message); }
  }
  const now = Date.now(); const entry = LEAD_RATE_MAP.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= LEAD_RATE_LIMIT;
}
async function trackLeadRequest(ip) {
  const store = getLeadKV();
  if (store) {
    try {
      const key = `ll:${ip}`; const n = await store.incr(key);
      if (n === 1) await store.expire(key, 3600); return;
    } catch(e) { console.warn('[lead-kv] trackRequest fallback:', e.message); }
  }
  const now = Date.now(); const entry = LEAD_RATE_MAP.get(ip);
  if (!entry || now > entry.resetAt) LEAD_RATE_MAP.set(ip, { count: 1, resetAt: now + HOUR_MS });
  else entry.count++;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (await isLeadRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions from this connection. Try again later.' });
  }
  await trackLeadRequest(ip);

  const body = req.body || {};
  const {
    email, goal, role,
    score, subs, tier, nextTier, normalisedUrl, attribution,
    profile,                                                     // { firstName, headline, companyName, pictureUrl, ... }
    executiveSummary, dimensionCommentary, moves, tierRoadmap,   // Claude analysis payload
    press, contentIdeas, writingIdeas, videoIdeas, pressTargets, // press hits + content/PR ideas (optional)
    platforms, googleRanking,                                    // multi-platform presence + Google name-position
    intent,                                                      // "email" | "walkthrough" - which CTA was clicked at score reveal
    metaCapi,                                                    // { eventId, sourceUrl, userAgent, fbp, fbc } - CAPI deduplication payload
    gaConsent                                                    // "granted" | "denied" - if denied, mirror lead_captured to GA4 server-side
  } = body;
  // Locale signal from the audit submission. Only 'de' is recognized;
  // anything else falls back to 'en' so the live English flow is the default.
  const lang = (body.lang === 'de' ? 'de' : 'en');

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Please provide a valid email.' });
  }

  // ── 1) Build the PDF ──
  let pdfBase64 = null;
  let pdfError  = null;   // surfaced in the response for browser-side debugging
  try {
    const pdfBytes = await buildReportPDF({
      lang,                                                         // 'en' | 'de' — drives the static-label map in lib/buildReport.js
      firstName:           profile?.firstName  || '',
      headline:            profile?.headline   || '',
      companyName:         profile?.companyName || '',
      pictureUrl:          profile?.pictureUrl || '',
      total:               typeof score === 'number' ? score : 0,
      subs:                subs || {},
      tier:                tier || null,
      nextTier:            nextTier || null,
      executiveSummary:    executiveSummary || '',
      dimensionCommentary: dimensionCommentary || {},
      moves:               Array.isArray(moves) ? moves : [],
      tierRoadmap:         Array.isArray(tierRoadmap) ? tierRoadmap : [],
      // Press hits + content/PR ideas (optional, rendered only when present)
      press:               press        || { count: 0, outlets: [], hits: [] },
      contentIdeas:        Array.isArray(contentIdeas) ? contentIdeas : [],
      writingIdeas:        Array.isArray(writingIdeas) ? writingIdeas : [],
      videoIdeas:          Array.isArray(videoIdeas)   ? videoIdeas   : [],
      pressTargets:        Array.isArray(pressTargets) ? pressTargets : [],
      platforms:           platforms    || {},
      googleRanking:       googleRanking || null
    });
    pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  } catch (err) {
    pdfError = (err?.message || String(err)).slice(0, 600);
    console.error('PDF stack:', err?.stack || err);
    console.error('PDF build failed:', err);
    // Page Yentl - PDF builder is a load-bearing piece of the magnet. Failure = lead gets no report.
    notifyOps({
      category: 'pdf-build-failed',
      subject:  '🚨 Visibility Index: PDF generation crashed',
      body:     `pdf-lib threw during buildReportPDF. Lead got an empty download.\n\n${err?.stack || err?.message || String(err)}`,
      context:  { email, firstName: profile?.firstName, score, tier: tier?.name }
    }).catch(() => {});
    // We continue - Mailchimp upsert still happens, frontend still gets a success path
  }

  // ── 2) Email via Resend (with PDF attached if we have it) ──
  // Diagnostic object surfaced in the JSON response so we can debug from the browser
  // without log-diving. Each step writes its outcome here.
  const emailDebug = {
    pdfBuilt:        !!pdfBase64,
    apiKeyPresent:   !!process.env.RESEND_API_KEY,
    fromUsed:        process.env.RESEND_FROM || 'Visibility Index <hello@vonpeach.com>',
    fromEnvSet:      !!process.env.RESEND_FROM,
    resendStatus:    null,
    resendBody:      null,
    resendError:     null,
    skipReason:      null
  };
  let emailDelivered = false;
  // Run Resend / Mailchimp / Meta CAPI in parallel — they're independent
  // vendors and previously ran serial-await, costing ~300ms per submission.
  // Slack still runs after this batch because it reports their results.
  const emailP = (async () => {
  if (!process.env.RESEND_API_KEY) {
    emailDebug.skipReason = 'resend-api-key-missing';
  } else {
    // Send the email regardless of PDF outcome.
    // - If PDF was built → attach it (normal path)
    // - If PDF failed   → send a degraded email saying "we'll follow up with the PDF" so
    //                       the lead at least gets a confirmation and isn't left hanging.
    try {
      const fromAddress = emailDebug.fromUsed;
      const firstName   = profile?.firstName || '';
      const tierName    = tier?.name || (lang === 'de' ? 'Ihr Tier' : 'your tier');
      const subject     = lang === 'de'
        ? `${firstName ? firstName + ', I' : 'I'}hr Visibility Index Report`
        : `${firstName ? firstName + ', y' : 'Y'}our Visibility Index report`;

      const payload = {
        from:    fromAddress,
        to:      [email],
        subject: subject,
        html:    buildEmailHTML({ firstName, total: score, tierName, hasPdf: !!pdfBase64, lang })
      };
      if (pdfBase64) {
        payload.attachments = [{
          filename: `visibility-index-report${firstName ? '-' + slug(firstName) : ''}.pdf`,
          content:  pdfBase64
        }];
      }

      const resendRes = await fetch(RESEND_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      emailDebug.resendStatus = resendRes.status;
      emailDelivered = resendRes.ok;
      if (!resendRes.ok) {
        const errText = await resendRes.text().catch(() => '');
        emailDebug.resendBody = errText.slice(0, 400);
        console.error('Resend failed:', resendRes.status, errText);
        notifyOps({
          category: 'resend-failed',
          subject:  '🚨 Visibility Index: report email NOT delivered',
          body:     `Resend rejected the send. Lead won't receive the PDF.\n\nStatus: ${resendRes.status}\nBody: ${errText.slice(0, 400)}\nFrom: ${fromAddress}\n\nCommon causes:\n • Domain not verified on Resend\n • RESEND_FROM uses an address not on the verified domain\n • Free tier 100/day limit hit\n • API key revoked/rotated`,
          context:  { lead: email, from: fromAddress, status: resendRes.status }
        }).catch(() => {});
      } else {
        // Capture the message id so we can look it up in Resend → Logs if delivery fails downstream
        try {
          const okBody = await resendRes.json().catch(() => ({}));
          emailDebug.resendBody = okBody.id ? `id=${okBody.id}` : null;
        } catch {}
      }
    } catch (err) {
      emailDebug.resendError = err?.message || String(err);
      console.error('Resend error:', err);
      notifyOps({
        category: 'resend-crash',
        subject:  '🚨 Visibility Index: Resend call crashed',
        body:     `Threw before getting a response from Resend.\n\n${err?.stack || err?.message || String(err)}`,
        context:  { lead: email }
      }).catch(() => {});
    }
  }
  })();

  // ── 3) Mailchimp upsert (lead store + segmentation, independent of email delivery) ──
  let mailchimpOk = false;
  const SERVER   = process.env.MAILCHIMP_SERVER_PREFIX;
  const AUDIENCE = process.env.MAILCHIMP_AUDIENCE_ID;
  const KEY      = process.env.MAILCHIMP_API_KEY;
  // Diagnostic surfaced in the response - same pattern as _emailDebug
  const mcDebug = {
    serverPresent:   !!SERVER,
    audiencePresent: !!AUDIENCE,
    keyPresent:      !!KEY,
    keyPrefix:       KEY ? KEY.slice(0, 6) + '…' : null,
    server:          SERVER || null,
    audienceLen:     AUDIENCE ? AUDIENCE.length : 0,
    status:          null,
    body:            null,
    error:           null,
    skipReason:      null
  };
  const mailchimpP = (async () => {
  if (!SERVER || !AUDIENCE || !KEY) {
    const missing = [];
    if (!SERVER)   missing.push('MAILCHIMP_SERVER_PREFIX');
    if (!AUDIENCE) missing.push('MAILCHIMP_AUDIENCE_ID');
    if (!KEY)      missing.push('MAILCHIMP_API_KEY');
    mcDebug.skipReason = `missing env: ${missing.join(', ')}`;
    console.warn('[lead] Mailchimp skipped:', mcDebug.skipReason);
    notifyOps({
      category: 'mailchimp-missing-env',
      subject:  '⚠️ Visibility Index: Mailchimp env vars not configured',
      body:     `A lead was captured but NOT added to Mailchimp because these env vars are missing on Vercel:\n\n${missing.join('\n')}\n\nSet them under Vercel → Project → Settings → Environment Variables → Production. Then redeploy.`,
      context:  { lead: email }
    }).catch(() => {});
  } else {
    try {
      const auth = 'Basic ' + Buffer.from(`anystring:${KEY}`).toString('base64');
      const tierName = tier?.name || '';
      const tierSlug = tierName.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, '-') || 'unknown';
      const merge_fields = {
        // Standard MC fields - populated so *|FNAME|* / *|LNAME|* work in
        // every drip email (the 48h follow-up greets by first name).
        FNAME:        String(profile?.firstName || ''),
        LNAME:        String(profile?.lastName  || ''),
        VIS_SCORE:    typeof score === 'number' ? score : 0,
        VIS_TIER:     tierName,
        VIS_GOAL:     String(goal || ''),
        VIS_LINKEDIN: String(normalisedUrl || ''),
        UTM_SOURCE:   String(attribution?.utm_source   || ''),
        UTM_CAMP:     String(attribution?.utm_campaign || ''),
        UTM_MED:      String(attribution?.utm_medium   || '')
      };
      const tags = [
        `tier:${tierSlug}`,
        ...(goal ? [`goal:${goal}`] : []),
        ...(role ? [`role:${role}`] : []),
        ...(attribution?.utm_campaign ? [`campaign:${attribution.utm_campaign}`] : [])
      ];
      const subscriberHash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
      const upsertUrl = `https://${SERVER}.api.mailchimp.com/3.0/lists/${AUDIENCE}/members/${subscriberHash}`;
      const r = await fetch(upsertUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify({
          email_address: email.trim(),
          status_if_new: 'subscribed',
          merge_fields,
          tags
        })
      });
      mcDebug.status = r.status;
      mailchimpOk = r.ok;
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        mcDebug.body = JSON.stringify(errBody).slice(0, 500);
        console.error('Mailchimp upsert failed:', r.status, errBody);
        // Common 400 cause: missing MERGE FIELDS in the audience (VIS_SCORE etc.) - Mailchimp rejects writes to undefined fields.
        notifyOps({
          category: 'mailchimp-failed',
          subject:  '⚠️ Visibility Index: Mailchimp upsert rejected',
          body:     `Lead got the email but was NOT added to Mailchimp.\n\nStatus: ${r.status}\nBody: ${JSON.stringify(errBody).slice(0, 500)}\n\nCommon causes:\n • Merge fields not added to the audience (need VIS_SCORE [Number], VIS_TIER, VIS_GOAL, VIS_LINKEDIN, UTM_SOURCE, UTM_CAMP, UTM_MED - all Text except VIS_SCORE)\n • API key tied to the wrong account\n • Audience ID belongs to a different list\n • Server prefix wrong (e.g. set us17 when account is us21)`,
          context:  { lead: email, status: r.status, server: SERVER }
        }).catch(() => {});
      } else {
        const okBody = await r.json().catch(() => ({}));
        mcDebug.body = okBody.id ? `subscriber id=${okBody.id}` : 'ok';
      }
    } catch (err) {
      mcDebug.error = err?.message || String(err);
      console.error('Mailchimp error:', err);
      notifyOps({
        category: 'mailchimp-crash',
        subject:  '🚨 Visibility Index: Mailchimp call crashed',
        body:     `Threw before getting a response from Mailchimp.\n\n${err?.stack || err?.message || String(err)}`,
        context:  { lead: email }
      }).catch(() => {});
    }
  }
  })();

  // ── Meta CAPI fires in parallel with Resend + Mailchimp; awaited collectively
  // below before Slack reports their combined status. Browser pixel still fires
  // independently — this server call is the deduped Conversions API event. ──
  let capiOk = false;
  const capiP = (async () => {
  if (process.env.META_CAPI_ACCESS_TOKEN) {
    try {
      const PIXEL_ID = process.env.META_PIXEL_ID || '1714917946519921';
      const token    = process.env.META_CAPI_ACCESS_TOKEN;
      const ip       = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

      // Hash all PII per Meta's spec (sha256 of lowercased + trimmed value).
      const hash = (v) => v ? createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined;

      const userData = {
        em:           hash(email)                     ? [hash(email)]                     : undefined,
        fn:           hash(profile?.firstName)        ? [hash(profile.firstName)]         : undefined,
        ln:           hash(profile?.lastName)         ? [hash(profile.lastName)]          : undefined,
        client_ip_address:  ip            || undefined,
        client_user_agent:  metaCapi?.userAgent || req.headers['user-agent'] || undefined,
        fbp:          metaCapi?.fbp       || undefined,
        fbc:          metaCapi?.fbc       || undefined,
        external_id:  hash(email)         || undefined
      };
      Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

      const tierName = tier?.name || '';
      const customData = {
        currency:     'EUR',
        value:        intent === 'walkthrough' ? 60 : 30,
        content_name: 'Visibility Index audit',
        content_category: tierName,
        intent:       intent || 'email',
        score:        typeof score === 'number' ? Math.round((score / 18) * 100) : null,
        tier:         tierName,
        utm_source:   String(attribution?.utm_source   || ''),
        utm_campaign: String(attribution?.utm_campaign || ''),
        utm_medium:   String(attribution?.utm_medium   || '')
      };

      const capiPayload = {
        data: [{
          event_name:    'Lead',
          event_time:    Math.floor(Date.now() / 1000),
          event_id:      metaCapi?.eventId || undefined,
          event_source_url: metaCapi?.sourceUrl || normalisedUrl || undefined,
          action_source: 'website',
          user_data:     userData,
          custom_data:   customData
        }],
        ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {})
      };

      const capiUrl = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`;
      const capiRes = await fetch(capiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capiPayload)
      });
      const capiJson = await capiRes.json().catch(() => ({}));
      capiOk = capiRes.ok && (capiJson.events_received || 0) > 0;
      if (!capiOk) {
        console.error('[CAPI] Lead event failed:', capiRes.status, JSON.stringify(capiJson).slice(0, 400));
      } else {
        console.log('[CAPI] Lead received:', capiJson.events_received, 'fbtrace_id:', capiJson.fbtrace_id);
      }
    } catch (err) {
      console.error('[CAPI] crash:', err?.message || err);
    }
  } else {
    console.warn('[CAPI] META_CAPI_ACCESS_TOKEN not set - server-side Lead event skipped (browser pixel still fires).');
  }
  })();

  // ── GA4 Measurement Protocol mirror (only when browser-side won't fire) ──
  // tracking.js boots Consent Mode v2 with analytics_storage='denied', so
  // leads from users who haven't accepted the cookie banner never reach GA4
  // standard reports. We fire the server-side equivalent ONLY for that case
  // — if consent was granted, the browser pixel already sent the event and
  // a second hit here would double-count it (GA MP has no native event_id
  // dedup like Meta CAPI). Falls back to firing when gaConsent is missing,
  // since older sessions / non-index pages may not send the flag.
  let gaMpOk = false;
  const gaMpP = (async () => {
    if (gaConsent === 'granted') return; // browser already counted it
    const result = await sendGAMpEvent({
      name:      'lead_captured',
      email,
      userAgent: metaCapi?.userAgent || req.headers['user-agent'],
      ip,
      params: {
        currency:     'EUR',
        value:        intent === 'walkthrough' ? 60 : 30,
        score:        typeof score === 'number' ? Math.round((score / 18) * 100) : 0,
        tier:         tier?.name || '',
        intent:       intent || 'email',
        role:         role || '',
        goal:         goal || '',
        utm_source:   String(attribution?.utm_source   || ''),
        utm_medium:   String(attribution?.utm_medium   || ''),
        utm_campaign: String(attribution?.utm_campaign || ''),
        // Mirror the same event_id Meta CAPI uses, so we can correlate the
        // two streams when reconciling numbers across GA / Meta.
        event_id:     metaCapi?.eventId || ''
      }
    });
    gaMpOk = result.ok;
  })();

  // ── Wait for the parallel batch (Resend + Mailchimp + Meta CAPI + GA MP)
  // before notifying Slack, which reports their combined status. ──
  await Promise.allSettled([emailP, mailchimpP, capiP, gaMpP]);

  // ── Slack notification - every captured lead ──
  // Set SLACK_WEBHOOK_URL on Vercel (Incoming Webhook from a Slack app) to enable.
  // Fire-and-forget; never blocks the response.
  let slackNotified = false;
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const display = typeof score === 'number' ? Math.round((score / 18) * 100) : null;
      const tierName = tier?.name || 'unknown tier';
      const profileName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || '(no name)';
      const profileHeadline = profile?.headline || '';
      const company = profile?.companyName || '';
      const linkedin = normalisedUrl ? `https://www.${normalisedUrl}/` : '';
      const utm = attribution?.utm_campaign ? `${attribution.utm_source || '?'}/${attribution.utm_campaign}` : 'direct';

      // Hot leads (asked for the walkthrough) get a 🔥 prefix so they're impossible
      // to miss in a busy Slack channel - prioritise outreach to these first.
      const isWalkthrough = intent === 'walkthrough';
      const heroPrefix    = isWalkthrough ? '🔥' : '🎯';
      const intentLabel   = isWalkthrough ? '*Walkthrough requested* — Calendly opened in their browser' : 'PDF only';

      const slackPayload = {
        text: `${heroPrefix} ${isWalkthrough ? 'HOT LEAD - walkthrough requested' : 'New Visibility Index lead'}: ${profileName} (${email})`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `${heroPrefix} ${isWalkthrough ? 'HOT LEAD' : 'New lead'}: ${profileName}` }
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: intentLabel }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Email*\n${email}` },
              { type: 'mrkdwn', text: `*Score*\n${display !== null ? display + ' / 100' : 'n/a'}` },
              { type: 'mrkdwn', text: `*Tier*\n${tierName}` },
              { type: 'mrkdwn', text: `*Role / Goal*\n${role || '?'} / ${goal || '?'}` },
              { type: 'mrkdwn', text: `*Company*\n${company || '_unknown_'}` },
              { type: 'mrkdwn', text: `*Source*\n${utm}` }
            ]
          },
          ...(profileHeadline ? [{
            type: 'section',
            text: { type: 'mrkdwn', text: `*Headline*\n_${profileHeadline}_` }
          }] : []),
          ...(linkedin ? [{
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `<${linkedin}|View LinkedIn profile>` }]
          }] : []),
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `Email delivered: ${emailDelivered ? '✅' : '❌'} · Mailchimp: ${mailchimpOk ? '✅' : '❌'} · PDF: ${pdfBase64 ? '✅' : '❌'}`
            }]
          }
        ]
      };

      const slackRes = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload)
      });
      slackNotified = slackRes.ok;
      if (!slackRes.ok) {
        const txt = await slackRes.text().catch(() => '');
        console.error('Slack webhook failed:', slackRes.status, txt.slice(0, 200));
      }
    } catch (err) {
      console.error('Slack notify error:', err);
    }
  }

  // ── Upsert the Notion audit row (status: email_submitted) ──
  // Fire-and-forget; never blocks the response. If no row exists for this
  // LinkedIn URL (e.g. /api/score logging skipped), the helper creates one.
  upsertAuditOnLead({
    linkedinUrl: normalisedUrl ? `https://www.${normalisedUrl}/` : null,
    firstName:   profile?.firstName || '',
    lastName:    profile?.lastName  || '',
    headline:    profile?.headline  || '',
    company:     profile?.companyName || '',
    score:       typeof score === 'number' ? Math.round((score / 18) * 100) : null,
    composite:   typeof score === 'number' ? score : null,
    tier:        tier?.name || '',
    email:       email,
    role:        role || '',
    goal:        goal || '',
    utmSource:   attribution?.utm_source   || '',
    utmCampaign: attribution?.utm_campaign || '',
    clickId:     attribution?.fbclid || attribution?.gclid || '',
    notes:       intent === 'walkthrough' ? 'Picked walkthrough CTA' : ''
  }).catch(() => {});

  // ── 7) Return success - frontend uses pdf base64 for instant download ──
  return res.status(200).json({
    ok:             true,
    emailDelivered: emailDelivered,
    mailchimpOk:    mailchimpOk,
    slackNotified:  slackNotified,
    capiOk:         capiOk,
    gaMpOk:         gaMpOk,
    pdf:            pdfBase64,    // null if PDF build failed
    _pdfError:      pdfError,
    _emailDebug:    emailDebug,
    _mcDebug:       mcDebug
  });
}

/* ───────────── helpers ───────────── */

function buildEmailHTML({ firstName, total, tierName, hasPdf, lang = 'en' }) {
  const isDe     = lang === 'de';
  const safeName = escapeHtml(firstName || (isDe ? 'zusammen' : 'there'));
  const display  = typeof total === 'number' ? Math.round((total / 18) * 100) : null;
  const tier     = escapeHtml(tierName || (isDe ? 'Ihr Tier' : 'your tier'));
  const tierKey  = (tierName || '').toLowerCase();

  // Localized chrome + tier-aware playful body copy. Honest about where they
  // are, generous about where they're going. Match the existing English voice
  // in German (formal Sie, Swiss "ss" not "ß"). German strings are DRAFT —
  // pending native-speaker review per the project rule.
  const T = isDe ? {
    title:        'Ihr Visibility Index Report',
    eyebrow:      'Von Peach &middot; FutureMakers &middot; Der Visibility Index',
    greeting:     `Hallo ${safeName} &mdash;`,
    yourIndex:    'Ihr Visibility Index',
    auditReady:   'Ihr Audit ist bereit.',
    hiddenGem:    'Sie sind im Moment nahezu unsichtbar &ndash; und das heißt: Alles liegt noch vor Ihnen. Die gute Nachricht: Die Grundlagen sind der einfachste Teil.',
    risingVoice:  'Sie haben etwas zu sagen. Ihre Marke verstärkt es nur noch nicht. Drei kleine Schritte, und Sie spüren, wie sich etwas bewegt.',
    emerging:     'Sie machen schon mehr richtig als die meisten. Jetzt geht es um Konsistenz &ndash; damit aus Aufwand Anerkennung wird.',
    recognised:   'Sie haben echte Autorität aufgebaut. Zeit, die Handschrift zu schärfen und sie auf Legacy-Niveau zu heben.',
    defaultCopy:  'Sie sind auf dem richtigen Weg. Drei Schritte stehen zwischen dem, wo Sie sind, und dem, wo Sie hinwollen.',
    ledeHasPdf:   'Ihr vollständiger Audit ist soeben in Ihrem Posteingang gelandet. Eine lohnenswerte Lektüre &ndash; nehmen Sie sich zehn Minuten, wenn Sie können.',
    ledeNoPdf:    'Bei uns gab es einen kleinen Schluckauf &ndash; das PDF ist unterwegs. Ihr Ergebnis sehen Sie unten.',
    ctaText:      'Lassen Sie uns darüber sprechen',
    ctaCaption:   '15 Minuten. Kein Verkaufsgespräch. Wir gehen Ihren Audit gemeinsam durch.',
    footer:       'Von Peach GmbH &middot; FutureMakers &middot; 2026',
    repliesPre:   'Antworten willkommen &mdash;'
  } : {
    title:        'Your Visibility Index Report',
    eyebrow:      'Von Peach &middot; FutureMakers &middot; The Visibility Index',
    greeting:     `Hey ${safeName} &mdash;`,
    yourIndex:    'Your Visibility Index',
    auditReady:   'Your audit is ready.',
    hiddenGem:    "You're nearly invisible right now - and that means everything is ahead of you. The good news: foundations are the easiest part.",
    risingVoice:  "You've got something to say. Your brand just isn't amplifying it yet. Three small moves and you'll feel it shift.",
    emerging:     "You're already doing more right than most. Now it's about consistency - turning effort into recognition.",
    recognised:   "You've built real authority. Time to sharpen the signature and make it legacy-level.",
    defaultCopy:  "You're on your way. Three moves stand between where you are and where you're headed.",
    ledeHasPdf:   'Your full audit just landed in your inbox. Big read inside - take ten minutes when you can.',
    ledeNoPdf:    'Tiny hiccup on our side - the PDF is on the way. Your headline is below.',
    ctaText:      "Let's talk it through",
    ctaCaption:   "15 minutes. No pitch. We'll walk through your audit together.",
    footer:       'Von Peach GmbH &middot; FutureMakers &middot; 2026',
    repliesPre:   'Replies welcome &mdash;'
  };

  const tierCopy =
    /hidden gem/.test(tierKey)           ? T.hiddenGem
    : /rising voice/.test(tierKey)       ? T.risingVoice
    : /emerging authority/.test(tierKey) ? T.emerging
    : /recognised leader/.test(tierKey)  ? T.recognised
    : T.defaultCopy;

  const lede = hasPdf ? T.ledeHasPdf : T.ledeNoPdf;

  // Indigo-to-lavender hero gradient + cream content. Dark navy outer (won't get inverted by
  // dark-mode email clients). Inline styles only - email clients strip <style> blocks.
  return `<!DOCTYPE html>
<html lang="${isDe ? 'de' : 'en'}">
<head><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${T.title}</title></head>
<body style="margin:0;padding:0;background:#0B0359;font-family:Helvetica,Arial,sans-serif;color:#0c0b09;line-height:1.55;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Brand eyebrow on dark -->
    <p style="color:#A6A4ED;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 24px;text-align:center;">
      ${T.eyebrow}
    </p>

    <!-- Hero card with score -->
    <div style="background:linear-gradient(160deg,#3F36B2 0%,#5A50CC 60%,#8683E5 100%);border-radius:24px 24px 0 0;padding:40px 36px 36px;text-align:center;color:#fafafa;">
      <p style="font-size:14px;font-weight:600;letter-spacing:0.04em;margin:0 0 18px;opacity:0.9;">
        ${T.greeting}
      </p>
      ${display !== null ? `
        <p style="font-size:13px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;margin:0 0 8px;color:#EBF0FF;opacity:0.75;">
          ${T.yourIndex}
        </p>
        <p style="margin:0;line-height:1;">
          <span style="font-size:88px;font-weight:900;letter-spacing:-0.04em;color:#fafafa;">${display}</span>
          <span style="font-size:24px;font-weight:600;color:#EBF0FF;opacity:0.7;margin-left:6px;">/ 100</span>
        </p>
        <p style="font-size:22px;font-weight:700;letter-spacing:-0.02em;margin:18px 0 0;color:#fafafa;">
          ${tier}
        </p>
      ` : `
        <p style="font-size:32px;font-weight:700;margin:0;color:#fafafa;">
          ${T.auditReady}
        </p>
      `}
    </div>

    <!-- Cream body card (continues seamlessly from hero) -->
    <div style="background:#fafafa;border-radius:0 0 24px 24px;padding:36px 36px 32px;">

      <p style="font-size:18px;line-height:1.45;margin:0 0 18px;color:#0c0b09;font-weight:500;">
        ${tierCopy}
      </p>

      <p style="font-size:15px;line-height:1.55;color:#444;margin:0 0 28px;">
        ${lede}
      </p>

      <!-- CTA pill -->
      <div style="text-align:center;margin:32px 0 12px;">
        <a href="https://calendly.com/yentl-spiteri/15-min-intro?utm_source=email&utm_medium=report-delivery&utm_campaign=audit-followup"
           style="display:inline-block;background:#0c0b09;color:#fafafa;padding:18px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.04em;text-transform:uppercase;">
          ${T.ctaText}
        </a>
      </div>

      <p style="font-size:13px;color:#666;margin:14px 0 0;text-align:center;font-style:italic;">
        ${T.ctaCaption}
      </p>
    </div>

    <!-- Outer footer on dark -->
    <p style="font-size:10px;color:#A6A4ED;letter-spacing:0.16em;text-transform:uppercase;margin:32px 0 8px;text-align:center;opacity:0.7;">
      ${T.footer}
    </p>
    <p style="font-size:11px;color:#A6A4ED;margin:0;text-align:center;opacity:0.6;">
      ${T.repliesPre} <a href="mailto:hello@vonpeach.com" style="color:#EBF0FF;text-decoration:underline;">hello@vonpeach.com</a>
    </p>
  </div>
</body>
</html>`;
}

function slug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
