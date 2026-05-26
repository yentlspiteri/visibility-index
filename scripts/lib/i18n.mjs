/*
 * scripts/lib/i18n.mjs — shared config + helpers for the German i18n pipeline.
 *
 * Design: content-driven, no per-element markup in the HTML. Translatable
 * elements are found by CSS selector and keyed by a hash of their English
 * content. Editing the English produces a new key (and therefore a new
 * Draft row that must be re-translated) — by design, this keeps DE copy
 * from silently going stale when EN changes.
 *
 * Three scripts use this lib:
 *   - i18n-extract : push EN strings to Notion as Draft rows (for NEW pages)
 *   - i18n-seed    : one-time migration of an already-translated page (EN+DE)
 *   - i18n-sync    : pull Approved rows from Notion, regenerate de/<page>.html
 */
import { parse } from 'node-html-parser';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/* ─────────────── Pages under i18n management ─────────────── */
export const PAGES = {
  privacy: {
    en: 'privacy.html',
    de: 'de/privacy.html',
    canonical: 'https://index.vonpeach.com/de/privacy',
  },
  'free-personal-brand-audit': {
    en: 'free-personal-brand-audit.html',
    de: 'de/free-personal-brand-audit.html',
    canonical: 'https://index.vonpeach.com/de/free-personal-brand-audit',
  },
  'executive-personal-brand-audit': {
    en: 'executive-personal-brand-audit.html',
    de: 'de/executive-personal-brand-audit.html',
    canonical: 'https://index.vonpeach.com/de/executive-personal-brand-audit',
  },
  'linkedin-audit': {
    en: 'linkedin-audit.html',
    de: 'de/linkedin-audit.html',
    canonical: 'https://index.vonpeach.com/de/linkedin-audit',
  },
  'personal-brand-checker': {
    en: 'personal-brand-checker.html',
    de: 'de/personal-brand-checker.html',
    canonical: 'https://index.vonpeach.com/de/personal-brand-checker',
  },
};

/*
 * Translation units, in document order. Each is a leaf-ish element whose
 * full value is one translation. `mode` controls how the value is read/written:
 *   - 'html' : innerHTML (may contain inline <a>/<strong>/<code>)
 *   - 'attr' : a named attribute (e.g. meta content)
 *
 * IMPORTANT: selectors must not overlap such that one unit is nested inside
 * another (that would double-translate). Container prose (p, li, h2…) is
 * translated whole; inline children ride along inside the innerHTML.
 */
export const UNITS = [
  { sel: 'title', mode: 'html', kind: 'title' },
  { sel: 'meta[name="description"]', mode: 'attr', attr: 'content', kind: 'meta' },
  // Nav — both the simple (brand + cta) and full (links + mobile panel) variants.
  { sel: 'nav.top a.brand', mode: 'html', kind: 'a' },
  { sel: 'nav.top a.cta', mode: 'html', kind: 'a' },
  { sel: 'nav.top a.nav-link', mode: 'html', kind: 'a' },
  { sel: 'nav.top a.nav-cta', mode: 'html', kind: 'a' },
  { sel: 'nav.top a.nav-mobile-link', mode: 'html', kind: 'a' },
  { sel: 'nav.top a.nav-mobile-cta', mode: 'html', kind: 'a' },
  // Hero — legal header (breadcrumb/eyebrow/h1/lede) and lander hero (+ cta + trust row).
  { sel: 'header .breadcrumb', mode: 'html', kind: 'breadcrumb' },
  { sel: 'header .eyebrow', mode: 'html', kind: 'eyebrow' },
  { sel: 'header h1', mode: 'html', kind: 'h1' },
  { sel: 'header .lede', mode: 'html', kind: 'lede' },
  { sel: 'header a.cta-primary', mode: 'html', kind: 'a' },
  { sel: 'header .trust-row span', mode: 'html', kind: 'p' },
  // Legal article body.
  { sel: 'main article h2', mode: 'html', kind: 'h2' },
  { sel: 'main article h3', mode: 'html', kind: 'h3' },
  { sel: 'main article p', mode: 'html', kind: 'p' },
  { sel: 'main article li', mode: 'html', kind: 'li' },
  // Landing-page sections (incl. FAQ <details>/<summary> and closing CTA).
  { sel: 'section .eyebrow', mode: 'html', kind: 'eyebrow' },
  { sel: 'section h2', mode: 'html', kind: 'h2' },
  { sel: 'section h3', mode: 'html', kind: 'h3' },
  { sel: 'section summary', mode: 'html', kind: 'p' },
  { sel: 'section p', mode: 'html', kind: 'p' },
  { sel: 'section li', mode: 'html', kind: 'li' },
  { sel: 'section a.cta-primary', mode: 'html', kind: 'a' },
  // Legal CTA aside.
  { sel: 'aside.cta-card h2', mode: 'html', kind: 'h2' },
  { sel: 'aside.cta-card p', mode: 'html', kind: 'p' },
  { sel: 'aside.cta-card a.btn', mode: 'html', kind: 'a' },
  // Footer (shared across page types).
  { sel: 'footer .footer-col-eyebrow', mode: 'html', kind: 'eyebrow' },
  { sel: 'footer li a', mode: 'html', kind: 'a' },
  { sel: 'footer .footer-legal-row a', mode: 'html', kind: 'a' },
];

const PARSE_OPTS = {
  lowerCaseTagName: false,
  comment: true,
  blockTextElements: { script: true, style: true, pre: true },
};

export function parseHtml(raw) {
  return parse(raw, PARSE_OPTS);
}

export async function loadHtml(path) {
  const raw = await readFile(path, 'utf8');
  return { raw, root: parseHtml(raw) };
}

