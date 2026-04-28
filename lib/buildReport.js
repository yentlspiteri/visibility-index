/**
 * lib/buildReport.js - generates a 7-page personalised PDF.
 * Pure pdf-lib (no Chromium), runs in Vercel serverless functions.
 *
 * Pages:
 *   1. Cover - "Hello, [FirstName]." (navy)
 *   2. Where you stand - personal hexagon + executive summary (cream)
 *   3. The six signals, explained (cream)
 *   4. Three moves this quarter - solo + with FutureMakers split (cream)
 *   5. Your 90-day timeline (navy)
 *   6. What we'd take off your plate - FutureMakers services, prioritised by their gaps (cream)
 *   7. "[FirstName], let's talk." (navy)
 *
 * Brand:
 * - Aileron + General Sans aren't shipped - using Helvetica with deck-matched weights/sizes.
 *     Drop .ttf files in lib/fonts/ and embed via fetch+embedFont to upgrade.
 * - Colors match FutureMakers / vonpeach.com tokens.
 * - Voice mirrors the master deck (FutureMakers section).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Locate the Fonts/ directory at the project root (../Fonts from this file's lib/ location)
const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, '..', 'Fonts');

// Load Aileron OTFs once per cold start, embed via fontkit (handles OpenType where StandardFonts can't)
async function loadAileron(pdf) {
  pdf.registerFontkit(fontkit);
  const [regBytes, boldBytes, blackBytes, italicBytes] = await Promise.all([
    readFile(join(FONTS_DIR, 'Aileron-Regular.otf')),
    readFile(join(FONTS_DIR, 'Aileron-Bold.otf')),
    readFile(join(FONTS_DIR, 'Aileron-Black.otf')),
    readFile(join(FONTS_DIR, 'Aileron-Italic.otf'))
  ]);
  // CRITICAL: `subset: false` - Aileron's OTF tables crash fontkit's checkInt/writeUInt8 path
  // when subsetting on certain glyph values from real LinkedIn content. Larger PDF (~600KB
  // bigger) but never crashes the function. Don't change without confirming the bug is fixed
  // upstream in @pdf-lib/fontkit.
  const reg    = await pdf.embedFont(regBytes,    { subset: false });
  const bold   = await pdf.embedFont(boldBytes,   { subset: false });
  const black  = await pdf.embedFont(blackBytes,  { subset: false });
  const italic = await pdf.embedFont(italicBytes, { subset: false });
  return { reg, bold, black, italic };
}

const COLOR = {
  navy:      rgb(0.043, 0.012, 0.349),  // #0B0359
  indigo:    rgb(0.247, 0.212, 0.698),  // #3F36B2
  lavender:  rgb(0.525, 0.514, 0.898),  // #8683E5
  ice:       rgb(0.922, 0.941, 1.000),  // #EBF0FF
  cream:     rgb(0.980, 0.980, 0.980),  // #fafafa
  black:     rgb(0.047, 0.043, 0.035),  // #0c0b09
  grey:      rgb(0.400, 0.400, 0.400),
  greyLight: rgb(0.700, 0.700, 0.700),
  ink:       rgb(0.20, 0.20, 0.25),     // softer than pure black for body copy on cream
  cream96:   rgb(0.92, 0.92, 0.92),
};

const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// Service token → human label + description from the Master Deck
const SERVICES = {
  strategy: { label: 'Brand strategy',     deck: 'A one-on-one deep dive to define your style, strengths, and the niche you are meant to own.' },
  content:  { label: 'Content production', deck: 'A strategic content plan that builds your credibility and amplifies your voice.' },
  video:    { label: 'Video',              deck: 'Tailored video storytelling: interviews, social cuts, scroll-stopping moments.' },
  photo:    { label: 'Photoshoot',         deck: 'On-brand photography that becomes the visual backbone of your presence.' },
  linkedin: { label: 'LinkedIn',           deck: 'We optimise your profile and run your channel so you stay focused on the work.' },
  speaker:  { label: 'Speaker kit',        deck: 'A standout speaker kit and stage coaching for keynotes and panels.' },
  pr:       { label: 'PR advisory',        deck: 'Press positioning, pitch development, and outlet relationships.' }
};

// Friendly labels per dimension key (mirrors page UI)
const DIMENSIONS = [
  { key: 'footprint', label: 'Digital Footprint', plain: 'What shows up when someone Googles you.' },
  { key: 'clarity',   label: 'Brand Clarity',     plain: 'Whether a stranger can explain what you do in one line.' },
  { key: 'authority', label: 'Authority Signals', plain: 'The proof that other people already vouch for you.' },
  { key: 'cadence',   label: 'Content Cadence',   plain: 'How often and how consistently you publish.' },
  { key: 'visual',    label: 'Visual Identity',   plain: 'Profile photo, banner, the small craft details.' },
  { key: 'network',   label: 'Network Recognition', plain: 'Whether your network actually knows what you stand for.' }
];

/* ─────────────────────────────────────── SANITIZE ─────────────────────────────────────── */
// Helvetica only encodes WinAnsi (basic Latin). Real LinkedIn profiles contain em-dashes,
// smart quotes, accented names, emoji - strip or substitute every offender.
// IMPORTANT: every regex character class below uses explicit Unicode escapes so a stray
// hyphen-minus can't be misinterpreted as a range operator (this was a real bug — the
// em-dash purge sed accidentally created a "[\x20-X]" range that ate ALL printable text).
function sanitizeText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25E6\u2043]/g, '*')
    .replace(/[\u2190\u2191\u2192\u2193\u21D0\u21D2]/g, '>')
    .replace(/[\u00A0\u2028\u2029\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}
function sanitizeReport(r) {
  if (!r) return r;
  const out = { ...r };
  ['firstName','lastName','headline','companyName','pictureUrl','executiveSummary'].forEach(k => {
    if (k in out) out[k] = sanitizeText(out[k]);
  });
  if (out.tier)     out.tier     = { ...out.tier,     name: sanitizeText(out.tier.name),     tagline: sanitizeText(out.tier.tagline),     blurb: sanitizeText(out.tier.blurb) };
  if (out.nextTier) out.nextTier = { ...out.nextTier, name: sanitizeText(out.nextTier.name), tagline: sanitizeText(out.nextTier.tagline), blurb: sanitizeText(out.nextTier.blurb) };
  if (out.dimensionCommentary && typeof out.dimensionCommentary === 'object') {
    const s = {};
    Object.entries(out.dimensionCommentary).forEach(([k,v]) => { s[k] = sanitizeText(v); });
    out.dimensionCommentary = s;
  }
  if (Array.isArray(out.moves)) {
    out.moves = out.moves.map(m => ({ ...m,
      title: sanitizeText(m.title), why: sanitizeText(m.why),
      firstStep: sanitizeText(m.firstStep), service: sanitizeText(m.service)
    }));
  }
  if (Array.isArray(out.tierRoadmap)) out.tierRoadmap = out.tierRoadmap.map(sanitizeText);
  return out;
}

/* ─────────────────────────────────────── ENTRY ─────────────────────────────────────── */
export async function buildReportPDF(rawReport) {
  const r = sanitizeReport(rawReport);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Visibility Index Report - ${r.firstName || ''}`.trim());
  pdf.setAuthor('Von Peach - FutureMakers');
  pdf.setCreator('Visibility Index');
  pdf.setSubject('Personalised executive visibility audit');

  // ─── FONT: Helvetica only. Aileron deferred. ───
  // Aileron + fontkit produced blank text rendering even with subset:false (full font embed).
  // Reverting to StandardFonts.Helvetica which is rock-solid: no readFile, no fontkit, no
  // encoding edge cases. Brand typography lives in headings + scale; body fidelity matters more
  // than the literal Aileron glyphs. Re-enable later once we have a repro test for the Aileron path.
  console.log('[buildReport] Using Helvetica (Aileron currently disabled)');
  const helv      = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold  = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl   = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const helvBlack = helvBold;
  const ctx = { pdf, helv, helvBold, helvObl, helvBlack };

  drawCover(ctx, r);
  drawWhereYouStand(ctx, r);
  drawSixSignals(ctx, r);
  drawThreeMoves(ctx, r);
  drawTimeline(ctx, r);
  drawWhatWeDo(ctx, r);
  drawClosingCTA(ctx, r);

  return pdf.save();
}

/* ─────────────────────────────────────── PAGE 1 - COVER ─────────────────────────────────────── */
function drawCover(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  // Full navy background
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.navy });

  // Eyebrow strip
  drawText(page, 'VON PEACH . FUTUREMAKERS . VISIBILITY INDEX', {
    x: MARGIN, y: PAGE_H - 60, size: 9, font: ctx.helvBold,
    color: COLOR.lavender, characterSpacing: 1.6
  });

  // Big personal greeting
  const firstName = r.firstName || 'You';
  drawText(page, `Hello, ${firstName}.`, {
    x: MARGIN, y: PAGE_H - 240, size: 56, font: ctx.helvBold, color: COLOR.cream
  });
  drawWrapped(page, "Here's how the world sees you today. And how to change it.", {
    x: MARGIN, y: PAGE_H - 290, maxWidth: CONTENT_W - 80,
    size: 18, font: ctx.helv, color: rgb(0.85, 0.85, 0.95), lineHeight: 24
  });

  // Score block - XX / 100
  const display = Math.round(((r.total ?? 0) / 18) * 100);
  drawText(page, String(display), {
    x: MARGIN, y: 280, size: 144, font: ctx.helvBold, color: COLOR.cream
  });
  drawText(page, '/ 100', {
    x: MARGIN + 20 + ctx.helvBold.widthOfTextAtSize(String(display), 144), y: 320,
    size: 28, font: ctx.helv, color: rgb(0.7, 0.7, 0.85)
  });

  // Tier name + tagline
  drawText(page, (r.tier?.name || '').toUpperCase(), {
    x: MARGIN, y: 230, size: 11, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.6
  });
  drawWrapped(page, r.tier?.tagline || '', {
    x: MARGIN, y: 200, maxWidth: CONTENT_W - 80,
    size: 16, font: ctx.helvObl, color: rgb(0.85, 0.85, 0.95), lineHeight: 22
  });

  // Bottom band
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 56, color: rgb(0.020, 0.006, 0.18) });
  drawText(page, 'A 7-page strategic memo. Specific to you.', {
    x: MARGIN, y: 22, size: 9, font: ctx.helv, color: COLOR.lavender, characterSpacing: 0.8
  });
  drawText(page, '01', {
    x: PAGE_W - MARGIN - 16, y: 22, size: 9, font: ctx.helvBold, color: COLOR.lavender
  });
}

/* ───────────────────────────── PAGE 2 - WHERE YOU STAND ───────────────────────────── */
function drawWhereYouStand(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'WHERE YOU STAND', PAGE_H - 60);
  drawText(page, `${r.firstName || 'Your'} shape, at a glance.`, {
    x: MARGIN, y: PAGE_H - 110, size: 32, font: ctx.helvBold, color: COLOR.black
  });

  // The personal hexagon - drawn natively in PDF coordinates
  const hexCx = PAGE_W / 2;
  const hexCy = PAGE_H - 360;
  const hexR  = 140;
  drawPersonalHexagon(ctx, page, r.subs || {}, hexCx, hexCy, hexR);

  // Executive summary (Claude-generated, 2 sentences)
  const summary = r.executiveSummary || `${r.firstName || 'You'}, you have real signals to build on. Here's what to tighten next.`;
  drawWrapped(page, summary, {
    x: MARGIN, y: hexCy - hexR - 60, maxWidth: CONTENT_W,
    size: 13, font: ctx.helv, color: COLOR.ink, lineHeight: 20
  });

  // Strength + gap pull-quotes
  const subs = r.subs || {};
  let strongest = { key: 'footprint', score: -1 };
  let weakest   = { key: 'footprint', score: 4  };
  Object.entries(subs).forEach(([k, v]) => {
    if (v > strongest.score) strongest = { key: k, score: v };
    if (v < weakest.score)   weakest   = { key: k, score: v };
  });
  const strongLabel = (DIMENSIONS.find(d => d.key === strongest.key) || {}).label || strongest.key;
  const weakLabel   = (DIMENSIONS.find(d => d.key === weakest.key)   || {}).label || weakest.key;

  // Two callout boxes side-by-side
  const cardY = 160;
  const cardH = 100;
  const cardW = (CONTENT_W - 16) / 2;
  // Strength card
  page.drawRectangle({ x: MARGIN, y: cardY, width: cardW, height: cardH,
    color: rgb(0.95, 0.96, 1.00), borderColor: COLOR.indigo, borderWidth: 1, borderOpacity: 0.2 });
  drawText(page, 'YOUR STRENGTH', {
    x: MARGIN + 18, y: cardY + cardH - 22, size: 9, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
  });
  drawWrapped(page, `${strongLabel}. Keep building from here.`, {
    x: MARGIN + 18, y: cardY + cardH - 44, maxWidth: cardW - 36,
    size: 14, font: ctx.helvBold, color: COLOR.black, lineHeight: 18
  });
  // Gap card
  const gapX = MARGIN + cardW + 16;
  page.drawRectangle({ x: gapX, y: cardY, width: cardW, height: cardH,
    color: rgb(0.96, 0.94, 1.00), borderColor: COLOR.lavender, borderWidth: 1, borderOpacity: 0.4 });
  drawText(page, 'BIGGEST OPPORTUNITY', {
    x: gapX + 18, y: cardY + cardH - 22, size: 9, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
  });
  drawWrapped(page, `${weakLabel}. Where the easy wins live.`, {
    x: gapX + 18, y: cardY + cardH - 44, maxWidth: cardW - 36,
    size: 14, font: ctx.helvBold, color: COLOR.black, lineHeight: 18
  });

  drawPageFooter(ctx, page, 2);
}

/* ───────────────────────────── PAGE 3 - SIX SIGNALS ───────────────────────────── */
function drawSixSignals(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'THE SIX SIGNALS', PAGE_H - 60);
  drawText(page, 'How each one looks for you.', {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });

  const subs = r.subs || {};
  const commentary = r.dimensionCommentary || {};
  let y = PAGE_H - 170;
  DIMENSIONS.forEach((d, i) => {
    const score = subs[d.key] ?? 0;
    // Score badge
    drawText(page, '0' + (i + 1), {
      x: MARGIN, y, size: 10, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
    });
    // Title + score
    drawText(page, d.label, {
      x: MARGIN + 36, y, size: 14, font: ctx.helvBold, color: COLOR.black
    });
    drawText(page, `${score} / 3`, {
      x: PAGE_W - MARGIN - 50, y, size: 12, font: ctx.helvBold, color: COLOR.indigo
    });
    // Score bar
    const barY = y - 12;
    page.drawRectangle({ x: MARGIN + 36, y: barY, width: CONTENT_W - 90, height: 4,
      color: rgb(0.88, 0.88, 0.92) });
    page.drawRectangle({ x: MARGIN + 36, y: barY, width: ((CONTENT_W - 90) * score) / 3, height: 4,
      color: COLOR.indigo });
    // Personal commentary
    const text = commentary[d.key] || d.plain;
    const newY = drawWrapped(page, text, {
      x: MARGIN + 36, y: y - 28, maxWidth: CONTENT_W - 72,
      size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 16
    });
    y = newY - 26;
  });

  drawPageFooter(ctx, page, 3);
}

