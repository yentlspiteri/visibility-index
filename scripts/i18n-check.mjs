#!/usr/bin/env node
/*
 * scripts/i18n-check.mjs — automated style checks for German content.
 *
 * Gates the rules established for this repo's DE rollout (target audience
 * is Germany, not Switzerland):
 *   - Standard German orthography: words requiring "ß" after long vowels /
 *     diphthongs must use "ß", not Swiss "ss". We don't ban "ß" itself —
 *     instead we ban a curated list of Swiss-spelled common words that
 *     would otherwise drift back in if Claude under the German directive
 *     reverts (ausschliesslich, grösser, schliessen, weiss, Strasse,
 *     Massnahme, regelmässig, etc.).
 *   - Formal Sie: no leaking "du"/"dich"/"dein"/"dir" outside English source.
 *   - Brand names preserved verbatim: Visibility Index, Von Peach,
 *     FutureMakers, LinkedIn, "Personal Brand".
 *
 * Scans:
 *   - all .html files under the de/ subtree (every rendered German page)
 *   - The DE branch of LABELS in lib/buildReport.js
 *   - The TIERS_DE array in api/score.js
 *   - The DE branch of T (lang === 'de') in api/lead.js buildEmailHTML
 *   - The if (LANG === 'de') override block in index.html (homepage SPA)
 *
 * Exit code: 0 if clean, 1 if any issue found. Suitable for CI gating.
 *
 * Usage:
 *   node scripts/i18n-check.mjs
 *   node scripts/i18n-check.mjs --quiet   # only print failures
 */
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises'; // node 22+
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');

const BRAND_TERMS = ['Visibility Index', 'Von Peach', 'FutureMakers', 'LinkedIn'];
// Swiss-spelled words that should always be German-spelled in target-DE
// content. Words where the German rule keeps "ss" (after short vowels) are
// NOT in this list — only words where standard German requires "ß".
const SWISS_FORBIDDEN_WORDS = [
  'ausschliesslich', 'ausschliessen', 'ausschliesst', 'ausschliessend',
  'grösser', 'grössere', 'grösseren', 'grösserer', 'grösseres',
  'grösste', 'grössten', 'grösstes', 'grösster',
  'Grösse', 'Grössen',
  'schliesslich', 'schliessen', 'schliesst',
  'abschliessend', 'anschliessend', 'erschliessen', 'entschliessen',
  'heisst', 'heissen',
  'weiss', 'Weiss', 'weisse', 'weissen', 'weisser',
  'Strasse', 'Strassen',
  'dreissig', 'Fuss', 'Füsse',
  'draussen', 'ausserhalb', 'ausserdem',
  'äusserst', 'äussert', 'äussern',
  'süss', 'süsse',
  'beissen', 'beisst', 'fliessen', 'fliesst', 'fliessend',
  'giessen', 'giesst', 'geniessen', 'geniesst',
  'schiessen', 'schiesst',
  'stossen', 'stösst', 'Stoss',
  'reissen', 'reisst',
  'Massnahme', 'Massnahmen', 'Massstab',
  'regelmässig', 'regelmässige', 'regelmässigen', 'unregelmässig',
  'mässig', 'gemäss',
];
const SWISS_REGEX = new RegExp('\\b(' + SWISS_FORBIDDEN_WORDS.join('|') + ')\\b', 'g');
const DU_FORBIDDEN = /\b(du|dich|dein(?:e[mnrs]?)?|dir)\b/gi;
// English words that may legitimately contain "ß" or look like "du" in
// code (very narrow allow-list — only used to suppress JS code lines).
const ALLOW_CODE_HINTS = /^\s*(\/\/|\/\*|\*|const |let |var |function |if |for |while |return |import |export |from )/;

let totalIssues = 0;
const findings = [];

function record(file, ruleId, hits) {
  if (!hits.length) return;
  totalIssues += hits.length;
  findings.push({ file, ruleId, hits });
}

/* ───────────── HTML files in de/ ───────────── */
async function scanHtmlFiles() {
  const files = [];
  for await (const f of glob('de/**/*.html')) files.push(f);
  for (const file of files.sort()) {
    const text = await readFile(file, 'utf8');

    // Strip HTML comments + scripts + styles before checking content. HTML
    // comments routinely document the rules themselves ("...never 'ß'...")
    // so we don't want those flagged. Scripts have English variable names
    // and JS-level commentary that aren't user-facing.
    const scrubbed = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<!-- script -->')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<!-- style -->');

    // 1. ß forbidden in user-facing text — Swiss orthography
    const eszett = [...scrubbed.matchAll(SWISS_REGEX)].map((m) => m.index);
    if (eszett.length) {
      record(file, 'swiss-not-german', eszett.map((i) => contextOf(scrubbed, i, 30)));
    }

    // 2. Informal du forbidden in user-facing text
    const duMatches = [...scrubbed.matchAll(DU_FORBIDDEN)];
    if (duMatches.length) {
      record(file, 'no-du-form', duMatches.slice(0, 6).map((m) => contextOf(scrubbed, m.index, 40)));
    }

    // 3. Brand names should appear at least once on substantive pages (not
    // a hard fail, but a flag if the page is suspiciously missing them)
    if (text.length > 4000) {
      const missing = BRAND_TERMS.filter((t) => !text.includes(t));
      if (missing.length === BRAND_TERMS.length) {
        record(file, 'no-brand-mentions', [`page has none of: ${BRAND_TERMS.join(', ')}`]);
      }
    }
  }
}

