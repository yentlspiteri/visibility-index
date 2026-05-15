/**
 * lib/auth.js — magic-link auth + signed session cookies for managers.
 *
 * Sessions are stateless HMAC-signed cookies (manager_id + issued-at, signed
 * with SESSION_SECRET). No session row in the DB — keeps the schema small
 * and rotation cheap. Logout = clear cookie. Compromised secret = rotate.
 *
 * Magic-link tokens ARE stored in the DB (magic_link table) so they can be
 * single-use and revoked.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureSchema, sql, newId } from './db.js';
import { renderBrandedEmail } from './email-template.js';

const COOKIE_NAME      = 'vp_team_session';
const SESSION_TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;          // 30 min

const RESEND_API = 'https://api.resend.com/emails';

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (>= 16 chars)');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac  = b64url(createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = b64url(createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/* ─────────── magic links ─────────── */

export async function createMagicLink(email) {
  await ensureSchema();
  const token = randomBytes(24).toString('hex');
  const exp   = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
  await sql`INSERT INTO magic_link (token, email, expires_at) VALUES (${token}, ${email}, ${exp})`;
  return token;
}

export async function consumeMagicLink(token) {
  await ensureSchema();
  const rows = await sql`SELECT email, expires_at, used_at FROM magic_link WHERE token = ${token}`;
  if (!rows.length) return null;
  const row = rows[0];
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  await sql`UPDATE magic_link SET used_at = NOW() WHERE token = ${token}`;
  return row.email;
}

export async function sendMagicLink(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');
  const from = process.env.RESEND_FROM_TRANSACTIONAL || 'Von Peach <hello@vonpeach.com>';
  const html = renderBrandedEmail({
    title: 'Sign in to your team audit',
    heroEyebrow: 'Team audit · sign in',
    heroHeadline: 'Your sign-in link is&nbsp;ready.',
    bodyHtml: `
      <p style="font-size:18px;line-height:1.45;margin:0 0 18px;color:#0c0b09;font-weight:500;">
        Click the button below to open your team dashboard.
      </p>
      <p style="font-size:15px;line-height:1.55;color:#444;margin:0 0 8px;">
        This link works <strong>once</strong> and expires after <strong>30 minutes</strong>. If you didn't request this, you can safely ignore the email — no account is created until you click through.
      </p>`,
    cta: { label: 'Open dashboard', href: link },
    bodyFootnote: 'Trouble with the button? Paste this into your browser: ' + link
  });
  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: 'Sign in to your team audit', html })
  });
  if (!r.ok) throw new Error(`Resend send failed: ${r.status} ${await r.text()}`);
}

/* ─────────── manager rows + sessions ─────────── */

export async function getOrCreateManager(email) {
  await ensureSchema();
  const lower = email.toLowerCase().trim();
  const rows = await sql`SELECT id, email FROM manager WHERE email = ${lower}`;
  if (rows.length) return rows[0];
  const id = newId();
  await sql`INSERT INTO manager (id, email) VALUES (${id}, ${lower})`;
  return { id, email: lower };
}

export function sessionCookie(managerId) {
  const token = sign({ mid: managerId, exp: Date.now() + SESSION_TTL_MS });
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function getSessionFromReq(req) {
  const raw = req.headers?.cookie || '';
  const match = raw.split(/;\s*/).find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const payload = verify(token);
  return payload?.mid ? { managerId: payload.mid } : null;
}

export async function requireManager(req, res) {
  const sess = getSessionFromReq(req);
  if (!sess) { res.status(401).json({ error: 'Not signed in' }); return null; }
  await ensureSchema();
  const rows = await sql`SELECT id, email FROM manager WHERE id = ${sess.managerId}`;
  if (!rows.length) { res.status(401).json({ error: 'Session expired' }); return null; }
  return rows[0];
}

export const COOKIE = COOKIE_NAME;
