/**
 * lib/notify.js — operational alerts for Yentl
 *
 * Fires a Resend email to OPS_EMAIL whenever the audit pipeline breaks at runtime
 * (Apify down, Claude down, Mailchimp upsert failing, etc.). Reuses the existing
 * RESEND_API_KEY env var; no new credentials needed.
 *
 * Throttling:
 *   In-memory Map keyed on `category` — same alert won't refire for THROTTLE_MS.
 *   Vercel keeps function instances warm for ~5–15 min between calls, so under
 *   a sustained outage you'll get roughly 1 email every 30 min instead of 1
 *   per visitor. Acceptable trade-off without bringing in Vercel KV.
 *
 * Usage:
 *   import { notifyOps } from '../lib/notify.js';
 *   await notifyOps({
 *     category: 'apify-hard-limit',
 *     subject:  'Visibility Index: scraper down (Apify hard limit)',
 *     body:     `Apify rejected the request: ${err.message}`,
 *     context:  { url, actor, role, goal }
 *   });
 *
 * Always fire-and-forget — never let a notify failure break the calling handler.
 */

const RESEND_API   = 'https://api.resend.com/emails';
const THROTTLE_MS  = 30 * 60 * 1000; // 30 minutes
const _lastSent    = new Map();

export async function notifyOps({ category, subject, body, context }) {
  try {
    const to        = process.env.OPS_EMAIL || 'yentl@vonpeach.com';
    const apiKey    = process.env.RESEND_API_KEY;
    const fromAddr  = process.env.RESEND_FROM || 'Von Peach Ops <onboarding@resend.dev>';
    if (!apiKey) {
      console.warn('[notifyOps] RESEND_API_KEY missing — skipping email alert.');
      return;
    }

    // Throttle: don't refire the same category within THROTTLE_MS
    const now  = Date.now();
    const last = _lastSent.get(category) || 0;
    if (now - last < THROTTLE_MS) {
      console.log(`[notifyOps] throttled (category=${category}, ${Math.round((now - last)/1000)}s since last)`);
      return;
    }
    _lastSent.set(category, now);

    // Format context as a readable kv list
    const ctxLines = context && typeof context === 'object'
      ? Object.entries(context).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">${escapeHtml(k)}</td><td style="padding:4px 0;font-family:monospace;font-size:13px;">${escapeHtml(String(v))}</td></tr>`).join('')
      : '';

    const html = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#0c0b09;background:#fafafa;padding:32px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:12px;border:1px solid rgba(15,15,15,0.08);">
    <p style="color:#3F36B2;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 12px;">VISIBILITY INDEX · OPS ALERT</p>
    <h2 style="margin:0 0 14px;font-size:20px;line-height:1.3;">${escapeHtml(subject)}</h2>
    <p style="margin:0 0 18px;font-size:15px;color:#333;white-space:pre-wrap;">${escapeHtml(body || '')}</p>
    ${ctxLines ? `<table style="border-collapse:collapse;margin:12px 0 18px;">${ctxLines}</table>` : ''}
    <p style="margin:0;font-size:12px;color:#999;">Category: <code>${escapeHtml(category)}</code> · ${new Date().toISOString()}</p>
    <p style="margin:18px 0 0;font-size:12px;color:#999;">Throttled to one email per 30 minutes per category. Subsequent failures within this window are logged but not emailed.</p>
  </div>
</body></html>`;

    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddr, to: [to], subject: `[VI Ops] ${subject}`, html })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[notifyOps] Resend failed:', r.status, txt.slice(0, 200));
    } else {
      console.log(`[notifyOps] alerted ${to} (category=${category})`);
    }
  } catch (err) {
    // Notify must never throw — it's the safety net, not the load-bearing wall
    console.error('[notifyOps] unexpected error:', err);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
