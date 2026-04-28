/**
 * lib/buildReport.js — generates a 4-page personalised PDF from the analysis payload.
 * Pure pdf-lib (no Chromium), runs in Vercel serverless functions.
 *
 * Brand:
 *   - Aileron + General Sans aren't shipped — using Helvetica for v1.
 *     For v1.1 we can embed the .ttf files via fetch+embedFont.
 *   - Colors match the FutureMakers / vonpeach.com tokens.
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';

const COLOR = {
  navy:      rgb(0.043, 0.012, 0.349),  // #0B0359
  indigo:    rgb(0.247, 0.212, 0.698),  // #3F36B2
  lavender:  rgb(0.525, 0.514, 0.898),  // #8683E5
  ice:       rgb(0.922, 0.941, 1.000),  // #EBF0FF
  cream:     rgb(0.980, 0.980, 0.980),  // #fafafa
  black:     rgb(0.047, 0.043, 0.035),  // #0c0b09
  grey:      rgb(0.400, 0.400, 0.400),  // #666
  greyLight: rgb(0.700, 0.700, 0.700),
};

const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// Service token → human label (mirrors SERVICE_LABELS in the frontend)
const SERVICE_LABEL = {
  strategy: 'Brand strategy',
  content:  'Content production',
  video:    'Video',
  photo:    'Photoshoot',
  linkedin: 'LinkedIn',
  speaker:  'Speaking kit',
  pr:       'PR advisory'
};

/**
 * Sanitize text for the StandardFonts.Helvetica family — only WinAnsi (basic Latin) is supported.
 * Real LinkedIn profiles regularly contain em-dashes, smart quotes, accented characters, emoji,
 * and Unicode bullets. Without this pass, pdf-lib throws "WinAnsi cannot encode" and the entire
 * PDF build fails — which then skips the email step. Replace common offenders, drop everything else.
 */
