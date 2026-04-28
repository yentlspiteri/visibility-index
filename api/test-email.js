/**
 * /api/test-email — temporary diagnostic endpoint.
 *
 * Hit this in your browser:
 *   https://index.vonpeach.com/api/test-email?to=yentl@vonpeach.com
 *
 * Fires a minimal Resend send (no PDF, no Mailchimp, no Claude, no Apify) and
 * returns the EXACT Resend response so we can see why emails aren't going through.
 *
 * Delete this file (or wrap it behind an auth check) once email is confirmed working.
 */

const RESEND_API = 'https://api.resend.com/emails';

export default async function handler(req, res) {
  const to       = (req.query?.to       || 'yentl@vonpeach.com').trim();
  const apiKey   = process.env.RESEND_API_KEY;
  const fromUsed = process.env.RESEND_FROM || 'Visibility Index <hello@vonpeach.com>';

  // Diagnostic block — every line here gets returned to the browser, plain JSON
  const debug = {
    apiKeyPresent: !!apiKey,
    apiKeyPrefix:  apiKey ? apiKey.slice(0, 8) + '…' : null,
    fromUsed,
    fromEnvSet:    !!process.env.RESEND_FROM,
    to,
    resendStatus:  null,
    resendBody:    null,
    error:         null
  };

  if (!apiKey) {
    debug.error = 'RESEND_API_KEY is not set on Vercel. Add it under Project → Settings → Environment Variables → Production.';
    return res.status(500).json(debug);
  }

  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    fromUsed,
        to:      [to],
        subject: 'Visibility Index — email pipeline test',
        html:    `<p>If you're seeing this, your Resend integration is working. Sender: <strong>${fromUsed}</strong>. Recipient: <strong>${to}</strong>. Time: ${new Date().toISOString()}.</p>`
      })
    });
    debug.resendStatus = r.status;
    const text = await r.text().catch(() => '');
    debug.resendBody   = text.slice(0, 500);
    if (!r.ok) {
      debug.error = `Resend rejected with status ${r.status}. The body above tells you why — most common reasons: domain not verified for sender (${fromUsed}), API key invalid, or rate limit hit.`;
    } else {
      debug.error = null;
      debug.note  = 'Resend accepted the send. If the test email still doesn\'t arrive in the inbox in ~60 seconds, check resend.com/logs for delivery status (delivered/bounced/blocked) — the issue is delivery, not API.';
    }
  } catch (err) {
    debug.error = `fetch threw before getting a Resend response: ${err?.message || String(err)}`;
  }

  return res.status(200).json(debug);
}
