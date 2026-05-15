/**
 * /api/pv — anonymous server-side pageview backstop for GA4.
 *
 * tracking.js calls this on page load ONLY when cookie consent has been
 * declined. The browser's gtag pageview is suppressed in that case
 * (analytics_storage='denied'), so without this endpoint those visits
 * are invisible in GA reports — GA4 modeling needs ≥1000 events/day for
 * 7 days to fill the gap, which low-volume marketing pages don't hit.
 *
 * The client_id is sha256(ip + user-agent + YYYY-MM-DD). It rotates daily
 * so it behaves as a counter, not a persistent tracker — closer in spirit
 * to a server log than a cookie. No PII leaves the function.
 *
 * Fire-and-forget on the client: response is always 204, no body, no JSON.
 */

import { createHash } from 'node:crypto';
import { sendGAMpEvent } from '../lib/ga-mp.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  const body = req.body || {};
  const path        = String(body.path        || '').slice(0, 2048);
  const referrer    = String(body.referrer    || '').slice(0, 2048);
  const title       = String(body.title       || '').slice(0, 512);
  const attribution = body.attribution || {};

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // Daily-rotating anonymous identifier — same visitor counts as one user
  // per day, different user across days. No long-term cross-session ID.
  const clientId = createHash('sha256').update(`${ip}|${ua}|${day}`).digest('hex');

  // Await the MP call — on Vercel serverless, the lambda freezes the moment
  // res.end() returns, killing any in-flight fetch. Fire-and-forget here
  // causes most outbound calls to GA to be cancelled mid-flight (you'll see
  // "fetch failed" or "no outgoing requests" in function logs). The client
  // uses keepalive:true and ignores the response, so a 100-200ms wait here
  // is invisible to the user.
  await sendGAMpEvent({
    name: 'page_view',
    clientId,
    userAgent: ua,
    ip,
    params: {
      page_location: path,
      page_referrer: referrer,
      page_title:    title,
      utm_source:    String(attribution.utm_source   || ''),
      utm_medium:    String(attribution.utm_medium   || ''),
      utm_campaign:  String(attribution.utm_campaign || ''),
      utm_content:   String(attribution.utm_content  || ''),
      utm_term:      String(attribution.utm_term     || ''),
      source:        'server-pv-backstop'    // custom dim — lets you filter these out if needed
    }
  }).catch(() => {});

  return res.status(204).end();
}
