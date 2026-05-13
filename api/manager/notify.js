/**
 * POST /api/manager/notify  { memberId }
 * Manager-triggered opt-in email to a team member.
 * Requires team_member.member_email to be set. Generates a consent_token
 * the recipient can use to grant or decline weekly tracking.
 */

import { randomBytes } from 'node:crypto';
import { requireManager } from '../../lib/auth.js';
import { ensureSchema, sql } from '../../lib/db.js';

const RESEND_API = 'https://api.resend.com/emails';
const CONSENT_TTL_DAYS = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  const memberId = String(req.body?.memberId || '');
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const { rows } = await sql`
    SELECT id, member_email, display_name, linkedin_url
    FROM team_member WHERE id = ${memberId} AND manager_id = ${manager.id}`;
  if (!rows.length) return res.status(404).json({ error: 'Member not found.' });
  const m = rows[0];
  if (!m.member_email) return res.status(400).json({ error: 'No email on file for this member. Add one first.' });

  const token = randomBytes(24).toString('hex');
  const exp = new Date(Date.now() + CONSENT_TTL_DAYS * 86400_000).toISOString();
  await sql`INSERT INTO consent_token (token, team_member_id, expires_at) VALUES (${token}, ${m.id}, ${exp})`;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Email sender not configured.' });
  const from = process.env.RESEND_FROM_TRANSACTIONAL || 'Von Peach <hello@vonpeach.com>';
  const host = `https://${req.headers.host}`;
  const grantUrl   = `${host}/team-consent?token=${token}&action=grant`;
  const declineUrl = `${host}/team-consent?token=${token}&action=decline`;
  const who = m.display_name ? m.display_name.split(' ')[0] : 'there';

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0c0b09;max-width:540px;margin:0 auto;padding:32px 24px;line-height:1.6">
    <h2 style="color:#3F36B2;margin:0 0 16px">Hi ${who} — quick heads-up from ${manager.email}</h2>
    <p>${manager.email} is using the <strong>Von Peach Visibility Index</strong> to track their team's personal-brand strength on LinkedIn — a six-dimension score based on public signals only.</p>
    <p>They'd like to include you in a weekly check-in so they can spot which of you are improving and where the team could use support.</p>
    <p style="background:#fafafa;border-left:3px solid #3F36B2;padding:12px 16px;margin:20px 0;font-size:14px;color:#56556B">
      <strong>What gets read:</strong> public LinkedIn data + Google footprint, once a week.<br>
      <strong>Nothing private.</strong> No DMs, no clients, no inbox.
    </p>
    <p style="margin:28px 0 8px">
      <a href="${grantUrl}" style="background:#3F36B2;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;margin-right:8px">I'm in</a>
      <a href="${declineUrl}" style="background:#fff;color:#3F36B2;border:1px solid #3F36B2;padding:11px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600">No thanks</a>
    </p>
    <p style="font-size:13px;color:#56556B;margin-top:24px">Either link works once. Either way, you can change your mind later by replying to this email.</p>
  </body></html>`;

  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.member_email], subject: `${manager.email} wants to track your visibility score`, html })
  });
  if (!r.ok) {
    return res.status(502).json({ error: `Email sender rejected: ${r.status}` });
  }
  await sql`UPDATE team_member SET consent_state = 'pending', consent_sent_at = NOW() WHERE id = ${m.id}`;
  return res.status(200).json({ ok: true });
}
