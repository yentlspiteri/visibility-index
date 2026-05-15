/**
 * /api/manager/[action] — single dispatcher for all manager endpoints.
 *
 * Consolidated into one Vercel function to stay under the Hobby-plan
 * serverless-function ceiling. The frontend keeps calling the same URLs
 * (e.g. `/api/manager/team`); Vercel routes them all here with
 * `req.query.action` set to the trailing path segment.
 *
 * Actions:
 *   magic-link  (POST)   — send sign-in email
 *   auth        (GET)    — consume magic-link token, set session cookie
 *   logout      (POST)   — clear session cookie
 *   me          (GET)    — return signed-in manager
 *   team        (GET/POST/DELETE) — roster CRUD
 *   snapshot    (POST)   — persist a /api/score result for a member
 *   tracking    (POST)   — toggle scheduled re-scoring (monthly cadence)
 *   notify      (POST)   — send opt-in email to team member
 */

import { randomBytes } from 'node:crypto';
import {
  createMagicLink, consumeMagicLink, sendMagicLink, getOrCreateManager,
  sessionCookie, clearedCookie, requireManager
} from '../../lib/auth.js';
import { upsertManager as mailchimpUpsertManager } from '../../lib/mailchimp-manager.js';
import { ensureSchema, sql, newId, periodOf } from '../../lib/db.js';
import { renderBrandedEmail, escapeHtml } from '../../lib/email-template.js';

const RESEND_API = 'https://api.resend.com/emails';
const SEAT_CAP = 10;
const CONSENT_TTL_DAYS = 30;

const MAGIC_RATE = new Map();
const HOUR = 3_600_000;
const MAX_PER_HOUR = 5;

function normaliseLinkedIn(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
  const m = url.match(/^linkedin\.com\/in\/([a-z0-9\-_%]+)/i);
  return m ? `linkedin.com/in/${m[1]}` : null;
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '');

  if (action === 'magic-link')  return magicLink(req, res);
  if (action === 'auth')        return authConsume(req, res);
  if (action === 'logout')      return logout(req, res);
  if (action === 'me')          return me(req, res);
  if (action === 'team')        return team(req, res);
  if (action === 'snapshot')    return snapshot(req, res);
  if (action === 'tracking')    return tracking(req, res);
  if (action === 'notify')      return notify(req, res);
  return res.status(404).json({ error: `Unknown manager action: ${action}` });
}

/* ─────────── magic-link ─────────── */
async function magicLink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const entry = MAGIC_RATE.get(ip);
  if (entry && now < entry.resetAt && entry.count >= MAX_PER_HOUR) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again in an hour.' });
  }
  if (!entry || now >= entry.resetAt) MAGIC_RATE.set(ip, { count: 1, resetAt: now + HOUR });
  else entry.count++;

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  try {
    const manager = await getOrCreateManager(email);
    const token = await createMagicLink(email);
    const link = `https://${req.headers.host}/api/manager/auth?token=${token}`;
    await sendMagicLink(email, link);
    mailchimpUpsertManager(email).catch(() => {});
    return res.status(200).json({ ok: true, managerId: manager.id });
  } catch (err) {
    console.error('[manager/magic-link]', err);
    return res.status(500).json({ error: 'Could not send sign-in email. Try again shortly.' });
  }
}

/* ─────────── auth (consume magic link) ─────────── */
async function authConsume(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');
  const token = String(req.query?.token || '');
  if (!token) return res.status(400).end('Missing token');
  try {
    const email = await consumeMagicLink(token);
    if (!email) { res.setHeader('Location', '/team-audit?err=link'); return res.status(302).end(); }
    const manager = await getOrCreateManager(email);
    res.setHeader('Set-Cookie', sessionCookie(manager.id));
    res.setHeader('Location', '/team-dashboard');
    return res.status(302).end();
  } catch (err) {
    console.error('[manager/auth]', err);
    res.setHeader('Set-Cookie', clearedCookie());
    res.setHeader('Location', '/team-audit?err=server');
    return res.status(302).end();
  }
}

async function logout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Set-Cookie', clearedCookie());
  return res.status(200).json({ ok: true });
}

async function me(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  return res.status(200).json({ id: manager.id, email: manager.email });
}

