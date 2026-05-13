/**
 * GET /api/manager/auth?token=...
 * Consumes a magic-link token, sets a session cookie, redirects to /team-dashboard.
 */

import { consumeMagicLink, getOrCreateManager, sessionCookie, clearedCookie } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');

  const token = String(req.query?.token || '');
  if (!token) return res.status(400).end('Missing token');

  try {
    const email = await consumeMagicLink(token);
    if (!email) {
      // Expired / used / unknown. Send them back to the lander with an error flag.
      res.setHeader('Location', '/team-audit?err=link');
      return res.status(302).end();
    }
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