/* ───────────────────────────── PAGE 4 - THREE MOVES ───────────────────────────── */
function drawThreeMoves(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'YOUR THREE MOVES', PAGE_H - 60);
  drawText(page, 'What to do this quarter.', {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, `${r.firstName || 'You'}, three highest-leverage moves drawn straight from your audit.`, {
    x: MARGIN, y: PAGE_H - 138, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 16
  });

  const moves = (Array.isArray(r.moves) && r.moves.length) ? r.moves.slice(0, 3) : [];
  let y = PAGE_H - 180;
  moves.forEach((m, i) => {
    const cardH = 200;
    const cardY = y - cardH;
    page.drawRectangle({
      x: MARGIN, y: cardY, width: CONTENT_W, height: cardH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
    });

    // Number badge
    drawText(page, '0' + (i + 1), {
      x: MARGIN + 20, y: y - 26, size: 12, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
    });
    // Title
    drawText(page, m.title || '', {
      x: MARGIN + 50, y: y - 26, size: 16, font: ctx.helvBold, color: COLOR.black
    });
    // Why
    drawWrapped(page, m.why || '', {
      x: MARGIN + 50, y: y - 50, maxWidth: CONTENT_W - 80,
      size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 15
    });

    // Solo column
    const soloX = MARGIN + 50;
    const helpX = MARGIN + 50 + (CONTENT_W - 80) / 2 + 12;
    const colY  = y - 100;
    drawText(page, 'YOU CAN DO THIS YOURSELF', {
      x: soloX, y: colY, size: 8, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.2
    });
    drawWrapped(page, m.firstStep || 'Start with the smallest version this week.', {
      x: soloX, y: colY - 18, maxWidth: (CONTENT_W - 80) / 2 - 12,
      size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 14
    });

    // Where we'd help column
    const svc = SERVICES[m.service] || SERVICES.strategy;
    drawText(page, 'WHERE WE WOULD HELP', {
      x: helpX, y: colY, size: 8, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.2
    });
    drawText(page, svc.label, {
      x: helpX, y: colY - 16, size: 11, font: ctx.helvBold, color: COLOR.indigo
    });
    drawWrapped(page, svc.deck, {
      x: helpX, y: colY - 32, maxWidth: (CONTENT_W - 80) / 2 - 12,
      size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 14
    });

    y = cardY - 16;
  });

  drawPageFooter(ctx, page, 4);
}

