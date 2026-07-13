/*
 * consent-loader.js — Consent-gated third-party trackers.
 *
 * Loads Contentsquare (session recording) and Meta Pixel (Facebook/Instagram
 * advertising) ONLY after the user grants cookie consent. Prior to consent
 * neither script's request is made — no cookies set, no third-party IP
 * leaks, TTDSG §25 and GDPR Art. 6 compliant.
 *
 * Before this shared loader existed, both scripts were inlined in every
 * page's <head>, fired immediately on load, and set cookies before any
 * consent decision could be made. Under German law (TTDSG §25 requiring
 * prior consent for any non-essential cookie or third-party network call),
 * this was a real risk of Datenschutzbehörden complaint.
 *
 * Behaviour:
 *   1. On page load, read `__vi_consent` from localStorage.
 *      - If consent already granted (return visitor): load both scripts now.
 *      - If not granted (or no decision made): load nothing.
 *   2. Expose window.loadContentsquare() and window.loadMetaPixel() so the
 *      cookie banner's grantConsent() handler in de/index.html + index.html
 *      can call them at the moment the user clicks "Accept".
 *   3. Idempotent — safe to call multiple times; each loader marks itself
 *      loaded and short-circuits on second invocation.
 *
 * Meta Pixel ID is currently hardcoded to Von Peach's pixel (1714917946519921).
 * If a page has `window._VI_META_PIXEL_ID` set before this script runs, that
 * value overrides.
 */
(function () {
  var CONSENT_KEY = '__vi_consent';
  var META_PIXEL_ID = window._VI_META_PIXEL_ID || '1714917946519921';
  var CONTENTSQUARE_URL = 'https://t.contentsquare.net/uxa/1797a4bbbff27.js';

  var _csLoaded = false;
  var _metaLoaded = false;

  window.loadContentsquare = function loadContentsquare() {
    if (_csLoaded) return;
    _csLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = CONTENTSQUARE_URL;
    document.head.appendChild(s);
  };

  window.loadMetaPixel = function loadMetaPixel() {
    if (_metaLoaded) return;
    _metaLoaded = true;
    // Standard Meta Pixel loader stub.
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(
      window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  };

  // Auto-load if consent was already granted on a previous visit.
  try {
    var c = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
    if (c && c.granted) {
      window.loadContentsquare();
      window.loadMetaPixel();
    }
  } catch (_) {}
})();
