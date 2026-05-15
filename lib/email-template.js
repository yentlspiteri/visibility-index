/**
 * lib/email-template.js — branded transactional email shell.
 *
 * Matches the style used by api/lead.js for the audit report email:
 *  - dark navy outer (resistant to dark-mode auto-inversion)
 *  - indigo→lavender gradient hero card
 *  - cream body card
 *  - "Von Peach · FutureMakers · The Visibility Index" eyebrow at top
 *  - hello@vonpeach.com reply footer
 *
 * Three callsites use this: magic-link (lib/auth.js), opt-in (api/manager/
 * [action].js → notify), monthly digest (api/cron/[task].js → monthlyDigest).
 *
 * Inline styles only — every major email client strips <style> blocks.
 * `color-scheme: light only` and explicit colors prevent Gmail/Outlook
 * dark-mode from washing out the button or inverting the gradient.
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * @param {Object} opts
 * @param {string}  opts.title          — <title> tag content (shown in some clients)
 * @param {string}  [opts.heroHeadline] — large headline inside the gradient hero
 * @param {string}  [opts.heroEyebrow]  — small uppercase label above the headline
 * @param {string}  [opts.heroBigStat]  — large displayed value (e.g. "12.4")
 * @param {string}  [opts.heroBigUnit]  — denominator next to the big stat (e.g. "/ 18")
 * @param {string}  [opts.heroSubtitle] — secondary line under the stat / headline
 * @param {string}  opts.bodyHtml       — inner HTML for the cream body card
 * @param {{ label: string, href: string }} [opts.cta] — optional pill button
 * @param {string}  [opts.bodyFootnote] — small italic line under the CTA
 */
export function renderBrandedEmail({ title, heroHeadline, heroEyebrow, heroBigStat, heroBigUnit, heroSubtitle, bodyHtml, cta, bodyFootnote }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0B0359;font-family:Helvetica,Arial,sans-serif;color:#0c0b09;line-height:1.55;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <p style="color:#A6A4ED;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 24px;text-align:center;">
      Von Peach &middot; FutureMakers &middot; The Visibility Index
    </p>

    <div style="background:linear-gradient(160deg,#3F36B2 0%,#5A50CC 60%,#8683E5 100%);border-radius:24px 24px 0 0;padding:40px 36px 36px;text-align:center;color:#fafafa;">
      ${heroEyebrow ? `<p style="font-size:13px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;margin:0 0 14px;color:#EBF0FF;opacity:0.75;">${escapeHtml(heroEyebrow)}</p>` : ''}
      ${heroBigStat ? `
        <p style="margin:0;line-height:1;">
          <span style="font-size:88px;font-weight:900;letter-spacing:-0.04em;color:#fafafa;">${escapeHtml(heroBigStat)}</span>
          ${heroBigUnit ? `<span style="font-size:24px;font-weight:600;color:#EBF0FF;opacity:0.7;margin-left:6px;">${escapeHtml(heroBigUnit)}</span>` : ''}
        </p>
      ` : ''}
      ${heroHeadline ? `
        <p style="font-size:${heroBigStat ? '22px' : '28px'};line-height:1.2;font-weight:700;letter-spacing:-0.02em;margin:${heroBigStat ? '18px 0 0' : '0'};color:#fafafa;">
          ${heroHeadline}
        </p>
      ` : ''}
      ${heroSubtitle ? `<p style="font-size:14px;color:#EBF0FF;opacity:0.85;margin:12px 0 0;font-weight:500;">${escapeHtml(heroSubtitle)}</p>` : ''}
    </div>

    <div style="background:#fafafa;border-radius:0 0 24px 24px;padding:36px 36px 32px;">
      ${bodyHtml}

      ${cta ? `<div style="text-align:center;margin:32px 0 12px;">
        <a href="${cta.href}"
           style="display:inline-block;background:#0c0b09;color:#fafafa;padding:18px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.04em;text-transform:uppercase;">
          ${escapeHtml(cta.label)}
        </a>
      </div>` : ''}

      ${bodyFootnote ? `<p style="font-size:13px;color:#666;margin:14px 0 0;text-align:center;font-style:italic;">
        ${bodyFootnote}
      </p>` : ''}
    </div>

    <p style="font-size:10px;color:#A6A4ED;letter-spacing:0.16em;text-transform:uppercase;margin:32px 0 8px;text-align:center;opacity:0.7;">
      Von Peach GmbH &middot; FutureMakers &middot; ${new Date().getFullYear()}
    </p>
    <p style="font-size:11px;color:#A6A4ED;margin:0;text-align:center;opacity:0.6;">
      Replies welcome &mdash; <a href="mailto:hello@vonpeach.com" style="color:#EBF0FF;text-decoration:underline;">hello@vonpeach.com</a>
    </p>
  </div>
</body>
</html>`;
}
