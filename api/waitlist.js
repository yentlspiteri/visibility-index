/**
 * /api/waitlist - POST { email }
 *
 * Called when a user submits their email during a capacity error
 * ("we're busy right now — ping me when it's up").
 *
 * Pipeline:
 *   1. Validate email
 *   2. Upsert into Mailchimp with tag "waitlist"
 *   3. Fire ops notification (Slack / email)
 */

import { createHash } from 'node:crypto';
import { notifyOps }  from '../lib/notify.js';

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

  // ── Ops notification (fire-and-forget) ───────────────────────────────────
  notifyOps({
    category: 'waitlist-signup',
    subject:  '🔔 Visibility Index: Waitlist signup',
    body:     `${emailClean} joined the waitlist during a capacity error.\n\nTag them "waitlist" in Mailchimp — re-engage when the scraper is back up.`,
    context:  { email: emailClean }
  }).catch(() => {});

  return res.status(200).json({ ok: true });
}
