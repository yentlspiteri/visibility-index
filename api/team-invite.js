/**
 * /api/team-invite — public endpoint for the self-invite flow.
 *
 * GET  ?token=...            → returns { manager_email, seatCap, seatsUsed }
 *                              so the page can show "X invited you" and
 *                              tell the visitor if the team is already full.
 *
 * POST { token, linkedin_url, display_name?, member_email?, track? }
 *                            → creates a team_member row with
 *                              consent_state='granted', source='self-invite'.
 *                              If `track` is true, tracking_enabled=true.
 *                              Fires a background rescore (fire-and-forget)
 *                              so the manager sees a score on next refresh.
 *
 * No auth required (token IS the auth). Rate-limited per IP.
 */

import { ensureSchema, sql, newId } from '../lib/db.js';

const SEAT_CAP = 10;
const RATE = new Map();
const HOUR = 3_600_000;
const MAX_PER_HOUR = 10;

function rateLimited(ip) {
  const now = Date.now();
  const entry = RATE.get(ip);
  if (entry && now < entry.resetAt && entry.count >= MAX_PER_HOUR) return true;
  if (!entry || now >= entry.resetAt) RATE.set(ip, { count: 1, resetAt: now + HOUR });
  else entry.count++;
  return false;
}

function normaliseLinkedIn(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
  const m = url.match(/^linkedin\.com\/in\/([a-z0-9\-_%]+)/i);
  return m ? `linkedin.com/in/${m[1]}` : null;
}

async function lookupManagerByToken(token) {
  if (!token) return null;
  const rows = await sql`SELECT id, email FROM manager WHERE invite_token = ${token}`;
  return rows[0] || null;
}

export default async function handler(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  await ensureSchema();

  if (req.method === 'GET') {
    const token = String(req.query?.token || '');
    const manager = await lookupManagerByToken(token);
    if (!manager) return res.status(404).json({ error: 'This invite link is not valid (or has been revoked).' });
    const countRows = await sql`SELECT COUNT(*)::int AS n FROM team_member WHERE manager_id = ${manager.id}`;
    const seatsUsed = countRows[0].n;
    return res.status(200).json({
      manager_email: manager.email,
      seatCap: SEAT_CAP,
      seatsUsed,
      seatsAvailable: Math.max(0, SEAT_CAP - seatsUsed)
    });
  }

  if (req.method === 'POST') {
    const token = String(req.body?.token || '');
    const manager = await lookupManagerByToken(token);
    if (!manager) return res.status(404).json({ error: 'This invite link is not valid (or has been revoked).' });

    const url = normaliseLinkedIn(req.body?.linkedin_url);
    if (!url) return res.status(400).json({ error: 'Please provide a valid LinkedIn profile URL.' });

    const countRows = await sql`SELECT COUNT(*)::int AS n FROM team_member WHERE manager_id = ${manager.id}`;
    const seatsUsed = countRows[0].n;
    if (seatsUsed >= SEAT_CAP) return res.status(409).json({ error: 'This team is already full.', full: true });

    // De-dupe: if the same URL already exists on this manager's team, refuse.
    const dupes = await sql`SELECT id FROM team_member WHERE manager_id = ${manager.id} AND linkedin_url = ${url}`;
    if (dupes.length) return res.status(409).json({ error: 'Someone has already added this LinkedIn profile to the team.' });

    const displayName = String(req.body?.display_name || '').trim().slice(0, 80) || null;
    const memberEmail = String(req.body?.member_email || '').trim().toLowerCase() || null;
    const track       = Boolean(req.body?.track);
    const id = newId();

    await sql`
      INSERT INTO team_member (id, manager_id, linkedin_url, display_name, member_email,
                               tracking_enabled, consent_state, source)
      VALUES (${id}, ${manager.id}, ${url}, ${displayName}, ${memberEmail},
              ${track}, 'granted', 'self-invite')`;

    // Fire-and-forget rescore so the manager sees a score on next refresh.
    // Each /api/cron/rescore-one runs in its own 60s function budget.
    const host = `https://${req.headers.host}`;
    const cronSecret = process.env.CRON_SECRET || '';
    fetch(`${host}/api/cron/rescore-one`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cronSecret}` },
      body: JSON.stringify({ memberId: id })
    }).catch(() => {});

    return res.status(200).json({ ok: true, manager_email: manager.email });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
