/**
 * POST /api/manager/magic-link  { email }
 * Sends a sign-in link via Resend. Always returns 200 (avoid leaking which
 * emails exist). Rate-limited in-memory per IP.
 */

import { createMagicLink, sendMagicLink, getOrCreateManager } from '../../lib/auth.js';
import { upsertManager as mailchimpUpsertManager } from '../../lib/mailchimp-manager.js';

const RATE = new Map();
const HOUR = 3_600_000;
const MAX_PER_HOUR = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const entry = RATE.get(ip);
  if (entry && now < entry.resetAt && entry.count >= MAX_PER_HOUR) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again in an hour.' });
  }
  if (!entry || now >= entry.resetAt) RATE.set(ip, { count: 1, resetAt: now + HOUR });
  else entry.count++;

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    const manager = await getOrCreateManager(email);
    const token = await createMagicLink(email);
    const host = `https://${req.headers.host}`;
    const link = `${host}/api/manager/auth?token=${token}`;
    await sendMagicLink(email, link);
    // Fire-and-forget Mailchimp upsert with team-audit-manager tag. Only on
    // first sign-up — but we don't track "first time" precisely; the upsert
    // is idempotent so we just always call it.
    mailchimpUpsertManager(email).catch(() => {});
    return res.status(200).json({ ok: true, managerId: manager.id });
  } catch (err) {
    console.error('[manager/magic-link]', err);
    return res.status(500).json({ error: 'Could not send sign-in email. Try again shortly.' });
  }
}