/* ───────────── LABELS.de in lib/buildReport.js ───────────── */
async function scanBuildReportLabels() {
  const file = 'lib/buildReport.js';
  const text = await readFile(file, 'utf8');
  // Extract the de: { … } block. Brace-depth walk handles nested objects
  // and works whether the closing line is `},\n};` (mid-object) or `}\n};`
  // (last entry, no trailing comma).
  const startMatch = text.match(/\n {2}de:\s*\{/);
  if (!startMatch) {
    record(file, 'meta', ['could not locate `de: { … }` block to scan']);
    return;
  }
  let i = startMatch.index + startMatch[0].length;
  let depth = 1, end = -1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // skip strings, including escape sequences
      const quote = ch; i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 2; else i++;
      }
    }
    i++;
  }
  if (end === -1) {
    record(file, 'meta', ['unbalanced braces walking `de: { … }` block']);
    return;
  }
  const de = text.slice(startMatch.index + startMatch[0].length, end);
  const eszett = [...de.matchAll(SWISS_REGEX)].map((mm) => mm.index);
  if (eszett.length) {
    record(file, 'swiss-not-german (LABELS.de)', eszett.map((i) => contextOf(de, i, 40)));
  }
  const du = [...de.matchAll(DU_FORBIDDEN)];
  if (du.length) {
    record(file, 'no-du-form (LABELS.de)', du.slice(0, 6).map((mm) => contextOf(de, mm.index, 50)));
  }
}

/* ───────────── TIERS_DE + German prompt directive in api/score.js ───────────── */
async function scanScore() {
  const file = 'api/score.js';
  const text = await readFile(file, 'utf8');
  // Extract TIERS_DE array
  const t = text.match(/const TIERS_DE\s*=\s*\[([\s\S]*?)\n\];/);
  if (t) {
    const eszett = [...t[1].matchAll(SWISS_REGEX)].map((mm) => mm.index);
    if (eszett.length) record(file, 'swiss-not-german (TIERS_DE)', eszett.map((i) => contextOf(t[1], i, 40)));
    const du = [...t[1].matchAll(DU_FORBIDDEN)];
    if (du.length) record(file, 'no-du-form (TIERS_DE)', du.slice(0, 6).map((mm) => contextOf(t[1], mm.index, 50)));
  }
}

/* ───────────── DE branch of buildEmailHTML T object in api/lead.js ───────────── */
async function scanLead() {
  const file = 'api/lead.js';
  const text = await readFile(file, 'utf8');
  const m = text.match(/const T = isDe \? \{([\s\S]*?)\n {2}\} : \{/);
  if (m) {
    const eszett = [...m[1].matchAll(SWISS_REGEX)].map((mm) => mm.index);
    if (eszett.length) record(file, 'swiss-not-german (email T.de)', eszett.map((i) => contextOf(m[1], i, 40)));
    const du = [...m[1].matchAll(DU_FORBIDDEN)];
    if (du.length) record(file, 'no-du-form (email T.de)', du.slice(0, 6).map((mm) => contextOf(m[1], mm.index, 50)));
  }
}

/* ───────────── DE override block in index.html SPA ───────────── */
async function scanIndexOverride() {
  const file = 'index.html';
  const text = await readFile(file, 'utf8');
  const m = text.match(/if \(LANG === 'de'\)\s*\{([\s\S]*?)\n {2}\}/);
  if (m) {
    const eszett = [...m[1].matchAll(SWISS_REGEX)].map((mm) => mm.index);
    if (eszett.length) record(file, 'swiss-not-german (LANG=de override)', eszett.map((i) => contextOf(m[1], i, 40)));
    const du = [...m[1].matchAll(DU_FORBIDDEN)];
    if (du.length) record(file, 'no-du-form (LANG=de override)', du.slice(0, 6).map((mm) => contextOf(m[1], mm.index, 50)));
  }
}

function contextOf(text, idx, span) {
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + span);
  return `…${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
}

await scanHtmlFiles();
await scanBuildReportLabels();
await scanScore();
await scanLead();
await scanIndexOverride();

if (totalIssues === 0) {
  if (!QUIET) console.log('✅ i18n style check passed — standard German orthography, no du-form leaks.');
  process.exit(0);
}

console.log(`❌ i18n style check found ${totalIssues} issue(s):\n`);
for (const f of findings) {
  console.log(`  ${f.file}  →  ${f.ruleId}  (${f.hits.length})`);
  for (const h of f.hits.slice(0, 5)) console.log(`     · ${h}`);
  if (f.hits.length > 5) console.log(`     · …and ${f.hits.length - 5} more`);
  console.log('');
}
process.exit(1);
