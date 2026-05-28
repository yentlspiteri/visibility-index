/*
 * lang-switcher.js — Visibility Index
 *
 * Reads `<link rel="alternate" hreflang="…">` tags from the page head and
 * injects a small EN ⇄ DE toggle into the top nav. Each page declares its
 * own counterpart, so adding a new translated page only requires:
 *
 *   1. Drop the translated file into /de/<slug>.html (or /<slug>.html)
 *   2. Add matching `<link rel="alternate" hreflang>` tags to BOTH pages
 *   3. Include this script via `<script src="/lang-switcher.js" defer></script>`
 *
 * Pages without a translated counterpart simply omit the corresponding
 * alternate tag and the switcher won't render.
 */
(function () {
  function init() {
    var altDe = document.querySelector('link[rel="alternate"][hreflang="de"]');
    var altEn = document.querySelector('link[rel="alternate"][hreflang="en"]');
    if (!altDe || !altEn) return;

    var currentLang = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    var otherLink = currentLang === 'de' ? altEn : altDe;
    var otherLang = currentLang === 'de' ? 'en' : 'de';
    if (!otherLink || !otherLink.href) return;

    var nav = document.querySelector('nav.top');
    if (!nav) return;

    var navRight = nav.querySelector('.nav-right');
    var container = nav.querySelector('.container');
    var host = navRight || container;
    if (!host) return;

    // Prefer the pathname when the alternate's origin matches the canonical
    // production host but we're being served from somewhere else (local dev,
    // preview deploy). Keeps the link clickable across environments without
    // ever 302'ing users back to prod from staging.
    var targetHref = otherLink.href;
    try {
      var u = new URL(otherLink.href);
      if (u.host !== location.host) {
        targetHref = u.pathname + u.search + u.hash;
      }
    } catch (_) { /* leave targetHref as-is */ }

    var sw = document.createElement('a');
    sw.href = targetHref;
    sw.className = 'lang-switch';
    sw.setAttribute('hreflang', otherLang);
    sw.setAttribute('aria-label', otherLang === 'de' ? 'Auf Deutsch ansehen' : 'View in English');
    sw.textContent = otherLang.toUpperCase();
    // Record the user's manual choice so i18n-detect.js doesn't bounce them
    // back to their browser-preferred language on the next visit. Set
    // synchronously before navigation so localStorage is written by the
    // time the next page's <head> reads it.
    sw.addEventListener('click', function () {
      try { localStorage.setItem('vi-lang', otherLang); } catch (_) { /* private mode */ }
    });

    // Insert before the primary CTA when present, otherwise append.
    var cta = host.querySelector('.nav-cta, .cta, .nav-burger');
    if (cta && cta.parentNode === host) {
      host.insertBefore(sw, cta);
    } else {
      host.appendChild(sw);
    }

    // Visual: secondary action — not the primary CTA. Uses brand lavender
    // (#8683E5) as an explicit color so it stays visible on BOTH the dark-
    // navy hero AND the light/white sticky nav after scroll (previous
    // `color:inherit` went white-on-white when the parent nav text flipped
    // on scroll). No border, small font, subtle hover tint — feels like a
    // language preference toggle, not a CTA. Mid-tone purple has acceptable
    // contrast on both ends of the brand palette.
    var style = document.createElement('style');
    style.textContent =
      '.lang-switch{' +
        'display:inline-flex;align-items:center;justify-content:center;' +
        'padding:4px 9px;margin-right:8px;' +
        'font:500 11px/1 inherit;letter-spacing:.08em;' +
        'color:#8683E5;text-decoration:none;' +
        'background:transparent;border:0;border-radius:999px;' +
        'opacity:.7;transition:opacity .15s ease,background .15s ease' +
      '}' +
      '.lang-switch:hover,.lang-switch:focus-visible{' +
        'opacity:1;background:rgba(134,131,229,0.14);outline:none' +
      '}' +
      '@media (max-width:480px){' +
        '.lang-switch{padding:3px 7px;margin-right:5px;font-size:10px}' +
      '}';
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
