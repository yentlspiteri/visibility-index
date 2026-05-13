/**
 * POST /api/manager/snapshot  { memberId, total, subs, tier }
 *
 * Called by the dashboard after the browser successfully runs /api/score
 * against a team member's LinkedIn URL. We persist the result as a snapshot
 * for the current ISO week. Upserts on (team_member_id, week_of) so a re-run
 * the same week overwrites rather than duplicates.
 */

import { requireManager } from '../../lib/auth.js';
import { ensureSchema, sql, newId, weekOf } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  const memberId = String(req.body?.memberId || '');
  const total    = Number(req.body?.total);
  const subs     = req.body?.subs;
  const tier     = String(req.body?.tier || '');
  if (!memberId || !Number.isFinite(total) || !subs || typeof subs !== 'object') {
    return res.status(400).json({ error: 'memberId, total and subs are required.' });
  }

  // Ownership check — never let manager A write to manager B's member.
  const { rows: owned } = await sql`
    SELECT id FROM team_member WHERE id = ${memberId} AND manager_id = ${manager.id}`;
  if (!owned.length) return res.status(404).json({ error: 'Member not found.' });

  const week = weekOf();
  const id   = newId();
  await sql`
    INSERT INTO score_snapshot (id, team_member_id, week_of, total, sub_scores, tier)
    VALUES (${id}, ${memberId}, ${week}, ${total}, ${JSON.stringify(subs)}::jsonb, ${tier})
    ON CONFLICT (team_member_id, week_of) DO UPDATE
      SET total = EXCLUDED.total,
          sub_scores = EXCLUDED.sub_scores,
          tier = EXCLUDED.tier,
          captured_at = NOW()`;
  return res.status(200).json({ ok: true, week_of: week });
}