/* ───────────────────────────── PAGE 5 - 90-DAY TIMELINE ───────────────────────────── */
function drawTimeline(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.navy });

  drawText(page, 'YOUR 90 DAYS', {
    x: MARGIN, y: PAGE_H - 60, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.6
  });
  drawText(page, `${r.firstName || 'Your'} execution map.`, {
    x: MARGIN, y: PAGE_H - 110, size: 32, font: ctx.helvBold, color: COLOR.cream
  });
  drawWrapped(page, 'A 90-day rhythm drawn from your three moves. The simple stuff stays with you. The heavy lifting is where we come in.', {
    x: MARGIN, y: PAGE_H - 145, maxWidth: CONTENT_W - 60,
    size: 12, font: ctx.helv, color: rgb(0.85, 0.85, 0.95), lineHeight: 17
  });

  const moves = Array.isArray(r.moves) ? r.moves : [];
  const phases = [
    {
      title: 'Week 1 - Define',
      sub:   'The thinking. Do this alone, in a coffee shop, with a notebook.',
      tag:   'Solo',
      body:  moves[0]?.firstStep || 'Rewrite your headline so a stranger could explain what you do in one line.'
    },
    {
      title: 'Weeks 2-4 - Strategy',
      sub:   'Lay the foundation: content cadence, voice, three pillar topics.',
      tag:   'Solo or with us',
      body:  'Block 60 minutes Friday morning. Plan four posts that argue your three pillars. We can run this as a half-day strategy session if it stalls.'
    },
    {
      title: 'Month 2 - Production',
      sub:   'Make scroll-stopping moments. This is where we do most of the work.',
      tag:   'With FutureMakers',
      body:  moves[1]?.firstStep || 'Photography, video, banner refresh, signature post format. Hard to do alone, fast with the right team.'
    },
    {
      title: 'Month 3 - Activation',
      sub:   'Convert presence into pipeline: speaking, press, the right rooms.',
      tag:   'Hybrid',
      body:  moves[2]?.firstStep || 'Pitch one keynote. Pitch one tier-1 publication. We help you pick the targets and draft the pitches.'
    }
  ];

  let y = PAGE_H - 200;
  phases.forEach((phase, i) => {
    const cardH = 110;
    const cardY = y - cardH;
    page.drawRectangle({
      x: MARGIN, y: cardY, width: CONTENT_W, height: cardH,
      color: rgb(0.07, 0.04, 0.32),
      borderColor: rgb(0.30, 0.27, 0.55), borderWidth: 1
    });
    // Phase title
    drawText(page, phase.title, {
      x: MARGIN + 22, y: y - 28, size: 16, font: ctx.helvBold, color: COLOR.cream
    });
    // Tag pill
    const tagW = ctx.helvBold.widthOfTextAtSize(phase.tag, 9) + 22;
    const tagColor = phase.tag === 'Solo' ? COLOR.lavender
                    : phase.tag === 'With FutureMakers' ? COLOR.indigo
                    : rgb(0.6, 0.45, 0.85);
    page.drawRectangle({
      x: PAGE_W - MARGIN - 22 - tagW, y: y - 32, width: tagW, height: 22,
      color: tagColor, opacity: 0.25, borderColor: tagColor, borderWidth: 1
    });
    drawText(page, phase.tag.toUpperCase(), {
      x: PAGE_W - MARGIN - 22 - tagW + 11, y: y - 26, size: 8, font: ctx.helvBold,
      color: COLOR.cream, characterSpacing: 1.2
    });
    // Sub
    drawWrapped(page, phase.sub, {
      x: MARGIN + 22, y: y - 50, maxWidth: CONTENT_W - 44,
      size: 10, font: ctx.helvObl, color: COLOR.lavender, lineHeight: 14
    });
    // Body
    drawWrapped(page, phase.body, {
      x: MARGIN + 22, y: y - 76, maxWidth: CONTENT_W - 44,
      size: 11, font: ctx.helv, color: rgb(0.88, 0.88, 0.95), lineHeight: 15
    });
    y = cardY - 12;
  });

  drawPageFooter(ctx, page, 5, { dark: true });
}

