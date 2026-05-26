/*
 * i18n-detect.js — synchronous browser-language detection.
 *
 * Runs in <head> BEFORE the body paints. If the visitor:
 *   (a) explicitly chose German previously via the EN ⇄ DE switcher
 *       (localStorage 'vi-lang' === 'de'), OR
 *   (b) has no stored preference AND their browser's top language
 *       preference is German,
 * …redirects to the German counterpart of the current page (read from
 * the existing <link rel="alternate" hreflang="de"> tag).
 *
 * Respected escape hatches:
 *   - already under /de/* — never loop
 *   - ?lang=en in the URL — temporary override
 *   - localStorage 'vi-lang' === 'en' — sticky override (set when the
 *     user manually clicks the "EN" pill on a /de page, see lang-switcher.js)
 *   - page has no DE alternate — nothing to redirect to
 *
 * Loaded WITHOUT `defer` so it runs synchronously while <head> is parsing.
 * Place AFTER the page's <link rel="alternate" hreflang> tags so the
 * querySelector below can see them.
 */
(function () {
  try {
    if (/^\/de(\/|$)/.test(location.pathname)) return;
    if (location.search.indexOf('lang=en') !== -1) return;

    var stored = null;
    try { stored = localStorage.getItem('vi-lang'); } catch (_) { /* private mode etc. */ }
    if (stored === 'en') return;

    var prefersDe;
    if (stored === 'de') {
      prefersDe = true;
    } else {
      var langs = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || 'en'];
      // Match 'de', 'de-DE', 'de-CH', 'de-AT', etc.
      prefersDe = /^de(\b|-)/i.test(langs[0] || '');
    }
    if (!prefersDe) return;

    var de = document.querySelector('link[rel="alternate"][hreflang="de"]');
    if (!de || !de.href) return;

    var target = new URL(de.href);
    // Preserve UTMs and hash so attribution + deep links survive the redirect.
    target.search = location.search;
    target.hash = location.hash;
    // Use replace() so the back button takes the user to wherever they came
    // from, not back into a redirect loop.
    location.replace(target.pathname + target.search + target.hash);
  } catch (_) { /* never break the page over language detection */ }
})();
