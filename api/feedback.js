/**
 * /api/feedback - bug-report submissions from the floating 🐛 button.
 *
 * POST body: { message, email?, url, viewport, ua, time }
 * Sends an email via Resend to FEEDBACK_EMAIL (defaults to yentl@vonpeach.com).
 *
 * Why a dedicated endpoint instead of mailto:
 *   - Mailto requires a configured email client. Mobile + corporate users often don't have one.
 *   - We want the report to land regardless, with full page context attached.
 *   - Server-side delivery via the same Resend domain we already verified for /api/lead.
 */

const RESEND_API = 'https://api.resend.com/emails';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message)              return res.status(400).json({ error: 'Message is required.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Message too long.' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Email not configured.' });

  const to       = process.env.FEEDBACK_EMAIL || 'yentl@vonpeach.com';
  const fromAddr = process.env.RESEND_FROM    || 'Visibility Index <hello@vonpeach.com>';

  // Sender email is optional. If they gave one, set it as the Reply-To so Yentl
  // can hit reply and reach the user directly.
  const replyTo  = (body.email && /\S+@\S+\.\S+/.test(body.email)) ? body.email : null;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  const html = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#0c0b09;background:#fafafa;padding:32px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;padding:28px;border-radius:12px;border:1px solid rgba(15,15,15,0.08);">
    <p style="color:#3F36B2;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 12px;">VISIBILITY INDEX &middot; BUG REPORT</p>
    <h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;">Someone reported a bug</h2>
    <div style="background:#fafafa;border-left:3px solid #3F36B2;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px;">
      <p style="white-space:pre-wrap;font-size:15px;color:#0c0b09;margin:0;line-height:1.55;">${escapeHtml(message)}</p>
    </div>
    <table style="border-collapse:collapse;font-size:13px;color:#666;width:100%;">
      ${replyTo  ? `<tr><td style="padding:4px 14px 4px 0;color:#999;width:90px;">From</td><td style="padding:4px 0;font-family:monospace;"><a href="mailto:${escapeHtml(replyTo)}">${escapeHtml(replyTo)}</a></td></tr>` : '<tr><td style="padding:4px 14px 4px 0;color:#999;">From</td><td style="padding:4px 0;color:#aaa;">(anonymous)</td></tr>'}
      <tr><td style="padding:4px 14px 4px 0;color:#999;">URL</td><td style="padding:4px 0;font-family:monospace;font-size:12px;word-break:break-all;">${escapeHtml(String(body.url || '').slice(0, 400))}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#999;">Viewport</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(String(body.viewport || ''))}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#999;">Browser</td><td style="padding:4px 0;font-family:monospace;font-size:11px;">${escapeHtml(String(body.ua || '').slice(0, 200))}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#999;">IP</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(ip)}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#999;">Time</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${escapeHtml(String(body.time || new Date().toISOString()))}</td></tr>
    </table>
  </div>
</body></html>`;

  const payload = {
    from:    fromAddr,
    to:      [to],
    subject: `[VI Bug] ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`,
    html
  };
  if (replyTo) payload.reply_to = replyTo;

  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('feedback Resend failed:', r.status, errText);
      return res.status(502).json({ error: 'Could not send right now.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('feedback error:', err);
    return res.status(500).json({ error: 'Could not send.' });
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
