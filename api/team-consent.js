/**
 * GET /api/team-consent?token=...&action=grant|decline
 * Public endpoint linked from the opt-in email. Updates consent_state and
 * redirects to /team-consent for a friendly confirmation page.
 */

import { ensureSchema, sql } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');
  const token  = String(req.query?.token || '');
  const action = String(req.query?.action || '');
  if (!token || !['grant', 'decline'].includes(action)) {
    res.setHeader('Location', '/team-consent?state=error');
    return res.status(302).end();
  }
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT team_member_id, expires_at FROM consent_token WHERE token = ${token}`;
    if (!rows.length || new Date(rows[0].expires_at).getTime() < Date.now()) {
      res.setHeader('Location', '/team-consent?state=expired');
      return res.status(302).end();
    }
    const memberId = rows[0].team_member_id;
    const newState = action === 'grant' ? 'granted' : 'declined';
    await sql`UPDATE team_member SET consent_state = ${newState} WHERE id = ${memberId}`;
    await sql`DELETE FROM consent_token WHERE token = ${token}`;
    res.setHeader('Location', `/team-consent?state=${newState}`);
    return res.status(302).end();
  } catch (err) {
    console.error('[team-consent]', err);
    res.setHeader('Location', '/team-consent?state=error');
    return res.status(302).end();
  }
}