/* ─────────── team (GET / POST / DELETE) ─────────── */
async function team(req, res) {
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  if (req.method === 'GET') {
    const members = await sql`
      SELECT id, linkedin_url, display_name, member_email, tracking_enabled,
             consent_state, consent_sent_at, added_at
      FROM team_member WHERE manager_id = ${manager.id}
      ORDER BY added_at ASC`;
    if (!members.length) return res.status(200).json({ members: [], seatCap: SEAT_CAP });
    const ids = members.map(m => m.id);
    // postgres package: `IN ${sql(arr)}` expands a JS array into a SQL list
    // (works for any non-empty array of scalars).
    const snapshots = await sql`
      SELECT team_member_id, week_of, total, sub_scores, tier, captured_at
      FROM score_snapshot
      WHERE team_member_id IN ${sql(ids)}
      ORDER BY week_of ASC`;
    const byMember = {};
    for (const s of snapshots) (byMember[s.team_member_id] = byMember[s.team_member_id] || []).push(s);
    const enriched = members.map(m => {
      const series = byMember[m.id] || [];
      return { ...m, series, latest: series[series.length - 1] || null };
    });
    return res.status(200).json({ members: enriched, seatCap: SEAT_CAP });
  }

  if (req.method === 'POST') {
    const incoming = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!incoming.length) return res.status(400).json({ error: 'No members provided.' });
    const countRows = await sql`SELECT COUNT(*)::int AS n FROM team_member WHERE manager_id = ${manager.id}`;
    const existing = countRows[0].n;
    const remaining = SEAT_CAP - existing;
    if (remaining <= 0) return res.status(400).json({ error: `You're at the ${SEAT_CAP}-seat cap.` });

    const accepted = [], rejected = [];
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
      } catch {
        rejected.push({ input: raw.linkedin_url, reason: 'db error' });
      }
    }
    const overflow = incoming.length - remaining;
    return res.status(200).json({
      accepted, rejected,
      overCap: overflow > 0 ? overflow : 0,
      seatCap: SEAT_CAP, seatsUsed: existing + accepted.length
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

/* ─────────── snapshot ─────────── */
async function snapshot(req, res) {
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
  const owned = await sql`
    SELECT id FROM team_member WHERE id = ${memberId} AND manager_id = ${manager.id}`;
  if (!owned.length) return res.status(404).json({ error: 'Member not found.' });

  const period = periodOf();
  await sql`
    INSERT INTO score_snapshot (id, team_member_id, week_of, total, sub_scores, tier)
    VALUES (${newId()}, ${memberId}, ${period}, ${total}, ${JSON.stringify(subs)}::jsonb, ${tier})
    ON CONFLICT (team_member_id, week_of) DO UPDATE
      SET total = EXCLUDED.total, sub_scores = EXCLUDED.sub_scores, tier = EXCLUDED.tier, captured_at = NOW()`;
  return res.status(200).json({ ok: true, period });
}

/* ─────────── tracking ─────────── */
async function tracking(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();
  const memberId = String(req.body?.memberId || '');
  const enabled  = Boolean(req.body?.enabled);
  if (!memberId) return res.status(400).json({ error: 'memberId required' });
  const result = await sql`
    UPDATE team_member SET tracking_enabled = ${enabled}
    WHERE id = ${memberId} AND manager_id = ${manager.id}`;
  if (!result.count) return res.status(404).json({ error: 'Member not found.' });
  return res.status(200).json({ ok: true, tracking_enabled: enabled });
}

/* ─────────── notify (opt-in email) ─────────── */
async function notify(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  await ensureSchema();

  const memberId = String(req.body?.memberId || '');
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const rows = await sql`
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
  const grantUrl   = `${host}/api/team-consent?token=${token}&action=grant`;
  const declineUrl = `${host}/api/team-consent?token=${token}&action=decline`;
  const who = m.display_name ? m.display_name.split(' ')[0] : 'there';

  const safeManager = escapeHtml(manager.email);
  const safeWho     = escapeHtml(who);
  const html = renderBrandedEmail({
    title: 'A team visibility check-in',
    heroEyebrow: 'Team visibility · opt-in',
    heroHeadline: `Hi ${safeWho} — a quick heads-up.`,
    bodyHtml: `
      <p style="font-size:17px;line-height:1.55;margin:0 0 18px;color:#0c0b09;">
        <strong>${safeManager}</strong> is using the Von Peach <em>Visibility Index</em> to track their team's personal-brand strength on LinkedIn — a six-dimension score based on <strong>public signals only</strong>.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#444;margin:0 0 22px;">
        They'd like to include you in a periodic check-in so they can spot who's improving, and where there might be room to support each other.
      </p>
      <div style="background:#f1efff;border-left:3px solid #3F36B2;padding:16px 18px;margin:22px 0 28px;border-radius:0 8px 8px 0;">
        <p style="font-size:14px;line-height:1.55;color:#0c0b09;margin:0 0 6px;"><strong>What gets read:</strong> your public LinkedIn profile + Google footprint. A handful of times a year.</p>
        <p style="font-size:14px;line-height:1.55;color:#0c0b09;margin:0;"><strong>Nothing private.</strong> No DMs, no clients, no inbox. We never log in as you.</p>
      </div>
      <p style="text-align:center;margin:24px 0 8px;">
        <a href="${grantUrl}" style="display:inline-block;background:#0c0b09;color:#fafafa;padding:16px 28px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;margin:0 6px 8px;">I'm in</a>
        <a href="${declineUrl}" style="display:inline-block;background:#fafafa;color:#0c0b09;border:1.5px solid #0c0b09;padding:14.5px 28px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;margin:0 6px 8px;">No thanks</a>
      </p>`,
    bodyFootnote: 'Either link works once. You can change your mind any time by replying to this email.'
  });

  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.member_email], subject: `${manager.email} wants to track your visibility score`, html })
  });
  if (!r.ok) return res.status(502).json({ error: `Email sender rejected: ${r.status}` });
  await sql`UPDATE team_member SET consent_state = 'pending', consent_sent_at = NOW() WHERE id = ${m.id}`;
  return res.status(200).json({ ok: true });
}