/* ───────────────────────────── PAGE 6 - WHAT WE'D TAKE OFF YOUR PLATE ───────────────────────────── */
function drawWhatWeDo(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'FUTUREMAKERS', PAGE_H - 60);
  drawText(page, "What we'd take off your plate.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, `${r.firstName || 'You'}, here's where we would focus first based on your shape - ordered by relevance to your gaps.`, {
    x: MARGIN, y: PAGE_H - 142, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 17
  });

  // Map dimension keys → relevant services in priority order based on the user's lowest scores
  const subs = r.subs || {};
  const dimToService = {
    footprint: ['linkedin', 'pr'],
    clarity:   ['strategy', 'content'],
    authority: ['pr', 'speaker'],
    cadence:   ['content', 'strategy'],
    visual:    ['photo', 'video'],
    network:   ['linkedin', 'content']
  };
  // Walk dimensions sorted by lowest score, collect services in order, dedupe.
  const sortedDims = DIMENSIONS.slice().sort((a, b) => (subs[a.key] ?? 3) - (subs[b.key] ?? 3));
  const seen = new Set();
  const ordered = [];
  sortedDims.forEach(d => {
    (dimToService[d.key] || []).forEach(svc => {
      if (!seen.has(svc)) { seen.add(svc); ordered.push({ svc, drivenBy: d.label }); }
    });
  });

  // Render top 4 service cards in a 2x2 grid
  const top = ordered.slice(0, 4);
  const colW = (CONTENT_W - 16) / 2;
  const rowH = 160;
  let y = PAGE_H - 200;
  top.forEach((entry, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * (colW + 16);
    const cy = y - row * (rowH + 16);
    page.drawRectangle({
      x, y: cy - rowH, width: colW, height: rowH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
    });
    drawText(page, '0' + (i + 1), {
      x: x + 18, y: cy - 26, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.4
    });
    const svc = SERVICES[entry.svc] || SERVICES.strategy;
    drawText(page, svc.label, {
      x: x + 18, y: cy - 50, size: 17, font: ctx.helvBold, color: COLOR.black
    });
    drawWrapped(page, svc.deck, {
      x: x + 18, y: cy - 74, maxWidth: colW - 36,
      size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 14
    });
    drawText(page, `Closes the gap on ${entry.drivenBy}`, {
      x: x + 18, y: cy - rowH + 22, size: 9, font: ctx.helvObl, color: COLOR.indigo
    });
  });

  // Promise band at bottom
  const bandY = 90;
  page.drawRectangle({
    x: MARGIN, y: bandY, width: CONTENT_W, height: 110,
    color: COLOR.navy
  });
  drawText(page, 'OUR PROMISE', {
    x: MARGIN + 24, y: bandY + 80, size: 9, font: ctx.helvBold,
    color: COLOR.lavender, characterSpacing: 1.6
  });
  drawWrapped(page, 'Your story already has its purpose. We give it the presence it deserves.', {
    x: MARGIN + 24, y: bandY + 60, maxWidth: CONTENT_W - 48,
    size: 14, font: ctx.helvObl, color: COLOR.cream, lineHeight: 19
  });

  drawPageFooter(ctx, page, 6);
}

