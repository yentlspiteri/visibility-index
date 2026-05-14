/**
 * GA4 Measurement Protocol — server-side event delivery.
 *
 * Mirrors high-value conversion events to GA4 from the server so they're
 * recorded regardless of browser cookie consent. Used to backfill the gap
 * created by Consent Mode v2 denying analytics_storage by default in
 * tracking.js — without this, denied-consent leads never reach GA reports
 * (low-volume sites don't hit GA's 1k-events/7-day threshold for modeling).
 *
 * Required env:
 *   GA_API_SECRET     — created in GA4 admin → Data Streams → web stream →
 *                       Measurement Protocol API secrets. Treat like a token.
 *   GA_MEASUREMENT_ID — optional; defaults to G-2MKY8VPQBF (the production ID
 *                       used in tracking.js and the inline snippet in index.html).
 *
 * Identity: we hash the email and use that as both client_id and user_id.
 * That keeps the server-side stream consistent per-user, and lets GA stitch
 * cross-device when the same email returns from another browser.
 */

import { createHash } from 'node:crypto';

const GA_MP_URL = 'https://www.google-analytics.com/mp/collect';

function sha256(v) {
  return createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex');
}

/**
 * Fire a single event to GA4 via Measurement Protocol.
 * Returns { ok, status, error } — never throws; callers fire-and-forget.
 *
 * @param {object} opts
 * @param {string} opts.name        — GA4 event name (snake_case, e.g. 'lead_captured')
 * @param {string} [opts.email]     — if supplied, becomes a stable per-user client_id (sha256)
 * @param {string} [opts.clientId]  — pre-computed client_id (used for anonymous pageviews where
 *                                    we don't have an email — e.g. /api/pv passes a hash of
 *                                    ip+ua+date so it rotates daily and acts as a counter, not
 *                                    a persistent tracker). Takes precedence over `email`.
 * @param {object} [opts.params]    — event params (value, currency, custom dims, etc.)
 * @param {string} [opts.userAgent] — forwarded as `user_agent` for device/browser parsing
 * @param {string} [opts.ip]        — forwarded as `ip_override` for geo (server IP otherwise)
 */
export async function sendGAMpEvent({ name, email, clientId, params = {}, userAgent, ip }) {
  const apiSecret     = process.env.GA_API_SECRET;
  const measurementId = process.env.GA_MEASUREMENT_ID || 'G-2MKY8VPQBF';

  if (!apiSecret) {
    console.warn('[GA-MP] GA_API_SECRET not set — server-side event skipped:', name);
    return { ok: false, error: 'missing-api-secret' };
  }
  const resolvedClientId = clientId || (email ? sha256(email) : null);
  if (!name || !resolvedClientId) {
    return { ok: false, error: 'missing-name-or-client-id' };
  }

  // GA4 needs engagement_time_msec > 0 to count this as an engaged session.
  // session_id keeps server-side events grouped into the same "session" in reports.
  const eventParams = Object.assign(
    {
      engagement_time_msec: 1,
      session_id:           String(Math.floor(Date.now() / 1000))
    },
    params
  );

  // user_id is only set when the visitor is identified (we have an email).
  // For anonymous pageview backstop hits, user_id is omitted so GA doesn't
  // treat short-lived rotating ids as cross-session identities.
  const payload = {
    client_id: resolvedClientId,
    ...(email ? { user_id: resolvedClientId } : {}),
    events: [{ name, params: eventParams }],
    ...(userAgent ? { user_agent: userAgent }  : {}),
    ...(ip        ? { ip_override: ip }        : {})
  };

  const url = `${GA_MP_URL}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[GA-MP] non-2xx:', res.status, text.slice(0, 200));
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    console.log('[GA-MP] sent:', name, 'client_id=', resolvedClientId.slice(0, 10) + '…');
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[GA-MP] crash:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}
