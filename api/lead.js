/**
 * /api/lead — POST { email, goal, role, score, subs, tier, ... }
 *
 * Pipeline:
 *   1. Validate email
 *   2. Build the personalised PDF (lib/buildReport.js — pdf-lib, no Chromium)
 *   3. Email it via Resend with the PDF attached
 *   4. Upsert the lead into Mailchimp with merge fields + tags (segmentation)
 *   5. Return { ok, pdf: base64 } — frontend offers instant download
 *
 * Mailchimp audience setup (one-time):
 *   Audience → Settings → Audience fields and *|MERGE|* tags
 *   Add the following tag/name pairs (all type "Text" except VIS_SCORE which is "Number"):
 *     VIS_SCORE   (Number)   — composite 0-18
 *     VIS_TIER    (Text)     — e.g. "The Rising Voice"
 *     VIS_GOAL    (Text)     — clients / speaking / credibility / legacy
 *     VIS_LINKEDIN(Text)     — normalised linkedin URL
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
    executiveSummary, dimensionCommentary, moves, tierRoadmap    // Claude analysis payload
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
      tierRoadmap:         Array.isArray(tierRoadmap) ? tierRoadmap : []
    });
    pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  } catch (err) {
    pdfError = (err?.message || String(err)).slice(0, 600);
    console.error('PDF stack:', err?.stack || err);
    console.error('PDF build failed:', err);
    // Page Yentl — PDF builder is a load-bearing piece of the magnet. Failure = lead gets no report.
    notifyOps({
      category: 'pdf-build-failed',
      subject:  '🚨 Visibility Index: PDF generation crashed',
      body:     `pdf-lib threw during buildReportPDF. Lead got an empty download.\n\n${err?.stack || err?.message || String(err)}`,
      context:  { email, firstName: profile?.firstName, score, tier: tier?.name }
    }).catch(() => {});
    // We continue — Mailchimp upsert still happens, frontend still gets a success path
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
    //   - If PDF was built → attach it (normal path)
    //   - If PDF failed   → send a degraded email saying "we'll follow up with the PDF" so
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
  if (SERVER && AUDIENCE && KEY) {
    try {
      const auth = 'Basic ' + Buffer.from(`anystring:${KEY}`).toString('base64');
      const tierName = tier?.name || '';
      const tierSlug = tierName.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, '-') || 'unknown';
      const merge_fields = {
        VIS_SCORE:   typeof score === 'number' ? score : 0,
        VIS_TIER:    tierName,
        VIS_GOAL:    String(goal || ''),
        VIS_LINKEDIN:String(normalisedUrl || ''),
        UTM_SOURCE:  String(attribution?.utm_source   || ''),
        UTM_CAMP:    String(attribution?.utm_campaign || ''),
        UTM_MED:     String(attribution?.utm_medium   || '')
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
      mailchimpOk = r.ok;
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        console.error('Mailchimp upsert failed:', r.status, errBody);
      }
    } catch (err) {
      console.error('Mailchimp error:', err);
    }
  } else {
    console.warn('Mailchimp env vars missing — skipping lead upsert.');
  }

  // ── 4) Return success — frontend uses pdf base64 for instant download ──
  return res.status(200).json({
    ok:             true,
    emailDelivered: emailDelivered,
    mailchimpOk:    mailchimpOk,
    pdf:            pdfBase64,    // null if PDF build failed
    _pdfError:      pdfError,     // first 600 chars of the PDF error message — null when PDF built fine
    _emailDebug:    emailDebug
  });
}

/* ───────────── helpers ───────────── */

function buildEmailHTML({ firstName, total, tierName, hasPdf }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  const display  = typeof total === 'number' ? Math.round((total / 18) * 100) : null;
  const score    = display !== null ? `${display} / 100` : '';
  const tier     = escapeHtml(tierName || 'your tier');
  // If the PDF failed to build server-side, send a softer message that promises a follow-up.
  const lede     = hasPdf
    ? 'Your Visibility Index report is attached.'
    : "We hit a hiccup generating your PDF. We'll email it to you within the hour.";
  const body     = hasPdf
    ? "Inside: a 4-page strategic memo on what's between your current visibility and the next level. Three specific moves to make this quarter, plus how the Von Peach team can help you action them."
    : "In the meantime, here's the headline: your score and tier are above. The full breakdown lands in your inbox shortly.";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Your Visibility Index Report</title></head>
<body style="margin:0;padding:32px;background:#fafafa;font-family:Helvetica,Arial,sans-serif;color:#0c0b09;line-height:1.55;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;padding:36px;border-radius:12px;border:1px solid rgba(15,15,15,0.08);">
    <p style="color:#3F36B2;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 14px;">VON PEACH · FUTUREMAKERS · VISIBILITY INDEX</p>
    <p style="font-size:18px;margin:0 0 18px;">${greeting}</p>
    <p style="font-size:16px;margin:0 0 14px;">${lede}</p>
    ${score ? `<p style="font-size:16px;margin:0 0 14px;">You scored <strong>${score}</strong>. That's <strong>${tier}</strong>.</p>` : ''}
    <p style="font-size:15px;color:#444;margin:0 0 22px;">${body}</p>
    <p style="margin:28px 0;">
      <a href="https://calendly.com/yentl-spiteri/30min"
         style="display:inline-block;background:#0c0b09;color:#fafafa;padding:14px 22px;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.01em;">
        Book a 30-minute call →
      </a>
    </p>
    <p style="font-size:13px;color:#666;margin:28px 0 0;">No pitch — just clarity on which moves matter most for you.</p>
    <hr style="border:0;border-top:1px solid rgba(15,15,15,0.08);margin:28px 0;">
    <p style="font-size:11px;color:#999;letter-spacing:0.05em;margin:0;">VON PEACH GMBH · FUTUREMAKERS · 2026</p>
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