/* ───────────────────────────── PAGE 7 - CLOSING CTA ───────────────────────────── */
function drawClosingCTA(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.navy });

  drawText(page, 'LET\'S TALK', {
    x: MARGIN, y: PAGE_H - 60, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.6
  });

  // Massive personal CTA
  drawText(page, `${r.firstName || 'Hey'},`, {
    x: MARGIN, y: PAGE_H - 280, size: 64, font: ctx.helvBold, color: COLOR.cream
  });
  drawText(page, "let's build it.", {
    x: MARGIN, y: PAGE_H - 350, size: 64, font: ctx.helvBold, color: COLOR.lavender
  });

  drawWrapped(page, "30 minutes. No pitch. We walk through your audit, you ask questions, we tell you what we would do first if you were our client.", {
    x: MARGIN, y: PAGE_H - 420, maxWidth: CONTENT_W - 80,
    size: 14, font: ctx.helv, color: rgb(0.88, 0.88, 0.95), lineHeight: 21
  });

  // Calendly button-styled box
  const btnY = 320;
  const btnW = 360;
  page.drawRectangle({
    x: MARGIN, y: btnY, width: btnW, height: 60,
    color: COLOR.cream
  });
  drawText(page, 'BOOK A 30-MIN CALL', {
    x: MARGIN + 30, y: btnY + 32, size: 12, font: ctx.helvBold,
    color: COLOR.navy, characterSpacing: 1.6
  });
  drawText(page, 'calendly.com/yentl-spiteri/30min', {
    x: MARGIN + 30, y: btnY + 14, size: 10, font: ctx.helv, color: COLOR.indigo
  });

  // Promise line above the bottom band
  drawWrapped(page, '"Your story already has its purpose. We give it the presence it deserves."', {
    x: MARGIN, y: 180, maxWidth: CONTENT_W,
    size: 14, font: ctx.helvObl, color: COLOR.lavender, lineHeight: 20
  });

  // Bottom band
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 70, color: rgb(0.020, 0.006, 0.18) });
  drawText(page, 'VON PEACH GMBH . FUTUREMAKERS . VISIBILITY INDEX', {
    x: MARGIN, y: 28, size: 9, font: ctx.helvBold,
    color: COLOR.lavender, characterSpacing: 1.6
  });
  drawText(page, 'hello@vonpeach.com', {
    x: PAGE_W - MARGIN - ctx.helv.widthOfTextAtSize('hello@vonpeach.com', 9),
    y: 28, size: 9, font: ctx.helv, color: COLOR.lavender
  });
}

