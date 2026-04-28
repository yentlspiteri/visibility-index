/**
 * /api/test-mailchimp - temporary diagnostic endpoint.
 *
 * Hit this in your browser:
 *   https://index.vonpeach.com/api/test-mailchimp?email=yentl@vonpeach.com
 *
 * Tries a minimal Mailchimp upsert (no PDF, no Resend, no Apify) and returns
 * the EXACT Mailchimp response so we can see why it isn't accepting leads.
 *
 * Delete once Mailchimp is confirmed working in /api/lead.
 */

import { createHash } from 'node:crypto';

export default async function handler(req, res) {
  const email = (req.query?.email || 'diag@vonpeach.com').trim();

  const SERVER   = process.env.MAILCHIMP_SERVER_PREFIX;
  const AUDIENCE = process.env.MAILCHIMP_AUDIENCE_ID;
  const KEY      = process.env.MAILCHIMP_API_KEY;

  // Diagnostic block returned to the browser regardless of outcome
  const debug = {
    env: {
      serverPresent:   !!SERVER,
      audiencePresent: !!AUDIENCE,
      keyPresent:      !!KEY,
      server:          SERVER || null,
      audienceLen:     AUDIENCE ? AUDIENCE.length : 0,
      keyPrefix:       KEY ? KEY.slice(0, 6) + '…' : null,
      keySuffix:       KEY ? '…' + KEY.slice(-8) : null,
      keyLooksRight:   KEY && KEY.includes('-') && KEY.split('-').pop() === SERVER
    },
    request: { email, audience: AUDIENCE },
    response: { status: null, body: null, error: null }
  };

  if (!SERVER || !AUDIENCE || !KEY) {
    debug.response.error = 'Missing one or more Mailchimp env vars on Vercel. Required: MAILCHIMP_SERVER_PREFIX (e.g. us17), MAILCHIMP_AUDIENCE_ID, MAILCHIMP_API_KEY.';
    return res.status(500).json(debug);
  }

  // Sanity check the API key suffix matches the server prefix
  if (!debug.env.keyLooksRight) {
    debug.response.error = `WARNING: Your API key suffix doesn't match MAILCHIMP_SERVER_PREFIX (${SERVER}). Mailchimp keys end with the server they belong to, e.g. "abc123-us17". If they don't match, the key is for a different account.`;
    // Still try the call - maybe it's an old-format key
  }

  // Try a minimal ping first - GET /lists/{audience}/members - just to verify auth + audience
  const auth = 'Basic ' + Buffer.from(`anystring:${KEY}`).toString('base64');
  const subscriberHash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  const upsertUrl = `https://${SERVER}.api.mailchimp.com/3.0/lists/${AUDIENCE}/members/${subscriberHash}`;

  try {
    const r = await fetch(upsertUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify({
        email_address: email,
        status_if_new: 'subscribed',
        merge_fields: {
          VIS_SCORE: 50,
          VIS_TIER:  'The Rising Voice',
          VIS_GOAL:  'clients',
          VIS_LINKEDIN: 'linkedin.com/in/diagnostic',
          UTM_SOURCE: 'manual',
          UTM_CAMP:   'diag',
          UTM_MED:    ''
        },
        tags: ['tier:rising-voice', 'goal:clients', 'role:founder']
      })
    });
    debug.response.status = r.status;
    const body = await r.text().catch(() => '');
    debug.response.body = body.slice(0, 800);

    if (r.ok) {
      debug.response.success = true;
      debug.response.note = 'Mailchimp accepted the upsert. Check your audience for the contact + tags + merge fields.';
    } else {
      debug.response.success = false;
      // Try to parse the JSON error for a friendlier hint
      try {
        const parsed = JSON.parse(body);
        if (parsed.title)  debug.response.title  = parsed.title;
        if (parsed.detail) debug.response.detail = parsed.detail;
        if (parsed.errors) debug.response.errors = parsed.errors;
      } catch {}

      // Map common Mailchimp errors to actionable hints
      if (r.status === 401)      debug.response.fix = 'API key is invalid. Generate a new one in Mailchimp → Account → Extras → API keys.';
      else if (r.status === 404) debug.response.fix = 'Audience ID not found. Check Mailchimp → Audience → Settings → Audience name and defaults → bottom of page for the real ID.';
      else if (r.status === 400 && body.includes('merge field')) {
        debug.response.fix = 'Merge fields not added to the audience. Add them in Mailchimp → Audience → Settings → Audience fields and *|MERGE|* tags. Required: VIS_SCORE (Number), VIS_TIER, VIS_GOAL, VIS_LINKEDIN, UTM_SOURCE, UTM_CAMP, UTM_MED (all Text).';
      }
      else if (r.status === 400 && body.includes('compliance')) debug.response.fix = 'This email is on the cleaned/deleted list in this audience. Try with a fresh email.';
      else if (r.status === 400) debug.response.fix = 'Bad request - check the response body above for what specifically failed.';
    }
  } catch (err) {
    debug.response.error = err?.message || String(err);
  }

  return res.status(200).json(debug);
}
