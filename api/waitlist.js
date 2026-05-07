/**
 * /api/waitlist - POST { email }
 *
 * Called when a user submits their email during a capacity error
 * ("we're busy right now — ping me when it's up").
 *
 * Pipeline:
 *   1. Validate email
 *   2. Upsert into Mailchimp with tag "waitlist"
 *   3. Schedule a Resend email +10 minutes out ("your slot is ready — come back in")
 *   4. Fire ops notification (fire-and-forget)
 */

import { createHash } from 'node:crypto';
import { notifyOps }  from '../lib/notify.js';

const RESEND_API = 'https://api.resend.com/emails';
const SITE_URL   = 'https://index.vonpeach.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const emailClean = email.trim().toLowerCase();

  // ── Mailchimp upsert with "waitlist" tag ──────────────────────────────────
  const KEY      = process.env.MAILCHIMP_API_KEY;
  const SERVER   = process.env.MAILCHIMP_SERVER_PREFIX;
  const AUDIENCE = process.env.MAILCHIMP_AUDIENCE_ID;

  if (KEY && SERVER && AUDIENCE) {
    try {
      const auth = `anystring:${KEY}`;
      const hash = createHash('md5').update(emailClean).digest('hex');
      const url  = `https://${SERVER}.api.mailchimp.com/3.0/lists/${AUDIENCE}/members/${hash}`;
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify({
          email_address: emailClean,
          status_if_new: 'subscribed',
          tags: [{ name: 'waitlist', status: 'active' }]
        })
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        console.error('[waitlist] Mailchimp error:', r.status, body);
      }
    } catch (err) {
      console.error('[waitlist] Mailchimp threw:', err?.message || err);
    }
  }

  // ── Scheduled ping: Resend email in +10 minutes ──────────────────────────
  // Resend supports `scheduled_at` (ISO 8601) so we can fire this immediately
  // and let Resend deliver it at the right time — no queue / cron needed.
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const auditUrl    = `${SITE_URL}/?ref=waitlist-ping`;
      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f3ff;font-family:Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ff;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(11,3,89,0.10);">

        <!-- Header band -->
        <tr>
          <td style="background:#0B0359;padding:24px 36px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#8683E5;">
              VON PEACH &nbsp;·&nbsp; THE VISIBILITY INDEX
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 36px 28px;">
            <h1 style="margin:0 0 12px;font-size:26px;font-weight:700;color:#0c0b09;line-height:1.25;">
              Your slot just opened.
            </h1>
            <p style="margin:0 0 20px;font-size:16px;color:#444;line-height:1.6;">
              When you tried earlier, we were running a lot of audits and couldn't take yours.
              Capacity has freed up — jump back in and we'll run your full LinkedIn visibility
              audit right now.
            </p>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#3F36B2;border-radius:10px;">
                  <a href="${auditUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">
                    Run my audit now &rarr;
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;color:#999;line-height:1.5;">
              This is a one-time message. No ongoing newsletters unless you opt in.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;border-top:1px solid #ebebf0;padding:18px 36px;">
            <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">
              Von Peach GmbH &nbsp;·&nbsp; FutureMakers &nbsp;·&nbsp;
              <a href="${SITE_URL}" style="color:#3F36B2;text-decoration:none;">vonpeach.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

      const r = await fetch(RESEND_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:         'Visibility Index <hello@vonpeach.com>',
          to:           [emailClean],
          subject:      'Your audit slot is ready — come back in',
          html,
          scheduled_at: scheduledAt
        })
      });
      if (r.ok) {
        console.log(`[waitlist] Resend ping scheduled for ${emailClean} at ${scheduledAt}`);
      } else {
        const txt = await r.text().catch(() => '');
        console.error('[waitlist] Resend schedule failed:', r.status, txt.slice(0, 200));
      }
    } catch (err) {
      console.error('[waitlist] Resend threw:', err?.message || err);
    }
  }

  // ── Ops notification (fire-and-forget) ───────────────────────────────────
  notifyOps({
    category: 'waitlist-signup',
    subject:  '🔔 Visibility Index: Waitlist signup',
    body:     `${emailClean} joined the waitlist during a capacity error.\n\nResend ping scheduled for +10 minutes.`,
    context:  { email: emailClean }
  }).catch(() => {});

  return res.status(200).json({ ok: true });
}
