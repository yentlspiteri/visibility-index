#!/usr/bin/env node
/*
 * i18n-sync.mjs — regenerate de/<page>.html from Approved Notion rows.
 *
 * Clones the English source, swaps each translatable element's content with
 * its Approved German translation, fixes up <html lang>, canonical, and
 * og:locale, then writes the German file. Strings that are NOT Approved (or
 * have no DE yet) are left in English — so unreviewed copy never ships.
 *
 * Usage:
 *   node scripts/i18n-sync.mjs privacy                # pull from Notion
 *   node scripts/i18n-sync.mjs privacy --from f.json  # use a local JSON fixture
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  PAGES, loadHtml, collectUnits, writeValue, applyDeChrome, serialize,
  notionEnv, fetchAllRows,
} from './lib/i18n.mjs';

const page = process.argv[2];
const fromIdx = process.argv.indexOf('--from');
const fromFile = fromIdx > -1 ? process.argv[fromIdx + 1] : null;
const includeDrafts = process.argv.includes('--include-drafts'); // escape hatch for previewing

if (!page || !PAGES[page]) {
  console.error(`Unknown page "${page}". Known: ${Object.keys(PAGES).join(', ')}`);
  process.exit(1);
}
const cfg = PAGES[page];

// Build key → DE map, honouring the Approved gate.
const deByKey = new Map();
if (fromFile) {
  const rows = JSON.parse(await readFile(fromFile, 'utf8'));
  for (const r of rows) {
    if (r.page && r.page !== page) continue;
    if (!includeDrafts && r.status !== 'Approved') continue;
    if (r.de) deByKey.set(r.key, r.de);
  }
} else {
  const { token, db } = notionEnv();
  for (const r of await fetchAllRows(token, db)) {
    if (r.page !== page) continue;
    if (!includeDrafts && r.status !== 'Approved') continue;
    if (r.de) deByKey.set(r.key, r.de);
  }
}

const { raw, root } = await loadHtml(cfg.en);
const units = collectUnits(root, page);
let translated = 0;
const missing = [];
for (const u of units) {
  const de = deByKey.get(u.key);
  if (de == null) { missing.push(u); continue; }
  writeValue(u.el, u.unit, de);
  translated++;
}
applyDeChrome(root, page);
await writeFile(cfg.de, serialize(root, raw));

console.log(`sync ${page}: translated=${translated} untranslated=${missing.length} → ${cfg.de}`);
if (missing.length) {
  console.log('  Untranslated (still English) — needs an Approved DE row:');
  for (const u of missing.slice(0, 12)) console.log(`   · ${u.key} [${u.kind}] ${u.value.slice(0, 60)}`);
  if (missing.length > 12) console.log(`   …and ${missing.length - 12} more`);
}