function sanitizeText(s) {
  if (s == null) return '';
  return String(s)
    // Smart quotes → straight
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    // Em/en dash → hyphen
    .replace(/[–—−]/g, '-')
    // Ellipsis → three dots
    .replace(/…/g, '...')
    // Bullet variants → asterisk
    .replace(/[•◦⁃]/g, '*')
    // Non-breaking and other exotic spaces → regular space
    .replace(/[  -​  　]/g, ' ')
    // Drop anything outside basic WinAnsi-safe range (covers emoji, CJK, math symbols, etc.)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}
function sanitizeReport(r) {
  if (!r) return r;
  const out = { ...r };
  // Walk the string fields we know about
  const stringKeys = ['firstName', 'lastName', 'headline', 'companyName', 'pictureUrl', 'executiveSummary'];
  stringKeys.forEach(k => { if (k in out) out[k] = sanitizeText(out[k]); });
  // Tier object
  if (out.tier)     out.tier     = { ...out.tier,     name: sanitizeText(out.tier.name),     tagline: sanitizeText(out.tier.tagline),     blurb: sanitizeText(out.tier.blurb) };
  if (out.nextTier) out.nextTier = { ...out.nextTier, name: sanitizeText(out.nextTier.name), tagline: sanitizeText(out.nextTier.tagline), blurb: sanitizeText(out.nextTier.blurb) };
  // Dimension commentary (string-keyed object)
  if (out.dimensionCommentary && typeof out.dimensionCommentary === 'object') {
    const sanitized = {};
    Object.entries(out.dimensionCommentary).forEach(([k, v]) => { sanitized[k] = sanitizeText(v); });
    out.dimensionCommentary = sanitized;
  }
  // Moves array
  if (Array.isArray(out.moves)) {
    out.moves = out.moves.map(m => ({ ...m,
      title:     sanitizeText(m.title),
      why:       sanitizeText(m.why),
      firstStep: sanitizeText(m.firstStep),
      service:   sanitizeText(m.service)
    }));
  }
  // Tier roadmap (array of strings)
  if (Array.isArray(out.tierRoadmap)) {
    out.tierRoadmap = out.tierRoadmap.map(sanitizeText);
  }
  return out;
}

export async function buildReportPDF(rawReport) {
  // Sanitize ALL string inputs for WinAnsi compatibility before any pdf-lib drawing happens.
  // This is the #1 cause of PDF build failures on real LinkedIn profiles.
  const report = sanitizeReport(rawReport);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Visibility Index Report - ${report.firstName || ''}`.trim());
  pdf.setAuthor('Von Peach - FutureMakers');
  pdf.setCreator('Visibility Index');
  pdf.setSubject('Personalised executive visibility audit');

  const helv     = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl  = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const ctx = { pdf, helv, helvBold, helvObl };

  drawCoverPage(ctx, report);
  drawDimensionsPage(ctx, report);
  drawMovesPage(ctx, report);
  drawRoadmapPage(ctx, report);

  return pdf.save();   // → Uint8Array
}

/* ─────────────────── Page 1 — Cover + Executive Summary ─────────────────── */
function drawCoverPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);

  // Dark navy band at top (~40% of page)
  page.drawRectangle({ x: 0, y: PAGE_H - 320, width: PAGE_W, height: 320, color: COLOR.navy });

  // Eyebrow
  drawText(page, 'VON PEACH · FUTUREMAKERS · VISIBILITY INDEX', {
    x: MARGIN, y: PAGE_H - 60, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.4
  });

  // Generated for + date
  const meta = `Generated for ${r.firstName || 'you'}${r.headline ? ' · ' + truncate(r.headline, 60) : ''}`;
  drawText(page, meta, {
    x: MARGIN, y: PAGE_H - 80, size: 9, font: ctx.helv, color: rgb(0.85, 0.85, 0.95)
  });

  // Big score
  drawText(page, String(r.total ?? 0), {
    x: MARGIN, y: PAGE_H - 180, size: 96, font: ctx.helvBold, color: COLOR.cream
  });
  drawText(page, '/ 18', {
    x: MARGIN + 110, y: PAGE_H - 230, size: 24, font: ctx.helv, color: rgb(0.7, 0.7, 0.85)
  });

  // Tier name
  drawText(page, (r.tier?.name || '').toUpperCase(), {
    x: MARGIN, y: PAGE_H - 250, size: 12, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.2
  });
  drawText(page, r.tier?.tagline || '', {
    x: MARGIN, y: PAGE_H - 280, size: 11, font: ctx.helvObl, color: rgb(0.85, 0.85, 0.95)
  });

  // Body section (light area)
  const greet = `${r.firstName || 'You'}, here's where you stand.`;
  drawText(page, greet, {
    x: MARGIN, y: PAGE_H - 380, size: 24, font: ctx.helvBold, color: COLOR.black
  });

  // Executive summary (wrapped paragraph)
  const summary = r.executiveSummary || 'Your full audit is in the pages that follow.';
  drawWrapped(page, summary, {
    x: MARGIN, y: PAGE_H - 420, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.black, lineHeight: 18
  });

  // Footer
  drawFooter(ctx, page, 1);
}

/* ─────────────────── Page 2 — Six dimensions ─────────────────── */
function drawDimensionsPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  drawSectionHeader(ctx, page, 'WHERE YOU STAND', 'The six dimensions, scored 0–3.');

  const dims = [
    { key: 'footprint', label: 'Digital Footprint' },
    { key: 'clarity',   label: 'Brand Clarity' },
    { key: 'authority', label: 'Authority Signals' },
    { key: 'cadence',   label: 'Content Cadence' },
    { key: 'visual',    label: 'Visual Identity' },
    { key: 'network',   label: 'Network Recognition' }
  ];
  let y = PAGE_H - 200;

  for (const d of dims) {
    const score = r.subs?.[d.key] ?? 0;
    const commentary = r.dimensionCommentary?.[d.key] || '';

    // Dimension label + score
    drawText(page, d.label.toUpperCase(), {
      x: MARGIN, y, size: 10, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.0
    });
    drawText(page, `${score} / 3`, {
      x: PAGE_W - MARGIN - 40, y, size: 12, font: ctx.helvBold, color: COLOR.black
    });

    // Score bar
    y -= 14;
    page.drawRectangle({
      x: MARGIN, y, width: CONTENT_W, height: 3, color: rgb(0.9, 0.9, 0.94)
    });
    page.drawRectangle({
      x: MARGIN, y, width: CONTENT_W * (score / 3), height: 3, color: COLOR.indigo
    });

    // Commentary
    y -= 12;
    const newY = drawWrapped(page, commentary, {
      x: MARGIN, y, maxWidth: CONTENT_W,
      size: 10.5, font: ctx.helv, color: COLOR.grey, lineHeight: 14
    });
    y = newY - 22;
  }

  drawFooter(ctx, page, 2);
}

