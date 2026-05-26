#!/usr/bin/env node
/*
 * i18n-extract.mjs — push English strings from a page into Notion as Draft rows.
 *
 * This is the ongoing workflow for NEW pages (and for new strings on existing
 * pages): it reads the English source, finds every translatable string, and
 * creates a Draft row for any key Notion doesn't already have. It never touches
 * the DE column or the Status of existing rows — Notion stays the source of
 * truth for translations.
 *
 * After running this, your team fills the DE column in Notion and flips Status
 * to Approved; then `npm run i18n:sync <page>` regenerates de/<page>.html.
 *
 * Usage:
 *   node scripts/i18n-extract.mjs free-personal-brand-audit
 *   node scripts/i18n-extract.mjs privacy --export new-strings.json
 */
import { writeFile } from 'node:fs/promises';
import {
  PAGES, loadHtml, collectUnits, notionEnv, fetchAllRows, createRow,
} from './lib/i18n.mjs';

const page = process.argv[2];
const exportIdx = process.argv.indexOf('--export');
const exportFile = exportIdx > -1 ? process.argv[exportIdx + 1] : null;

if (!page || !PAGES[page]) {
  console.error(`Unknown page "${page}". Known: ${Object.keys(PAGES).join(', ')}`);
  process.exit(1);
}
const cfg = PAGES[page];

const { root } = await loadHtml(cfg.en);
// Dedupe by key (identical English shares one row / one translation).
const byKey = new Map();
for (const u of collectUnits(root, page)) {
  if (!byKey.has(u.key)) byKey.set(u.key, { key: u.key, page, en: u.value, de: '', element: u.kind, status: 'Draft' });
}
const rows = [...byKey.values()];
console.log(`Found ${rows.length} unique translatable strings in ${cfg.en}`);

if (exportFile) {
  await writeFile(exportFile, JSON.stringify(rows, null, 2));
  console.log(`Wrote ${exportFile} (dry run — nothing sent to Notion).`);
  process.exit(0);
}

const { token, db } = notionEnv();
const existing = new Set((await fetchAllRows(token, db)).map((r) => r.key));
let created = 0, skipped = 0;
for (const row of rows) {
  if (existing.has(row.key)) { skipped++; continue; }
  await createRow(token, db, row);
  created++;
}
console.log(`Done. created=${created} skipped(existing)=${skipped}. Now translate the Draft rows in Notion.`);
