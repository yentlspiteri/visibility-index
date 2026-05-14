/* ─────────── SHARED TRACKING BUNDLE ───────────────────────────────────────
   Single-include tracking for every page that isn't index.html.
   index.html ships this same setup inline (lines ~287–499, 7180–7266, 8492,
   11344–11384) and stays the canonical source — keep this file in sync if
   you change the IDs, consent defaults, event values, or banner copy there.

   Loads:
     - GA4 (G-2MKY8VPQBF) with Consent Mode v2 (defaults all denied)
     - Meta Pixel (1714917946519921)
     - LinkedIn Insight Tag (partner 2929409, gated on consent)
     - Attribution capture (utm_*, fbclid, gclid, li_fat_id, ttclid, msclkid)
     - Cookie consent banner (injected into <body>)
     - window.track() helper that mirrors events to GA4 + Meta Pixel with
       CAPI-grade event_id + hashed email user_data
   Safe to include on any HTML page. Self-contained: injects its own CSS,
   markup, and event handlers. Idempotent if accidentally included twice
   (guards on window.fbq, window.lintrk, banner element). */

(function () {
  if (window.__viTrackingLoaded) return;
  window.__viTrackingLoaded = true;

  var GA_ID         = 'G-2MKY8VPQBF';
  var META_PIXEL_ID = '1714917946519921';
  var LI_PARTNER_ID = '2929409';
  var CONSENT_KEY   = '__vi_consent';
  var ATTR_KEY      = '__vi_attr';

  /* ── gtag stub + Consent Mode v2 defaults ─────────────────────────────── */
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  gtag('consent', 'default', {
    ad_storage:              'denied',
    analytics_storage:       'denied',
    ad_user_data:            'denied',
    ad_personalization:      'denied',
    functionality_storage:   'denied',
    personalization_storage: 'denied',
    security_storage:        'granted',
    wait_for_update:         500
  });

  /* Restore previously-granted consent BEFORE gtag('config') so the first
     pageview goes out at the right consent level on repeat visits. */
  try {
    var _viC = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
    if (_viC && _viC.granted) {
      gtag('consent', 'update', {
        ad_storage:              'granted',
        analytics_storage:       'granted',
        ad_user_data:            'granted',
        ad_personalization:      'granted',
        functionality_storage:   'granted',
        personalization_storage: 'granted'
      });
    }
  } catch (_) {}

  /* ── Async-load GA4 library ───────────────────────────────────────────── */
  var ga = document.createElement('script');
  ga.async = true;
  ga.src   = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(ga);

  gtag('js', new Date());
  gtag('config', GA_ID, {
    cookie_domain:      '.vonpeach.com',
    cookie_flags:       'SameSite=None;Secure',
    url_passthrough:    true,
    ads_data_redaction: true
  });

  /* ── EMQ helpers (sha256 + uuid) and event-value table ────────────────── */
  async function sha256Hex(input) {
    if (!input || !crypto || !crypto.subtle) return null;
    var data = new TextEncoder().encode(String(input).toLowerCase().trim());
    var buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  var EVENT_VALUES = {
    audit_completed:    { value: 10,  currency: 'EUR' },
    lead_captured:      { value: 30,  currency: 'EUR' },
    walkthrough_booked: { value: 150, currency: 'EUR' }
  };

  /* ── Haptic feedback on primary CTAs ──────────────────────────────────── */
  window.haptic = function (pattern) {
    try {
      if (!('vibrate' in navigator)) return;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      navigator.vibrate(pattern || 8);
    } catch (_) {}
  };
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-haptic], .nav-cta, .nav-mobile-cta, .picker-option, .submit-btn, .btn-primary, #bottom-bar-cta, #cal-popup-launch, .nav-burger, button[type="submit"]');
    if (t) window.haptic(8);
  }, true);

  /* ── window.track() — unified GA4 + Meta event helper ─────────────────── */
  window.track = async function (name, params) {
    try {
      var eventId  = (params && params.event_id) || uuid();
      var enriched = Object.assign({}, params || {}, { event_id: eventId });

      if (typeof gtag === 'function') gtag('event', name, enriched);

      if (typeof fbq === 'function') {
        var META_MAP = {
          audit_started:      { event: 'InitiateCheckout',     standard: true  },
          audit_completed:    { event: 'CompleteRegistration', standard: true  },
          lead_captured:      { event: 'Lead',                 standard: true  },
          walkthrough_booked: { event: 'Schedule',             standard: true  },
          calendly_opened:    { event: 'CalendlyOpened',       standard: false },
          report_downloaded:  { event: 'ReportDownloaded',     standard: false },
          share_linkedin:     { event: 'ShareLinkedIn',        standard: false },
          cta_calendly:       { event: 'CalendlyClick',        standard: false }
        };
        var mapped = META_MAP[name];
        if (mapped) {
          var custom = Object.assign({}, params || {});
          if (EVENT_VALUES[name]) Object.assign(custom, EVENT_VALUES[name]);
          custom.content_name = name;
          var userData;
          var em = params && params.email && (await sha256Hex(params.email));
          if (em) userData = { em: em };
          fbq(
            mapped.standard ? 'track' : 'trackCustom',
            mapped.event,
            custom,
            Object.assign({ eventID: eventId }, userData ? { user_data: userData } : {})
          );
        }
      }
      if (window.location.hostname === 'localhost') console.log('[track]', name, enriched);
      return eventId;
    } catch (_) { return null; }
  };

  /* ── Meta Pixel ───────────────────────────────────────────────────────── */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document, 'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', META_PIXEL_ID);
  try {
    var _viCm = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
    if (!(_viCm && _viCm.granted)) fbq('consent', 'revoke');
  } catch (_) {}
  fbq('track', 'PageView');

  /* ── LinkedIn Insight Tag (deferred until consent granted) ────────────── */
  window._LI_PARTNER_ID = LI_PARTNER_ID;
  window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
  if (LI_PARTNER_ID) window._linkedin_data_partner_ids.push(LI_PARTNER_ID);

  window.loadLinkedInTag = function () {
    if (!window._LI_PARTNER_ID || window._liTagLoaded) return;
    window._liTagLoaded = true;
    if (!window.lintrk) {
      window.lintrk = function (a, b) { window.lintrk.q.push([a, b]); };
      window.lintrk.q = [];
    }
    var s = document.getElementsByTagName('script')[0];
    var b = document.createElement('script');
    b.type = 'text/javascript'; b.async = true;
    b.src  = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';
    s.parentNode.insertBefore(b, s);
  };
  try {
    var _viCli = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
    if (_viCli && _viCli.granted) window.loadLinkedInTag();
  } catch (_) {}

  /* ── Attribution capture (utm_*, click IDs, referrer) ─────────────────── */
  window.ATTRIBUTION = (function () {
    var params = new URLSearchParams(window.location.search);
    var URL_KEYS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term',
                    'gclid','fbclid','li_fat_id','ttclid','msclkid'];
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem(ATTR_KEY) || '{}'); } catch (_) {}
    var out = Object.assign({}, stored);
    URL_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) out[k] = v;
    });
    out.referrer    = document.referrer || stored.referrer || null;
    out.landingPath = window.location.pathname;
    try { localStorage.setItem(ATTR_KEY, JSON.stringify(out)); } catch (_) {}
    if (out.fbclid && !out._fbc) out._fbc = 'fb.1.' + Date.now() + '.' + out.fbclid;
    return out;
  })();

  /* ── Cookie consent banner (CSS + HTML + handlers, injected on DOM ready) */
  var BANNER_CSS = '\
#vi-consent{position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(11,3,89,0.97);\
backdrop-filter:saturate(160%) blur(20px);-webkit-backdrop-filter:saturate(160%) blur(20px);\
border-top:1px solid rgba(134,131,229,0.22);padding:16px 24px;display:flex;align-items:center;\
gap:16px;flex-wrap:wrap;font-family:var(--font-body,Helvetica,sans-serif);\
box-shadow:0 -4px 32px rgba(11,3,89,0.35);animation:vi-consent-in .3s cubic-bezier(.22,1,.36,1) both}\
@keyframes vi-consent-in{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}\
#vi-consent.hidden{display:none}\
#vi-consent p{flex:1 1 260px;margin:0;font-size:13px;color:rgba(255,255,255,0.72);line-height:1.5}\
#vi-consent p a{color:var(--vp-lavender,#8683E5);text-decoration:underline;text-underline-offset:2px}\
#vi-consent-actions{display:flex;gap:8px;flex-shrink:0}\
#vi-consent-accept{background:var(--vp-indigo,#3F36B2);color:#fff;border:0;border-radius:8px;\
padding:9px 18px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;\
white-space:nowrap;transition:background .12s}\
#vi-consent-accept:hover{background:#352db5}\
#vi-consent-decline{background:transparent;color:rgba(255,255,255,0.50);\
border:1px solid rgba(255,255,255,0.16);border-radius:8px;padding:9px 14px;font-family:inherit;\
font-size:13px;cursor:pointer;white-space:nowrap;transition:color .12s,border-color .12s}\
#vi-consent-decline:hover{color:rgba(255,255,255,0.80);border-color:rgba(255,255,255,0.32)}\
@media (max-width:480px){#vi-consent{padding:14px 16px;gap:12px}\
#vi-consent-actions{width:100%}\
#vi-consent-accept,#vi-consent-decline{flex:1;text-align:center}}';

  function injectBanner() {
    if (document.getElementById('vi-consent')) return;

    var style = document.createElement('style');
    style.textContent = BANNER_CSS;
    document.head.appendChild(style);

    var banner = document.createElement('div');
    banner.id = 'vi-consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML =
      '<p>We use cookies to measure ad performance and improve your experience. ' +
      '<a href="/privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>' +
      '<div id="vi-consent-actions">' +
      '<button id="vi-consent-accept" type="button">Accept all</button>' +
      '<button id="vi-consent-decline" type="button">Only essential</button>' +
      '</div>';
    document.body.appendChild(banner);

    try {
      if (localStorage.getItem(CONSENT_KEY)) { banner.classList.add('hidden'); return; }
    } catch (_) {}

    document.getElementById('vi-consent-accept').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ granted: true, ts: Date.now() })); } catch (_) {}
      banner.classList.add('hidden');
      if (typeof gtag === 'function') {
        gtag('consent', 'update', {
          ad_storage:              'granted',
          analytics_storage:       'granted',
          ad_user_data:            'granted',
          ad_personalization:      'granted',
          functionality_storage:   'granted',
          personalization_storage: 'granted'
        });
      }
      if (typeof fbq === 'function') fbq('consent', 'grant');
      if (typeof window.loadLinkedInTag === 'function') window.loadLinkedInTag();
    });
    document.getElementById('vi-consent-decline').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ granted: false, ts: Date.now() })); } catch (_) {}
      banner.classList.add('hidden');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBanner);
  } else {
    injectBanner();
  }

  /* ── Server-side pageview backstop ────────────────────────────────────────
     When consent is denied, the GA4 browser pixel is muted (cookieless pings
     don't count for low-volume sites). Mirror a page_view via /api/pv so the
     visit still reaches GA. Skip when consent is granted to avoid double-
     counting against the browser pixel. */
  function firePageviewBackstop() {
    try {
      var c = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      if (c && c.granted) return;
      var body = JSON.stringify({
        path:        window.location.href,
        referrer:    document.referrer || '',
        title:       document.title || '',
        attribution: window.ATTRIBUTION || {}
      });
      // keepalive lets the request survive a fast navigation (bounce).
      fetch('/api/pv', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    body,
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }
  firePageviewBackstop();
})();