/* ─────────────────── Page 3 — Three highest-leverage moves ─────────────────── */
function drawMovesPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  drawSectionHeader(ctx, page, 'YOUR HIGHEST-LEVERAGE MOVES', 'Three things to fix this quarter.');

  const moves = (r.moves && r.moves.length) ? r.moves : [];
  let y = PAGE_H - 200;

  moves.forEach((m, i) => {
    // Number
    drawText(page, '0' + (i + 1), {
      x: MARGIN, y, size: 10, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.0
    });
    // Service tag (right-aligned)
    const serviceLabel = (SERVICE_LABEL[m.service] || 'Brand strategy').toUpperCase();
    const serviceWidth = ctx.helvBold.widthOfTextAtSize(serviceLabel, 8);
    drawText(page, serviceLabel, {
      x: PAGE_W - MARGIN - serviceWidth, y: y + 1, size: 8, font: ctx.helvBold,
      color: COLOR.indigo, characterSpacing: 1.2
    });

    // Title
    y -= 22;
    y = drawWrapped(page, m.title || '', {
      x: MARGIN, y, maxWidth: CONTENT_W,
      size: 16, font: ctx.helvBold, color: COLOR.black, lineHeight: 22
    });

    // Why
    y -= 10;
    y = drawWrapped(page, m.why || '', {
      x: MARGIN, y, maxWidth: CONTENT_W,
      size: 11, font: ctx.helv, color: COLOR.grey, lineHeight: 16
    });

    // First step (callout)
    y -= 14;
    page.drawRectangle({
      x: MARGIN, y: y - 36, width: CONTENT_W, height: 44,
      color: rgb(0.97, 0.97, 1.0),
      borderColor: COLOR.indigo, borderWidth: 0
    });
    page.drawRectangle({
      x: MARGIN, y: y - 36, width: 3, height: 44, color: COLOR.indigo
    });
    drawText(page, 'FIRST STEP TODAY', {
      x: MARGIN + 12, y: y - 6, size: 8, font: ctx.helvBold,
      color: COLOR.indigo, characterSpacing: 1.4
    });
    drawWrapped(page, m.firstStep || '', {
      x: MARGIN + 12, y: y - 22, maxWidth: CONTENT_W - 24,
      size: 10, font: ctx.helv, color: COLOR.black, lineHeight: 14
    });
    y -= 60;
  });

  drawFooter(ctx, page, 3);
}

