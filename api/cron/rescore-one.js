/**
 * POST /api/cron/rescore-one  { memberId }
 *
 * Internal — invoked by weekly-rescore.js. Calls /api/score for one member's
 * LinkedIn URL and upserts a snapshot for the current ISO week. Each call
 * gets its own 60s Vercel function budget.
 */

import { ensureSchema, sql, newId, weekOf } from '../../lib/db.js';

function authed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  return header === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  await ensureSchema();

  const memberId = String(req.body?.memberId || '');
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const { rows } = await sql`SELECT id, linkedin_url FROM team_member WHERE id = ${memberId}`;
  if (!rows.length) return res.status(404).json({ error: 'Member not found' });

  const host = `https://${req.headers.host}`;
  try {
    const r = await fetch(`${host}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://' + rows[0].linkedin_url })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error || 'score failed' });

    const id = newId();
    const week = weekOf();
    await sql`
      INSERT INTO score_snapshot (id, team_member_id, week_of, total, sub_scores, tier)
      VALUES (${id}, ${memberId}, ${week}, ${j.total}, ${JSON.stringify(j.subs)}::jsonb, ${j.tier?.name || ''})
      ON CONFLICT (team_member_id, week_of) DO UPDATE
        SET total = EXCLUDED.total, sub_scores = EXCLUDED.sub_scores, tier = EXCLUDED.tier, captured_at = NOW()`;
    return res.status(200).json({ ok: true, week_of: week, total: j.total });
  } catch (err) {
    console.error('[rescore-one]', err);
    return res.status(500).json({ error: err?.message });
  }
}