/* ─────────────────────────────────────── HELPERS ─────────────────────────────────────── */

// Section eyebrow: small uppercase tag at top-left of cream content pages
function drawSectionEyebrow(ctx, page, label, y) {
  drawText(page, label, {
    x: MARGIN, y, size: 9, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.6
  });
}

// Page footer: thin line + page number + brand mark
function drawPageFooter(ctx, page, pageNum, opts = {}) {
  const dark = opts.dark || false;
  const lineColor = dark ? rgb(0.30, 0.27, 0.55) : rgb(0.85, 0.85, 0.92);
  const textColor = dark ? COLOR.lavender : COLOR.grey;
  page.drawLine({
    start: { x: MARGIN, y: 60 }, end: { x: PAGE_W - MARGIN, y: 60 },
    thickness: 0.6, color: lineColor
  });
  drawText(page, 'VON PEACH . FUTUREMAKERS', {
    x: MARGIN, y: 38, size: 8, font: ctx.helvBold, color: textColor, characterSpacing: 1.4
  });
  drawText(page, String(pageNum).padStart(2, '0'), {
    x: PAGE_W - MARGIN - 16, y: 38, size: 8, font: ctx.helvBold, color: textColor
  });
}

// Draw the personal hexagon - the user's actual scores as 6 purple wedges from center.
// Mirrors the on-page design so the report feels continuous with the audit.
function drawPersonalHexagon(ctx, page, subs, cx, cy, R) {
  // Hexagon vertices - top, upper-right, lower-right, bottom, lower-left, upper-left
  const angle = (i) => -Math.PI / 2 + i * (Math.PI / 3);
  const VERTS = [];
  for (let i = 0; i < 6; i++) {
    VERTS.push({
      x: cx + R * Math.cos(angle(i)),
      y: cy + R * Math.sin(angle(i))
    });
  }
  // Outer hex outline (faint)
  drawPolygon(page, VERTS, { stroke: COLOR.lavender, strokeOpacity: 0.25, strokeWidth: 1 });
  // Three concentric rings at 1/3, 2/3
  for (const t of [0.333, 0.667]) {
    const ring = VERTS.map(v => ({
      x: cx + (v.x - cx) * t,
      y: cy + (v.y - cy) * t
    }));
    drawPolygon(page, ring, { stroke: COLOR.lavender, strokeOpacity: 0.18, strokeWidth: 0.8 });
  }
  // Spokes
  VERTS.forEach(v => {
    page.drawLine({
      start: { x: cx, y: cy }, end: { x: v.x, y: v.y },
      thickness: 0.5, color: COLOR.lavender, opacity: 0.2
    });
  });

  // User's points along each spoke based on score (0-3)
  const dimKeys = ['footprint','clarity','authority','cadence','visual','network'];
  const userPts = dimKeys.map((k, i) => {
    const score = subs[k] ?? 0;
    const t = score / 3;
    return {
      x: cx + (VERTS[i].x - cx) * t,
      y: cy + (VERTS[i].y - cy) * t,
      key: k,
      score
    };
  });

  // Six purple wedges - each triangle from center → userPts[i] → userPts[i+1]
  const PURPLES = [
    rgb(0.165, 0.122, 0.549),
    rgb(0.247, 0.212, 0.698),
    rgb(0.353, 0.314, 0.800),
    rgb(0.459, 0.439, 0.851),
    rgb(0.525, 0.514, 0.898),
    rgb(0.651, 0.643, 0.929)
  ];
  for (let i = 0; i < 6; i++) {
    const a = userPts[i];
    const b = userPts[(i + 1) % 6];
    drawPolygon(page, [{ x: cx, y: cy }, a, b], {
      fill: PURPLES[i], fillOpacity: 0.85
    });
  }
  // White outline tying user shape together
  drawPolygon(page, userPts, {
    stroke: COLOR.cream, strokeWidth: 1.5, strokeOpacity: 1
  });

  // Vertex labels
  const dimLabels = ['Footprint','Clarity','Authority','Cadence','Visual','Network'];
  VERTS.forEach((v, i) => {
    // Node dot
    page.drawCircle({ x: v.x, y: v.y, size: 3, color: COLOR.indigo });
    // Label position outside the vertex
    const labelOffset = 18;
    const dx = (v.x - cx) / R * labelOffset;
    const dy = (v.y - cy) / R * labelOffset;
    const lx = v.x + dx;
    const ly = v.y + dy;
    const score = subs[dimKeys[i]] ?? 0;
    const labelText = `${dimLabels[i]} ${score}/3`;
    const w = ctx.helvBold.widthOfTextAtSize(labelText, 9);
    // Center the text horizontally based on which side of the hex
    let textX = lx;
    if (i === 0 || i === 3) textX = lx - w / 2;          // top, bottom - center
    else if (i === 1 || i === 2) textX = lx;             // right side - left-anchor
    else textX = lx - w;                                  // left side - right-anchor
    drawText(page, labelText, {
      x: textX, y: ly - 3, size: 9, font: ctx.helvBold, color: COLOR.black
    });
  });
}