/* ─────────────────── Page 4 — Tier roadmap + Services + CTA ─────────────────── */
function drawRoadmapPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  const tierName = r.tier?.name || 'your tier';
  const nextName = r.nextTier?.name || 'the next tier';
  const goingUp  = r.nextTier && r.nextTier.min > (r.tier?.max ?? 0);
  const heading  = goingUp ? `From ${tierName} to ${nextName}` : `Sharpening the ${tierName} edge`;

  drawSectionHeader(ctx, page, 'PATH FORWARD', heading);

  // Roadmap bullets
  const roadmap = (r.tierRoadmap && r.tierRoadmap.length) ? r.tierRoadmap : [];
  let y = PAGE_H - 210;
  roadmap.forEach((item) => {
    drawText(page, '→', {
      x: MARGIN, y, size: 12, font: ctx.helvBold, color: COLOR.indigo
    });
    y = drawWrapped(page, item, {
      x: MARGIN + 20, y, maxWidth: CONTENT_W - 20,
      size: 11, font: ctx.helv, color: COLOR.black, lineHeight: 16
    });
    y -= 14;
  });

  // Services band
  y -= 12;
  page.drawRectangle({
    x: MARGIN, y: y - 200, width: CONTENT_W, height: 200,
    color: COLOR.navy
  });
  drawText(page, 'HOW WE HELP YOU ACTION THIS', {
    x: MARGIN + 24, y: y - 30, size: 10, font: ctx.helvBold,
    color: COLOR.lavender, characterSpacing: 1.3
  });
  drawText(page, 'FutureMakers — by Von Peach', {
    x: MARGIN + 24, y: y - 54, size: 18, font: ctx.helvBold, color: COLOR.cream
  });
  const blurb = 'A high-touch personal brand programme. Strategy, content, video, photoshoot, LinkedIn, speaking kit, PR — depending on what your tier needs most.';
  drawWrapped(page, blurb, {
    x: MARGIN + 24, y: y - 80, maxWidth: CONTENT_W - 48,
    size: 10.5, font: ctx.helv, color: rgb(0.85, 0.85, 0.95), lineHeight: 15
  });
  drawText(page, 'BOOK A 30-MIN CALL  →  calendly.com/yentl-spiteri/30min', {
    x: MARGIN + 24, y: y - 175, size: 10, font: ctx.helvBold,
    color: COLOR.cream, characterSpacing: 1.0
  });

  drawFooter(ctx, page, 4);
}

/* ─────────────────── helpers ─────────────────── */
function drawSectionHeader(ctx, page, eyebrow, title) {
  drawText(page, eyebrow, {
    x: MARGIN, y: PAGE_H - 80, size: 9, font: ctx.helvBold,
    color: COLOR.indigo, characterSpacing: 1.4
  });
  drawText(page, title, {
    x: MARGIN, y: PAGE_H - 130, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  // Hairline separator
  page.drawRectangle({
    x: MARGIN, y: PAGE_H - 160, width: 60, height: 2, color: COLOR.indigo
  });
}

function drawFooter(ctx, page, pageNum) {
  drawText(page, 'VON PEACH · FUTUREMAKERS', {
    x: MARGIN, y: 40, size: 8, font: ctx.helvBold,
    color: COLOR.grey, characterSpacing: 1.2
  });
  const pageStr = `${pageNum} / 4`;
  const w = ctx.helv.widthOfTextAtSize(pageStr, 8);
  drawText(page, pageStr, {
    x: PAGE_W - MARGIN - w, y: 40, size: 8, font: ctx.helv, color: COLOR.greyLight
  });
}

function drawText(page, text, opts) {
  const { x, y, size, font, color, characterSpacing } = opts;
  page.drawText(String(text || ''), {
    x, y, size, font, color,
    ...(characterSpacing ? { characterSpacing } : {})
  });
}

// Word-wrap helper. Returns the y-coordinate of the LAST line drawn.
function drawWrapped(page, text, opts) {
  const { x, y, maxWidth, size, font, color, lineHeight } = opts;
  const safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (!safe) return y;
  const words = safe.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    const w = font.widthOfTextAtSize(test, size);
    if (w > maxWidth && line) {
      page.drawText(line, { x, y: curY, size, font, color });
      curY -= lineHeight;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y: curY, size, font, color });
  }
  return curY;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
