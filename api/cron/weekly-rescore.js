/**
 * GET /api/cron/weekly-rescore
 *
 * Vercel cron (Monday 09:00 UTC). Finds team_members with tracking_enabled,
 * fans out fire-and-forget HTTP requests to /api/cron/rescore-one so each
 * profile scoring lives in its own 60s function budget.
 *
 * Protected by CRON_SECRET: Vercel sends `Authorization: Bearer ${CRON_SECRET}`
 * automatically when configured. We also accept ?secret= for manual triggers.
 *
 * Skip-if-recent guard: if a snapshot already exists for this ISO week, we
 * don't re-score. Cheap idempotency for Monday-holiday reruns.
 */

import { ensureSchema, sql, weekOf } from '../../lib/db.js';

function authed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev convenience
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const query  = String(req.query?.secret || '');
  return header === expected || query === expected;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  await ensureSchema();
  const week = weekOf();

  const { rows: due } = await sql`
    SELECT tm.id, tm.linkedin_url
    FROM team_member tm
    LEFT JOIN score_snapshot ss
      ON ss.team_member_id = tm.id AND ss.week_of = ${week}
    WHERE tm.tracking_enabled = TRUE
      AND tm.consent_state IN ('granted','none')
      AND ss.id IS NULL`;

  const host = `https://${req.headers.host}`;
  const secret = process.env.CRON_SECRET || '';
  // Fire-and-forget — we don't await any of these. Each lands in its own
  // function invocation with its own 60s budget.
  for (const row of due) {
    fetch(`${host}/api/cron/rescore-one`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
      body: JSON.stringify({ memberId: row.id })
    }).catch(() => {});
  }

  // Kick the digest endpoint to run ~25 min later. Vercel doesn't have a
  // built-in delay, so we just schedule a second cron entry for the digest
  // (see vercel.json: weekly-digest runs at Mon 09:30).
  return res.status(200).json({ ok: true, queued: due.length, week });
}
