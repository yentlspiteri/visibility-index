/**
 * /api/manager/team
 *
 * GET    → roster + latest snapshot + sparkline series for each member.
 * POST   { members: [{ linkedin_url, display_name?, member_email? }] }
 *        → bulk add (cap 10 total per manager).
 * DELETE { id } → remove a team member (and all their snapshots).
 */

import { requireManager } from '../../lib/auth.js';
import { ensureSchema, sql, newId } from '../../lib/db.js';

const SEAT_CAP = 10;

function normaliseLinkedIn(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  url = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  url = url.replace(/\/+$/, '').toLowerCase();
  // Accept linkedin.com/in/<slug> only.
  const m = url.match(/^linkedin\.com\/in\/([a-z0-9\-_%]+)/i);
  if (!m) return null;
  return `linkedin.com/in/${m[1]}`;
}

export default async function handler(req, res) {
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  if (req.method === 'GET') {
    const { rows: members } = await sql`
      SELECT id, linkedin_url, display_name, member_email, tracking_enabled,
             consent_state, consent_sent_at, added_at
      FROM team_member WHERE manager_id = ${manager.id}
      ORDER BY added_at ASC`;
    if (!members.length) return res.status(200).json({ members: [] });

    const ids = members.map(m => m.id);
    const { rows: snapshots } = await sql`
      SELECT team_member_id, week_of, total, sub_scores, tier, captured_at
      FROM score_snapshot
      WHERE team_member_id = ANY(${ids})
      ORDER BY week_of ASC`;
    const byMember = {};
    for (const s of snapshots) {
      (byMember[s.team_member_id] = byMember[s.team_member_id] || []).push(s);
    }
    const enriched = members.map(m => {
      const series = byMember[m.id] || [];
      const latest = series[series.length - 1] || null;
      return { ...m, series, latest };
    });
    return res.status(200).json({ members: enriched, seatCap: SEAT_CAP });
  }

  if (req.method === 'POST') {
    const incoming = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!incoming.length) return res.status(400).json({ error: 'No members provided.' });

    const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM team_member WHERE manager_id = ${manager.id}`;
    const existing = countRows[0].n;
    const remaining = SEAT_CAP - existing;
    if (remaining <= 0) return res.status(400).json({ error: `You're at the ${SEAT_CAP}-seat cap.` });

    const accepted = [];
    const rejected = [];
    for (const raw of incoming.slice(0, remaining)) {
      const url = normaliseLinkedIn(raw.linkedin_url);
      if (!url) { rejected.push({ input: raw.linkedin_url, reason: 'invalid URL' }); continue; }
      const id = newId();
      const displayName = String(raw.display_name || '').trim().slice(0, 80) || null;
      const memberEmail = String(raw.member_email || '').trim().toLowerCase() || null;
      try {
        await sql`INSERT INTO team_member (id, manager_id, linkedin_url, display_name, member_email)
                  VALUES (${id}, ${manager.id}, ${url}, ${displayName}, ${memberEmail})`;
        accepted.push({ id, linkedin_url: url, display_name: displayName, member_email: memberEmail });
      } catch (err) {
        rejected.push({ input: raw.linkedin_url, reason: 'db error' });
      }
    }
    const overflow = incoming.length - remaining;
    return res.status(200).json({
      accepted,
      rejected,
      overCap: overflow > 0 ? overflow : 0,
      seatCap: SEAT_CAP,
      seatsUsed: existing + accepted.length
    });
  }

  if (req.method === 'DELETE') {
    const id = String(req.body?.id || req.query?.id || '');
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await sql`DELETE FROM team_member WHERE id = ${id} AND manager_id = ${manager.id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