/** Normalize a string for stable hashing: collapse whitespace, trim. */
export function normalize(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Stable content key: `<page>.<8 hex>`. Identical EN → identical key (shared translation). */
export function contentKey(page, value) {
  const h = createHash('sha256').update(normalize(value)).digest('hex').slice(0, 8);
  return `${page}.${h}`;
}

/** Read a unit's translatable value off an element. */
export function readValue(el, unit) {
  if (unit.mode === 'attr') return el.getAttribute(unit.attr) ?? '';
  return el.innerHTML;
}

/** Write a translated value back onto an element. */
export function writeValue(el, unit, value) {
  if (unit.mode === 'attr') el.setAttribute(unit.attr, value);
  else el.set_content(value);
}

/**
 * Walk a parsed document and yield every translation unit instance.
 * Returns [{ key, page, value, kind, unit, el }].
 *
 * Two safety passes:
 *  - dedupe elements matched by more than one selector (first selector wins)
 *  - nesting guard: drop a container element when one of its descendants is
 *    also a unit (e.g. a <p> that only wraps an <a class="cta-primary">), so we
 *    never translate the same text both as a whole and via its inner element.
 */
export function collectUnits(root, page) {
  const seen = new Set();
  const candidates = [];
  for (const unit of UNITS) {
    for (const el of root.querySelectorAll(unit.sel)) {
      if (seen.has(el)) continue;
      if (!normalize(readValue(el, unit))) continue; // skip empties
      seen.add(el);
      candidates.push({ unit, el });
    }
  }
  // Mark any candidate that is an ancestor of another candidate.
  const elSet = new Set(candidates.map((c) => c.el));
  const containers = new Set();
  for (const { el } of candidates) {
    let p = el.parentNode;
    while (p) {
      if (elSet.has(p)) containers.add(p);
      p = p.parentNode;
    }
  }
  const out = [];
  for (const { unit, el } of candidates) {
    if (containers.has(el)) continue; // it wraps a finer unit — skip
    const value = readValue(el, unit);
    out.push({ key: contentKey(page, value), page, value: normalize(value), kind: unit.kind, unit, el });
  }
  return out;
}

/* ─────────────── Notion REST client (classic 2022-06-28 API) ─────────────── */
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

export function notionEnv() {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_TRANSLATIONS_DB_ID;
  if (!token) throw new Error('NOTION_TOKEN is not set (see .env.example).');
  if (!db) throw new Error('NOTION_TRANSLATIONS_DB_ID is not set (see .env.example).');
  return { token, db };
}

async function notionFetch(token, path, init = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion ${init.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

/** Notion rich_text caps each text node at 2000 chars; chunk long values. */
function richText(content) {
  const s = String(content ?? '');
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += 2000) chunks.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
  return chunks;
}

function plainFromRich(prop) {
  if (!prop) return '';
  const arr = prop.type === 'title' ? prop.title : prop.rich_text;
  return (arr || []).map((t) => t.plain_text).join('');
}

/** Fetch every row in the translations DB. Returns [{ id, key, page, en, de, status }]. */
export async function fetchAllRows(token, db) {
  const rows = [];
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const data = await notionFetch(token, `/databases/${db}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const page of data.results) {
      const p = page.properties;
      rows.push({
        id: page.id,
        key: plainFromRich(p.Key),
        page: p.Page?.select?.name || '',
        en: plainFromRich(p.EN),
        de: plainFromRich(p.DE),
        status: p.Status?.select?.name || '',
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

export async function createRow(token, db, { key, page, en, de, status, element }) {
  const properties = {
    Key: { title: richText(key) },
    Page: { select: { name: page } },
    EN: { rich_text: richText(en) },
    Status: { select: { name: status } },
  };
  if (de) properties.DE = { rich_text: richText(de) };
  if (element) properties.Element = { select: { name: element } };
  return notionFetch(token, '/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: db }, properties }),
  });
}

/* ─────────────── DE document transforms (sync) ─────────────── */
export function applyDeChrome(root, page) {
  const cfg = PAGES[page];
  const html = root.querySelector('html');
  if (html) html.setAttribute('lang', 'de');
  const canonical = root.querySelector('link[rel="canonical"]');
  if (canonical && cfg?.canonical) canonical.setAttribute('href', cfg.canonical);
  const ogLocale = root.querySelector('meta[property="og:locale"]');
  if (ogLocale) ogLocale.setAttribute('content', 'de_DE');
  // Rewrite root-relative homepage links to the German homepage so audit CTAs
  // (and the logo) on /de/ pages don't dump the user into the English flow.
  // Conservative: only the exact href="/" — other paths stay as-is so a
  // not-yet-translated page (e.g. /methodology) still resolves.
  for (const a of root.querySelectorAll('a[href="/"]')) {
    a.setAttribute('href', '/de');
  }
}

// HTML void elements — re-emitted with a self-closing slash to match the
// hand-authored source style (node-html-parser drops it on serialization).
const VOID_TAGS = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr';
const VOID_RE = new RegExp(`<(${VOID_TAGS})((?:[^>"']|"[^"]*"|'[^']*')*?)\\s*/?>`, 'gi');

function normalizeVoidTags(html) {
  return html.replace(VOID_RE, (_m, tag, attrs) => `<${tag}${attrs} />`);
}

/** Serialize a parsed doc, preserving the leading doctype if the source had one. */
export function serialize(root, raw) {
  let out = root.toString();
  const dt = raw.match(/^\s*<!DOCTYPE[^>]*>\s*/i);
  if (dt && !/^\s*<!DOCTYPE/i.test(out)) out = dt[0] + out;
  return normalizeVoidTags(out);
}
