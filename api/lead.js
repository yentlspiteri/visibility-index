/**
 * /api/lead — POST { email, goal, score, subs, tier, normalisedUrl, attribution }
 *
 * Adds the lead to your Mailchimp audience with merge fields + tags so you can
 * segment by tier, goal, and ad campaign.
 *
 * Mailchimp audience setup (one-time):
 *   Audience → Settings → Audience fields and *|MERGE|* tags
 *   Add the following tag/name pairs (all type "Text" except VIS_SCORE which is "Number"):
 *     VIS_SCORE   (Number)   — composite 0-18
 *     VIS_TIER    (Text)     — e.g. "The Rising Voice"
 *     VIS_GOAL    (Text)     — clients / speaking / credibility / legacy
 *     VIS_LINKEDIN(Text)     — normalised linkedin URL
 *     UTM_SOURCE  (Text)
 *     UTM_CAMP    (Text)
 *     UTM_MED     (Text)
 *
 * Tags applied automatically: tier:<slug>, goal:<value>, campaign:<utm_campaign> (if set)
 */

import { createHash } from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { email, goal, score, tier, normalisedUrl, attribution } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Please provide a valid email.' });
  }
  if (!goal) {
    return res.status(400).json({ error: 'Please pick a goal.' });
  }

  const SERVER   = process.env.MAILCHIMP_SERVER_PREFIX;
  const AUDIENCE = process.env.MAILCHIMP_AUDIENCE_ID;
  const KEY      = process.env.MAILCHIMP_API_KEY;
  if (!SERVER || !AUDIENCE || !KEY) {
    console.error('Mailchimp config missing — check env vars.');
    return res.status(500).json({ error: 'Server not configured. Try again shortly.' });
  }

  const auth = 'Basic ' + Buffer.from(`anystring:${KEY}`).toString('base64');
  const baseUrl = `https://${SERVER}.api.mailchimp.com/3.0/lists/${AUDIENCE}`;

  const tierName = tier?.name || '';
  const tierSlug = tierName.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, '-') || 'unknown';

  const merge_fields = {
    VIS_SCORE:   typeof score === 'number' ? score : 0,
    VIS_TIER:    tierName,
    VIS_GOAL:    String(goal),
    VIS_LINKEDIN:String(normalisedUrl || ''),
    UTM_SOURCE:  String(attribution?.utm_source   || ''),
    UTM_CAMP:    String(attribution?.utm_campaign || ''),
    UTM_MED:     String(attribution?.utm_medium   || '')
  };

  const tags = [
    `tier:${tierSlug}`,
    `goal:${goal}`,
    ...(attribution?.utm_campaign ? [`campaign:${attribution.utm_campaign}`] : [])
  ];

  // Use upsert (PUT to /members/<md5(lower(email))>) — handles new + existing in one call
  const subscriberHash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  const upsertUrl = `${baseUrl}/members/${subscriberHash}`;

  try {
    const r = await fetch(upsertUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify({
        email_address: email.trim(),
        status_if_new: 'subscribed', // change to 'pending' for double opt-in
        merge_fields,
        tags
      })
    });

    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      console.error('Mailchimp upsert failed:', r.status, errBody);
      return res.status(502).json({ error: 'We couldn’t save your details. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('lead handler error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
}
