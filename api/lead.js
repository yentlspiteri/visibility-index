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

const RESEND_API = 'https://api.resend.com/emails';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const {
    email, goal, role,
    score, subs, tier, nextTier, normalisedUrl, attribution,
    profile,                                                     // { firstName, headline, companyName, pictureUrl, ... }
    executiveSummary, dimensionCommentary, moves, tierRoadmap,   // Claude analysis payload
    press, contentIdeas, pressTargets                            // press hits + content/PR ideas (optional)
  } = body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Please provide a valid email.' });
  }

  // ── 1) Build the PDF ──
  let pdfBase64 = null;
  let pdfError  = null;   // surfaced in the response for browser-side debugging
  try {
    const pdfBytes = await buildReportPDF({
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
      pressTargets:        Array.isArray(pressTargets) ? pressTargets : []
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
      const tierName    = tier?.name || 'your tier';
      const subject     = `${firstName ? firstName + ', y' : 'Y'}our Visibility Index report`;

      const payload = {
        from:    fromAddress,
        to:      [email],
        subject: subject,
        html:    buildEmailHTML({ firstName, total: score, tierName, hasPdf: !!pdfBase64 })
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

  // ── 4) Slack notification - every captured lead ──
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

      const slackPayload = {
        text: `🎯 New Visibility Index lead: ${profileName} (${email})`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `🎯 New lead: ${profileName}` }
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

  // ── 5) Return success - frontend uses pdf base64 for instant download ──
  return res.status(200).json({
    ok:             true,
    emailDelivered: emailDelivered,
    mailchimpOk:    mailchimpOk,
    slackNotified:  slackNotified,
    pdf:            pdfBase64,    // null if PDF build failed
    _pdfError:      pdfError,
    _emailDebug:    emailDebug,
    _mcDebug:       mcDebug
  });
}

/* ───────────── helpers ───────────── */

function buildEmailHTML({ firstName, total, tierName, hasPdf }) {
  const safeName = escapeHtml(firstName || 'there');
  const display  = typeof total === 'number' ? Math.round((total / 18) * 100) : null;
  const tier     = escapeHtml(tierName || 'your tier');

  // Tier-aware playful translation - matches the FutureMakers brand voice ("done playing small").
  // Honest about where they are, generous about where they're going. No corporate fluff.
  const tierKey  = (tierName || '').toLowerCase();
  const tierCopy =
    /hidden gem/.test(tierKey)         ? "You're nearly invisible right now - and that means everything is ahead of you. The good news: foundations are the easiest part."
    : /rising voice/.test(tierKey)     ? "You've got something to say. Your brand just isn't amplifying it yet. Three small moves and you'll feel it shift."
    : /emerging authority/.test(tierKey) ? "You're already doing more right than most. Now it's about consistency - turning effort into recognition."
    : /recognised leader/.test(tierKey)  ? "You've built real authority. Time to sharpen the signature and make it legacy-level."
    : "You're on your way. Three moves stand between where you are and where you're headed.";

  const lede = hasPdf
    ? "Your full audit just landed in your inbox. Big read inside - take ten minutes when you can."
    : "Tiny hiccup on our side - the PDF is on the way. Your headline is below.";

  // Indigo-to-lavender hero gradient + cream content. Dark navy outer (won't get inverted by
  // dark-mode email clients). Inline styles only - email clients strip <style> blocks.
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>Your Visibility Index Report</title></head>
<body style="margin:0;padding:0;background:#0B0359;font-family:Helvetica,Arial,sans-serif;color:#0c0b09;line-height:1.55;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Brand eyebrow on dark -->
    <p style="color:#A6A4ED;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 24px;text-align:center;">
      Von Peach &middot; FutureMakers &middot; The Visibility Index
    </p>

    <!-- Hero card with score -->
    <div style="background:linear-gradient(160deg,#3F36B2 0%,#5A50CC 60%,#8683E5 100%);border-radius:24px 24px 0 0;padding:40px 36px 36px;text-align:center;color:#fafafa;">
      <p style="font-size:14px;font-weight:600;letter-spacing:0.04em;margin:0 0 18px;opacity:0.9;">
        Hey ${safeName} &mdash;
      </p>
      ${display !== null ? `
        <p style="font-size:13px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;margin:0 0 8px;color:#EBF0FF;opacity:0.75;">
          Your Visibility Index
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
          Your audit is ready.
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
        <a href="https://calendly.com/yentl-spiteri/30min"
           style="display:inline-block;background:#0c0b09;color:#fafafa;padding:18px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.04em;text-transform:uppercase;">
          Let's talk it through
        </a>
      </div>

      <p style="font-size:13px;color:#666;margin:14px 0 0;text-align:center;font-style:italic;">
        30 minutes. No pitch. We'll walk through your audit together.
      </p>
    </div>

    <!-- Outer footer on dark -->
    <p style="font-size:10px;color:#A6A4ED;letter-spacing:0.16em;text-transform:uppercase;margin:32px 0 8px;text-align:center;opacity:0.7;">
      Von Peach GmbH &middot; FutureMakers &middot; 2026
    </p>
    <p style="font-size:11px;color:#A6A4ED;margin:0;text-align:center;opacity:0.6;">
      Replies welcome &mdash; <a href="mailto:hello@vonpeach.com" style="color:#EBF0FF;text-decoration:underline;">hello@vonpeach.com</a>
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
