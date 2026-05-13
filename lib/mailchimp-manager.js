/**
 * lib/mailchimp-manager.js — push a team-audit manager into Mailchimp.
 *
 * Tags them with "team-audit-manager" so they can be segmented from regular
 * single-URL audit leads. Fire-and-forget, never throws — mirrors the
 * pattern in api/lead.js.
 */

import { createHash } from 'node:crypto';
import { notifyOps } from './notify.js';

export async function upsertManager(email) {
  const SERVER   = process.env.MAILCHIMP_SERVER_PREFIX;
  const AUDIENCE = process.env.MAILCHIMP_AUDIENCE_ID;
  const KEY      = process.env.MAILCHIMP_API_KEY;
  if (!SERVER || !AUDIENCE || !KEY) return { ok: false, reason: 'mailchimp-not-configured' };

  try {
    const auth = 'Basic ' + Buffer.from(`anystring:${KEY}`).toString('base64');
    const subscriberHash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
    const upsertUrl = `https://${SERVER}.api.mailchimp.com/3.0/lists/${AUDIENCE}/members/${subscriberHash}`;
    const r = await fetch(upsertUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify({
        email_address: email.trim(),
        status_if_new: 'subscribed',
        tags: ['team-audit-manager']
      })
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      notifyOps({
        category: 'mailchimp-team-manager-failed',
        subject:  '⚠️ Team-audit manager not added to Mailchimp',
        body:     `Status ${r.status}: ${JSON.stringify(errBody).slice(0, 400)}`,
        context:  { email }
      }).catch(() => {});
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (err) {
    notifyOps({
      category: 'mailchimp-team-manager-crash',
      subject:  '🚨 Team-audit manager Mailchimp upsert crashed',
      body:     err?.stack || err?.message || String(err),
      context:  { email }
    }).catch(() => {});
    return { ok: false, error: err?.message };
  }
}