// Convenience polygon drawer (pdf-lib doesn't have one)
function drawPolygon(page, points, opts = {}) {
  if (!points || points.length < 3) return;
  // Draw as a path via repeated drawLine calls - sufficient for our visual fidelity
  if (opts.fill) {
    // Approximate fill via a series of triangles from the first point
    // pdf-lib supports drawPath for SVG paths, but we keep this simple
    const first = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const path = `M ${first.x} ${PAGE_H - first.y} L ${points[i].x} ${PAGE_H - points[i].y} L ${points[i+1].x} ${PAGE_H - points[i+1].y} Z`;
      page.drawSvgPath(path, {
        color: opts.fill,
        opacity: opts.fillOpacity ?? 1,
        borderWidth: 0
      });
    }
  }
  if (opts.stroke) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      page.drawLine({
        start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
        thickness: opts.strokeWidth || 1,
        color: opts.stroke,
        opacity: opts.strokeOpacity ?? 1
      });
    }
  }
}

// Single-line text drawing - sanitizes input so any stray Unicode literal gets stripped
function drawText(page, text, opts) {
  const { x, y, size, font, color, characterSpacing } = opts;
  page.drawText(sanitizeText(String(text || '')), {
    x, y, size, font, color,
    ...(characterSpacing ? { characterSpacing } : {})
  });
}

// Word-wrap helper. Returns the y-coordinate of the LAST line drawn.
function drawWrapped(page, text, opts) {
  const { x, y, maxWidth, size, font, color, lineHeight } = opts;
  const safe = sanitizeText(String(text || '')).replace(/\s+/g, ' ').trim();
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
