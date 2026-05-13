/**
 * POST /api/manager/tracking  { memberId, enabled }
 * Toggles weekly re-scoring for one team member.
 */

import { requireManager } from '../../lib/auth.js';
import { ensureSchema, sql } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  const memberId = String(req.body?.memberId || '');
  const enabled  = Boolean(req.body?.enabled);
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const { rowCount } = await sql`
    UPDATE team_member SET tracking_enabled = ${enabled}
    WHERE id = ${memberId} AND manager_id = ${manager.id}`;
  if (!rowCount) return res.status(404).json({ error: 'Member not found.' });
  return res.status(200).json({ ok: true, tracking_enabled: enabled });
}
