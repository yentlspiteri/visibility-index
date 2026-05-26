#!/usr/bin/env node
/*
 * i18n-seed.mjs — ONE-TIME migration of an already-translated page.
 *
 * Pairs the English source (e.g. privacy.html) with its existing hand-made
 * translation (de/privacy.html) by element position, and creates Approved
 * rows in the Notion translations DB. Use this only for pages that were
 * translated *before* the CMS existed. For new pages, use i18n-extract.
 *
 * Usage:
 *   node scripts/i18n-seed.mjs privacy                 # push to Notion
 *   node scripts/i18n-seed.mjs privacy --export f.json # write JSON, no Notion
 */
import { writeFile } from 'node:fs/promises';
import {
  PAGES, loadHtml, UNITS, readValue, normalize, contentKey,
  notionEnv, fetchAllRows, createRow,
} from './lib/i18n.mjs';

const page = process.argv[2];
const exportIdx = process.argv.indexOf('--export');
const exportFile = exportIdx > -1 ? process.argv[exportIdx + 1] : null;

if (!page || !PAGES[page]) {
  console.error(`Unknown page "${page}". Known: ${Object.keys(PAGES).join(', ')}`);
  process.exit(1);
}
const cfg = PAGES[page];

const { root: enRoot } = await loadHtml(cfg.en);
const { root: deRoot } = await loadHtml(cfg.de);

// Pair EN↔DE per selector, by index. Both files must share structure.
const byKey = new Map();
for (const unit of UNITS) {
  const enEls = enRoot.querySelectorAll(unit.sel);
  const deEls = deRoot.querySelectorAll(unit.sel);
  if (enEls.length !== deEls.length) {
    console.warn(`  ⚠ structure mismatch for "${unit.sel}": en=${enEls.length} de=${deEls.length} (skipping extras)`);
  }
  const n = Math.min(enEls.length, deEls.length);
  for (let i = 0; i < n; i++) {
    const en = normalize(readValue(enEls[i], unit));
    const de = normalize(readValue(deEls[i], unit));
    if (!en) continue;
    const key = contentKey(page, en);
    if (!byKey.has(key)) byKey.set(key, { key, page, en, de, element: unit.kind, status: de ? 'Approved' : 'Draft' });
  }
}
const rows = [...byKey.values()];
console.log(`Extracted ${rows.length} unique strings from ${cfg.en} ↔ ${cfg.de}`);

if (exportFile) {
  await writeFile(exportFile, JSON.stringify(rows, null, 2));
  console.log(`Wrote ${exportFile} (dry run — nothing sent to Notion).`);
  process.exit(0);
}

// Push to Notion, skipping keys that already exist.
const { token, db } = notionEnv();
const existing = new Set((await fetchAllRows(token, db)).map((r) => r.key));
let created = 0, skipped = 0;
for (const row of rows) {
  if (existing.has(row.key)) { skipped++; continue; }
  await createRow(token, db, row);
  created++;
  if (created % 10 === 0) console.log(`  …created ${created}`);
}
console.log(`Done. created=${created} skipped(existing)=${skipped} total=${rows.length}`);
