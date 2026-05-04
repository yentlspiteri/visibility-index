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

import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFString } from 'pdf-lib';
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

// Service token → outcome-led label + description from the Master Deck.
// Labels are framed as the OUTCOME the user gets, not the internal service name —
// per editorial feedback that titles should read like benefits, not deliverables.
const SERVICES = {
  strategy: { label: 'A personal brand that evolves with you',
              deck: 'A one-on-one deep dive to define your style, strengths, and the niche you are meant to own.' },
  content:  { label: 'Grow your digital presence and reach the right audience',
              deck: 'A strategic content plan that builds your credibility and amplifies your voice.' },
  video:    { label: 'Video',
              deck: 'Tailored video storytelling: interviews, social cuts, scroll-stopping moments.' },
  photo:    { label: 'A look that anchors your story',
              deck: 'On-brand photography and brand identity that become the visual backbone of your presence.' },
  linkedin: { label: 'LinkedIn',
              deck: 'We optimise your profile and run your channel so you stay focused on the work.' },
  speaker:  { label: 'Get ready to own the room',
              deck: 'A standout speaker kit and stage coaching for keynotes and panels.' },
  pr:       { label: 'A clear brand identity that invites engagement',
              deck: 'Press positioning, pitch development, and outlet relationships.' }
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
  // Press hits — sanitize outlet names + snippets so they don't crash pdf-lib on unicode chars from SerpAPI
  if (out.press && Array.isArray(out.press.hits)) {
    out.press = {
      ...out.press,
      outlets: (out.press.outlets || []).map(sanitizeText),
      hits:    out.press.hits.map(h => ({
        outlet:  sanitizeText(h.outlet),
        title:   sanitizeText(h.title).slice(0, 120),
        link:    sanitizeText(h.link),
        snippet: sanitizeText(h.snippet).slice(0, 240)
      }))
    };
  }
  // Content ideas + press targets (Claude-generated, optional)
  if (Array.isArray(out.contentIdeas)) {
    out.contentIdeas = out.contentIdeas.map(c => typeof c === 'string'
      ? sanitizeText(c)
      : { topic: sanitizeText(c.topic), angle: sanitizeText(c.angle), format: sanitizeText(c.format) }
    );
  }
  if (Array.isArray(out.pressTargets)) {
    out.pressTargets = out.pressTargets.map(p => typeof p === 'string'
      ? sanitizeText(p)
      : { outlet: sanitizeText(p.outlet), why: sanitizeText(p.why), pitch: sanitizeText(p.pitch) }
    );
  }
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
  // Cross-platform presence page - only if we detected ≥1 channel beyond LinkedIn
  if (r.platforms && Object.keys(r.platforms).length > 0) {
    drawPlatformsPage(ctx, r);
  }
  // Press page — only render if there's something to show (real hits OR Claude press targets)
  if ((r.press?.hits?.length > 0) || (r.pressTargets?.length > 0)) {
    drawPressPage(ctx, r);
  }
  // Content ideas page — only render if Claude returned ideas
  if (r.contentIdeas?.length > 0) {
    drawContentIdeasPage(ctx, r);
  }
  drawThreeMoves(ctx, r);
  // Outreach scripts page - renders draft emails for any move with an outreach object
  const outreachMoves = (r.moves || []).filter(m => m && m.outreach && m.outreach.body);
  if (outreachMoves.length > 0) {
    drawOutreachScriptsPage(ctx, r, outreachMoves);
  }
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
  drawText(page, 'Your profile, at a glance.', {
    x: MARGIN, y: PAGE_H - 110, size: 30, font: ctx.helvBold, color: COLOR.black
  });

  // Hexagon - smaller and higher up so the long Claude-generated executive summary
  // has room to breathe between the hex and the strength/opportunity cards.
  // Previous layout left only ~20px between summary text and cards, causing the
  // last line(s) of the summary to overlap the card chrome.
  const hexCx = PAGE_W / 2;
  const hexCy = PAGE_H - 280;
  const hexR  = 105;
  drawPersonalHexagon(ctx, page, r.subs || {}, hexCx, hexCy, hexR);

  // Executive summary (Claude-generated, 2-3 sentences). Reserved vertical band
  // between hex bottom (~PAGE_H - 405) and strength card top (220) gives ~185px
  // of safe text space - 9 lines at 18px line-height. Truncate if longer to keep
  // the page rhythm clean.
  const summary = r.executiveSummary || `${r.firstName || 'You'}, you have real signals to build on. Here's what to tighten next.`;
  const summaryY = hexCy - hexR - 50;
  drawWrappedClamped(page, summary, {
    x: MARGIN, y: summaryY, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.ink, lineHeight: 18,
    maxLines: 6
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

  // Two callout boxes side-by-side, bumped slightly down for breathing room
  const cardY = 130;
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
    size: 13, font: ctx.helvBold, color: COLOR.black, lineHeight: 17
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
    size: 13, font: ctx.helvBold, color: COLOR.black, lineHeight: 17
  });

  drawPageFooter(ctx, page, 2);
}

/* ───────────────────────────── PAGE 3 - SIX SIGNALS ───────────────────────────── */
function drawSixSignals(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'THE SIX THINGS WE LOOKED AT', PAGE_H - 60);
  drawText(page, 'Here is what we found.', {
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

  drawSectionEyebrow(ctx, page, 'WHAT TO DO NEXT', PAGE_H - 60);
  drawText(page, 'Three things to try this quarter.', {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, 'Pulled straight from what we saw.', {
    x: MARGIN, y: PAGE_H - 138, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 16
  });

  const moves = (Array.isArray(r.moves) && r.moves.length) ? r.moves.slice(0, 3) : [];
  let y = PAGE_H - 175;
  moves.forEach((m, i) => {
    // Card height calibrated so 3 × (cardH + 12 gap) plus the title block
    // (~120px) fits inside PAGE_H (842 for A4) above the footer (~60px).
    // 200 leaves a comfortable 60px+ margin to footer line.
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
    // Time-investment pill (top-right)
    if (m.timeInvest) {
      const t = m.timeInvest.toUpperCase();
      const tagW = ctx.helvBold.widthOfTextAtSize(t, 8) + 18;
      page.drawRectangle({
        x: PAGE_W - MARGIN - 22 - tagW, y: y - 30, width: tagW, height: 18,
        color: COLOR.lavender, opacity: 0.18, borderColor: COLOR.lavender, borderWidth: 0.6
      });
      drawText(page, t, {
        x: PAGE_W - MARGIN - 22 - tagW + 9, y: y - 26, size: 8, font: ctx.helvBold,
        color: COLOR.indigo, characterSpacing: 1.2
      });
    }
    // Why
    drawWrapped(page, m.why || '', {
      x: MARGIN + 50, y: y - 50, maxWidth: CONTENT_W - 80,
      size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 15
    });

    // Solo column - firstStep + week 1 + month 1 milestones (compact)
    const soloX = MARGIN + 50;
    const helpX = MARGIN + 50 + (CONTENT_W - 80) / 2 + 12;
    const colY  = y - 96;
    const colW  = (CONTENT_W - 80) / 2 - 12;
    drawText(page, 'YOU CAN DO THIS YOURSELF', {
      x: soloX, y: colY, size: 8, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.2
    });
    const stepEndY = drawWrapped(page, m.firstStep || 'Start with the smallest version this week.', {
      x: soloX, y: colY - 14, maxWidth: colW,
      size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 12
    });
    // Week 1 / Month 1 milestones - smaller, italic, compact spacing
    if (m.weekOne) {
      const w1Y = drawWrapped(page, '→ Wk 1: ' + m.weekOne, {
        x: soloX, y: stepEndY - 12, maxWidth: colW,
        size: 8.5, font: ctx.helvObl, color: COLOR.indigo, lineHeight: 11
      });
      if (m.month1) {
        drawWrapped(page, '→ Mo 1: ' + m.month1, {
          x: soloX, y: w1Y - 11, maxWidth: colW,
          size: 8.5, font: ctx.helvObl, color: COLOR.indigo, lineHeight: 11
        });
      }
    }

    // Help column (right). Service labels are outcome-led sentences.
    const svc = SERVICES[m.service] || SERVICES.strategy;
    drawText(page, 'WHERE WE WOULD HELP', {
      x: helpX, y: colY, size: 8, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.2
    });
    const titleEndY = drawWrapped(page, svc.label, {
      x: helpX, y: colY - 14, maxWidth: colW,
      size: 10.5, font: ctx.helvBold, color: COLOR.indigo, lineHeight: 13
    });
    drawWrapped(page, svc.deck, {
      x: helpX, y: titleEndY - 10, maxWidth: colW,
      size: 9.5, font: ctx.helv, color: COLOR.ink, lineHeight: 12
    });

    // Success metric line at bottom of card (full-width, italic)
    if (m.successMetric) {
      drawWrapped(page, '✓ Success looks like: ' + m.successMetric, {
        x: MARGIN + 20, y: cardY + 14, maxWidth: CONTENT_W - 40,
        size: 8.5, font: ctx.helvObl, color: COLOR.grey, lineHeight: 11
      });
    }

    y = cardY - 12;
  });

  drawPageFooter(ctx, page, 4);
}

/* ───────────────────────────── PAGE 5 - 90-DAY TIMELINE ───────────────────────────── */
function drawTimeline(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.navy });

  drawText(page, 'THE NEXT 90 DAYS', {
    x: MARGIN, y: PAGE_H - 60, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.6
  });
  drawText(page, 'Your plan.', {
    x: MARGIN, y: PAGE_H - 110, size: 32, font: ctx.helvBold, color: COLOR.cream
  });
  drawWrapped(page, "A simple 90-day plan. Some parts you can do yourself. The harder parts are where we come in.", {
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
      body:  'Block 60 minutes. Plan four posts that define your three key beliefs. We can run a half-day strategy session with you if you need an extra helping hand.'
    },
    {
      title: 'Month 2 - Production',
      sub:   'Make scroll-stopping moments. This is where we do most of the work.',
      tag:   'With FutureMakers',
      body:  moves[1]?.firstStep || 'Photography, video, banner refresh, signature post format. Hard to do alone, fast with the right team.'
    },
    {
      title: 'Month 3 - Activation',
      sub:   'Open yourself up to engagement opportunities with a consistent digital presence and messaging that is authentically you.',
      tag:   'Hybrid',
      body:  moves[2]?.firstStep || 'Pitch one keynote. Pitch one tier-1 publication. We help you pick the targets and draft the pitches.'
    }
  ];

  let y = PAGE_H - 200;
  phases.forEach((phase, i) => {
    // Phase card height bumped from 110 → 130 so the longer Month-3 sub
    // ("Open yourself up to engagement opportunities…") has room to wrap to
    // two lines without colliding with the body line beneath it.
    const cardH = 130;
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
    // Tag pill - wider horizontal padding (16px each side) so the longer "SOLO OR
    // WITH US" tag has visual breathing room inside the bordered rectangle.
    const tagText = phase.tag.toUpperCase();
    const tagPad  = 16;
    const tagW    = ctx.helvBold.widthOfTextAtSize(tagText, 8) + tagPad * 2 + 4 * (tagText.length - 1) * 0.012; // approx for char spacing
    const tagH    = 24;
    const tagX    = PAGE_W - MARGIN - 22 - tagW;
    const tagColor = phase.tag === 'Solo' ? COLOR.lavender
                    : phase.tag === 'With FutureMakers' ? COLOR.indigo
                    : rgb(0.6, 0.45, 0.85);
    page.drawRectangle({
      x: tagX, y: y - 33, width: tagW, height: tagH,
      color: tagColor, opacity: 0.25, borderColor: tagColor, borderWidth: 1
    });
    drawText(page, tagText, {
      x: tagX + tagPad, y: y - 26, size: 8, font: ctx.helvBold,
      color: COLOR.cream, characterSpacing: 1.2
    });
    // Sub - returns the y of the last line drawn, so we anchor body off it
    // instead of a fixed offset (which would clip when sub wraps to 2 lines).
    const subEndY = drawWrapped(page, phase.sub, {
      x: MARGIN + 22, y: y - 50, maxWidth: CONTENT_W - 44,
      size: 10, font: ctx.helvObl, color: COLOR.lavender, lineHeight: 14
    });
    // Body
    drawWrapped(page, phase.body, {
      x: MARGIN + 22, y: subEndY - 16, maxWidth: CONTENT_W - 44,
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

  drawSectionEyebrow(ctx, page, 'HOW WE CAN HELP', PAGE_H - 60);
  drawText(page, "What we'd do for you.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, 'Where we can help, sorted by impact.', {
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

  // Render top 4 service cards in a 2x2 grid. Cards are taller now (190 vs 160) to
  // give the outcome-led service titles room to wrap onto 2 lines without colliding
  // with the deck text or the "Closes the gap on…" footer line.
  const top = ordered.slice(0, 4);
  const colW = (CONTENT_W - 16) / 2;
  const rowH = 190;
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
    // Wrapped service title - sized down a notch (15 vs 17) so longer outcome-led
    // labels still fit two lines comfortably inside the card.
    const titleEndY = drawWrapped(page, svc.label, {
      x: x + 18, y: cy - 50, maxWidth: colW - 36,
      size: 15, font: ctx.helvBold, color: COLOR.black, lineHeight: 19
    });
    drawWrapped(page, svc.deck, {
      x: x + 18, y: titleEndY - 16, maxWidth: colW - 36,
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

/* ───────────────────────────── OPTIONAL PAGE - ACROSS THE WEB ─────────────────────────────
   Renders the cross-platform presence map: every channel where the user shows up
   beyond LinkedIn (Wikipedia, Google News, YouTube, Crunchbase, Substack, Medium,
   Instagram, X). Each platform gets a row with the top 1-2 result titles + URLs.
   Only fires when ≥1 platform was detected. */
function drawPlatformsPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'ACROSS THE WEB', PAGE_H - 60);
  drawText(page, "Where you already show up.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, "Beyond LinkedIn — every public channel we found indexed under your name.", {
    x: MARGIN, y: PAGE_H - 142, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 17
  });

  // Render order: highest-authority channels first
  const ORDER = ['wikipedia', 'googleNews', 'youtube', 'crunchbase', 'substack', 'medium', 'instagram', 'x'];
  const platforms = r.platforms || {};
  const detected = ORDER.filter(k => platforms[k]);

  let y = PAGE_H - 200;
  detected.forEach((key) => {
    const p = platforms[key];
    const cardH = 64;
    const cardY = y - cardH;

    // Row card
    page.drawRectangle({
      x: MARGIN, y: cardY, width: CONTENT_W, height: cardH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
    });
    // Platform label (left)
    drawText(page, (p.label || key).toUpperCase(), {
      x: MARGIN + 18, y: y - 24, size: 11, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.2
    });
    // First hit title or domain (left, second line)
    const firstHit = p.hits?.[0] || {};
    const titleText = (firstHit.title || p.domain || '').slice(0, 80);
    drawWrapped(page, titleText, {
      x: MARGIN + 18, y: y - 42, maxWidth: CONTENT_W - 200,
      size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 13
    });
    // "Detected" pill on the right - just confirms we found a profile/page
    // for them on this platform. We deliberately DON'T show a result count
    // because that would be the SerpAPI Google-index count, NOT the user's
    // actual content metrics (post count, follower count, etc.) - showing it
    // creates the false impression we're measuring real platform activity.
    const badgeText = 'DETECTED';
    const badgeW = ctx.helv.widthOfTextAtSize(badgeText, 9) + 18;
    page.drawRectangle({
      x: PAGE_W - MARGIN - 22 - badgeW, y: y - 32, width: badgeW, height: 18,
      color: COLOR.indigo, opacity: 0.10
    });
    drawText(page, badgeText, {
      x: PAGE_W - MARGIN - 22 - badgeW + 9, y: y - 28, size: 8.5, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.0
    });
    y = cardY - 12;
  });

  // Google name-position summary line - bottom of page
  const ranking = r.googleRanking;
  if (ranking?.topPosition) {
    const rankY = 110;
    page.drawRectangle({
      x: MARGIN, y: rankY, width: CONTENT_W, height: 56,
      color: COLOR.navy
    });
    drawText(page, 'GOOGLE RANKING FOR YOUR NAME', {
      x: MARGIN + 22, y: rankY + 36, size: 9, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.4
    });
    const rankText = ranking.topPosition <= 3
      ? `Position #${ranking.topPosition} - you own the top of search.`
      : `Position #${ranking.topPosition} - room to climb. Footprint work changes this fastest.`;
    drawText(page, rankText, {
      x: MARGIN + 22, y: rankY + 16, size: 12, font: ctx.helvBold, color: COLOR.cream
    });
  }

  drawPageFooter(ctx, page);
}

/* ───────────────────────────── OPTIONAL PAGE - WHERE YOU SHOW UP (PRESS) ─────────────────────────────
   Renders only if there are real Tier-1 press hits OR Claude-suggested press targets.
   Two-column layout: left = where they're already mentioned, right = where they could go next. */
function drawPressPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'WHERE YOU SHOW UP', PAGE_H - 60);
  drawText(page, "Your press footprint.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });

  const hits = r.press?.hits || [];
  const targets = r.pressTargets || [];

  // Summary line: count + outlets
  const count = hits.length;
  const summary = count === 0
    ? `We did not find ${r.firstName || 'you'} in any tier-1 press yet. That is the gap to close.`
    : count === 1
      ? `We found ${r.firstName || 'you'} mentioned in 1 tier-1 outlet so far.`
      : `We found ${r.firstName || 'you'} mentioned in ${count} tier-1 outlets so far.`;
  drawWrapped(page, summary, {
    x: MARGIN, y: PAGE_H - 140, maxWidth: CONTENT_W,
    size: 13, font: ctx.helv, color: COLOR.ink, lineHeight: 18
  });

  let y = PAGE_H - 200;

  // ── Real press hits (if any) ──
  if (hits.length > 0) {
    drawText(page, 'WHERE WE FOUND YOU', {
      x: MARGIN, y, size: 10, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
    });
    y -= 22;
    hits.slice(0, 4).forEach((h, i) => {
      const cardH = 84;
      page.drawRectangle({
        x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH,
        color: rgb(1, 1, 1), borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
      });
      drawText(page, '0' + (i + 1), {
        x: MARGIN + 18, y: y - 22, size: 10, font: ctx.helvBold, color: COLOR.lavender, characterSpacing: 1.2
      });
      drawText(page, h.outlet || 'Press mention', {
        x: MARGIN + 50, y: y - 22, size: 14, font: ctx.helvBold, color: COLOR.black
      });
      drawWrapped(page, h.title || '', {
        x: MARGIN + 50, y: y - 42, maxWidth: CONTENT_W - 80,
        size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 14
      });
      drawText(page, (h.link || '').slice(0, 90), {
        x: MARGIN + 50, y: y - cardH + 16, size: 8, font: ctx.helvObl, color: COLOR.indigo
      });
      y -= cardH + 12;
    });
    y -= 8;
  }

  // ── Press targets (Claude PR suggestions) ──
  if (targets.length > 0 && y > 200) {
    drawText(page, hits.length > 0 ? 'WHERE TO GO NEXT' : 'OUTLETS TO PITCH', {
      x: MARGIN, y, size: 10, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.4
    });
    y -= 22;
    targets.slice(0, 3).forEach((t, i) => {
      const isObj = typeof t === 'object' && t !== null;
      const outlet = isObj ? (t.outlet || '') : '';
      const why    = isObj ? (t.why    || '') : (typeof t === 'string' ? t : '');
      const pitch  = isObj ? (t.pitch  || '') : '';
      const cardH = pitch ? 90 : 64;
      page.drawRectangle({
        x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH,
        color: rgb(1, 1, 1), borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
      });
      if (outlet) {
        drawText(page, outlet, {
          x: MARGIN + 22, y: y - 22, size: 14, font: ctx.helvBold, color: COLOR.black
        });
        drawWrapped(page, why, {
          x: MARGIN + 22, y: y - 42, maxWidth: CONTENT_W - 44,
          size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 14
        });
        if (pitch) drawWrapped(page, 'Pitch angle: ' + pitch, {
          x: MARGIN + 22, y: y - cardH + 18, maxWidth: CONTENT_W - 44,
          size: 10, font: ctx.helvObl, color: COLOR.indigo, lineHeight: 13
        });
      } else {
        drawWrapped(page, why, {
          x: MARGIN + 22, y: y - 28, maxWidth: CONTENT_W - 44,
          size: 12, font: ctx.helv, color: COLOR.ink, lineHeight: 16
        });
      }
      y -= cardH + 10;
    });
  }

  drawPageFooter(ctx, page);
}

/* ───────────────────────────── OPTIONAL PAGE - CONTENT IDEAS ─────────────────────────────
   Specific topics + angles + formats Claude suggested for THIS person, given their role/industry. */
/* ───────────────────────────── OPTIONAL PAGE - OUTREACH SCRIPTS ─────────────────────────────
   Renders ready-to-send draft emails for any move that includes an outreach object.
   Each draft has a recipient line, subject, and body the user can copy-paste. */
function drawOutreachScriptsPage(ctx, r, outreachMoves) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'OUTREACH SCRIPTS', PAGE_H - 60);
  drawText(page, "Copy. Paste. Send.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, "Draft emails for the moves that need outbound contact. Personalised to your specific angle. Edit one line, hit send.", {
    x: MARGIN, y: PAGE_H - 142, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 17
  });

  let y = PAGE_H - 200;
  outreachMoves.slice(0, 3).forEach((m) => {
    const o = m.outreach;
    const cardH = 200;
    const cardY = y - cardH;
    page.drawRectangle({
      x: MARGIN, y: cardY, width: CONTENT_W, height: cardH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
    });

    // Type pill (top-left): PRESS / PODCAST / SPEAKER / etc.
    const typeText = (o.type || 'press').toUpperCase();
    drawText(page, typeText, {
      x: MARGIN + 20, y: y - 24, size: 9, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.6
    });
    // Move title (the "what this is for")
    drawText(page, m.title || '', {
      x: MARGIN + 20, y: y - 44, size: 14, font: ctx.helvBold, color: COLOR.black
    });
    // Recipient line
    if (o.recipient) {
      drawText(page, 'TO:', {
        x: MARGIN + 20, y: y - 66, size: 8, font: ctx.helvBold, color: COLOR.grey, characterSpacing: 1.2
      });
      drawWrapped(page, o.recipient, {
        x: MARGIN + 50, y: y - 66, maxWidth: CONTENT_W - 80,
        size: 10, font: ctx.helv, color: COLOR.ink, lineHeight: 13
      });
    }
    // Subject line
    if (o.subject) {
      drawText(page, 'SUBJ:', {
        x: MARGIN + 20, y: y - 84, size: 8, font: ctx.helvBold, color: COLOR.grey, characterSpacing: 1.2
      });
      drawWrapped(page, o.subject, {
        x: MARGIN + 50, y: y - 84, maxWidth: CONTENT_W - 80,
        size: 10, font: ctx.helvBold, color: COLOR.indigo, lineHeight: 13
      });
    }
    // Body - quoted block with subtle indigo left border
    const bodyY = y - 104;
    page.drawRectangle({
      x: MARGIN + 20, y: cardY + 14, width: 2, height: bodyY - cardY - 18,
      color: COLOR.indigo, opacity: 0.4
    });
    drawWrapped(page, o.body || '', {
      x: MARGIN + 32, y: bodyY, maxWidth: CONTENT_W - 60,
      size: 10.5, font: ctx.helv, color: COLOR.ink, lineHeight: 14
    });

    y = cardY - 14;
  });

  drawPageFooter(ctx, page);
}

function drawContentIdeasPage(ctx, r) {
  const page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLOR.cream });

  drawSectionEyebrow(ctx, page, 'WHAT TO POST', PAGE_H - 60);
  drawText(page, "Ideas that would land for you.", {
    x: MARGIN, y: PAGE_H - 110, size: 28, font: ctx.helvBold, color: COLOR.black
  });
  drawWrapped(page, `${r.firstName || 'You'}, here are topics and formats that match your audience and would actually get traction.`, {
    x: MARGIN, y: PAGE_H - 138, maxWidth: CONTENT_W,
    size: 12, font: ctx.helv, color: COLOR.grey, lineHeight: 16
  });

  const ideas = r.contentIdeas || [];
  let y = PAGE_H - 180;
  ideas.slice(0, 5).forEach((idea, i) => {
    const isObj = typeof idea === 'object' && idea !== null;
    const topic = isObj ? (idea.topic || idea.angle || '') : (typeof idea === 'string' ? idea : '');
    const angle = isObj ? (idea.angle || '') : '';
    const format = isObj ? (idea.format || '') : '';
    const cardH = format ? 110 : 90;
    page.drawRectangle({
      x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH,
      color: rgb(1, 1, 1), borderColor: rgb(0.85, 0.85, 0.92), borderWidth: 1
    });
    drawText(page, '0' + (i + 1), {
      x: MARGIN + 18, y: y - 24, size: 12, font: ctx.helvBold, color: COLOR.indigo, characterSpacing: 1.2
    });
    drawWrapped(page, topic, {
      x: MARGIN + 50, y: y - 24, maxWidth: CONTENT_W - 80,
      size: 14, font: ctx.helvBold, color: COLOR.black, lineHeight: 18
    });
    if (angle && angle !== topic) {
      drawWrapped(page, angle, {
        x: MARGIN + 50, y: y - 56, maxWidth: CONTENT_W - 80,
        size: 11, font: ctx.helv, color: COLOR.ink, lineHeight: 15
      });
    }
    if (format) {
      drawText(page, 'Format: ' + format, {
        x: MARGIN + 50, y: y - cardH + 18, size: 10, font: ctx.helvObl, color: COLOR.indigo
      });
    }
    y -= cardH + 12;
  });

  drawPageFooter(ctx, page);
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

  drawWrapped(page, "15 minutes, no pitch. We'll break down what we observed, take your questions and identify the quick wins.", {
    x: MARGIN, y: PAGE_H - 420, maxWidth: CONTENT_W - 80,
    size: 14, font: ctx.helv, color: rgb(0.88, 0.88, 0.95), lineHeight: 21
  });

  // Calendly CTA - rendered as a clickable button via a PDF link annotation overlaid
  // on the cream rectangle. The annotation hit-area exactly matches the button's bounds.
  // UTM params let us split-track PDF-driven bookings from on-site/email bookings.
  const btnY = 320;
  const btnW = 360;
  const btnH = 60;
  const calendlyUrl = 'https://calendly.com/yentl-spiteri/15-min-intro?utm_source=pdf-report&utm_medium=lead-magnet&utm_campaign=visibility-index';
  page.drawRectangle({
    x: MARGIN, y: btnY, width: btnW, height: btnH,
    color: COLOR.cream
  });
  drawText(page, 'BOOK A 15-MIN CALL', {
    x: MARGIN + 30, y: btnY + 32, size: 12, font: ctx.helvBold,
    color: COLOR.navy, characterSpacing: 1.6
  });
  drawText(page, 'calendly.com/yentl-spiteri/15-min-intro', {
    x: MARGIN + 30, y: btnY + 14, size: 10, font: ctx.helv, color: COLOR.indigo
  });
  // PDF link annotation - the entire button surface is clickable
  addLinkAnnotation(ctx, page, calendlyUrl, {
    x: MARGIN, y: btnY, width: btnW, height: btnH
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

// Add a clickable hyperlink annotation over an existing rectangle on the page.
// Used for the calendly button on page 7. Coordinates are in PDF space (origin bottom-left).
//
// Bug history: the previous version pushed the annotation as a DIRECT object
// inline inside the Annots array. Some readers (Preview, Chrome's PDF viewer,
// Safari) silently dropped direct-object annotations on render, leaving the
// link visually present but un-clickable. Per PDF spec, annotations should be
// indirect references - so we now `register()` the annotation dict and push
// the resulting PDFRef instead.
function addLinkAnnotation(ctx, page, url, rect) {
  const ll = page.doc.context;
  const annotDict = ll.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    F: 4, // Print flag - keeps the link active in printed/exported copies
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(url)
    }
  });
  // Register as an indirect object → returns a PDFRef the Annots array can carry.
  const annotRef = ll.register(annotDict);
  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!annots) {
    annots = ll.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(annotRef);
}

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

// Draw the personal hexagon - the user's actual scores as a filled radar shape inside
// a faint hexagon scaffold. Previous version used 6 per-wedge triangles via drawSvgPath
// with `borderWidth: 0`; pdf-lib in some versions skips the fill operator in that case,
// which left the shape blank. This version draws ONE closed filled path for the user's
// scores plus a stronger stroke around it - more reliable, more legible, and faster.
function drawPersonalHexagon(ctx, page, subs, cx, cy, R) {
  // Hex vertices - top, upper-right, lower-right, bottom, lower-left, upper-left
  const angle = (i) => -Math.PI / 2 + i * (Math.PI / 3);
  const VERTS = [];
  for (let i = 0; i < 6; i++) {
    VERTS.push({
      x: cx + R * Math.cos(angle(i)),
      y: cy + R * Math.sin(angle(i))
    });
  }
  // Outer hex outline (faint)
  drawStrokedPolygon(page, VERTS, COLOR.lavender, 1, 0.35);
  // Concentric rings at 1/3 and 2/3 to give the shape scale reference
  for (const t of [0.333, 0.667]) {
    const ring = VERTS.map(v => ({
      x: cx + (v.x - cx) * t,
      y: cy + (v.y - cy) * t
    }));
    drawStrokedPolygon(page, ring, COLOR.lavender, 0.6, 0.22);
  }
  // Spokes from center to each vertex
  VERTS.forEach(v => {
    page.drawLine({
      start: { x: cx, y: cy }, end: { x: v.x, y: v.y },
      thickness: 0.5, color: COLOR.lavender, opacity: 0.25
    });
  });

  // User's points along each spoke based on score (0-3). Min visible distance
  // from center prevents zero-score dimensions from collapsing the shape entirely
  // (which would make the radar look broken when someone scores all-zero somewhere).
  const dimKeys = ['footprint','clarity','authority','cadence','visual','network'];
  const userPts = dimKeys.map((k, i) => {
    const score = subs[k] ?? 0;
    // Map 0..3 to 0.06..1.0 so even zero-score spikes register as a dot near the centre
    const t = 0.06 + (score / 3) * 0.94;
    return {
      x: cx + (VERTS[i].x - cx) * t,
      y: cy + (VERTS[i].y - cy) * t,
      score
    };
  });

  // Filled user shape - single closed path, indigo @ 65% opacity. Setting borderColor
  // explicitly + tiny borderWidth ensures pdf-lib emits the `B` (fill+stroke) operator
  // rather than just `S` (stroke), which reliably renders the fill.
  drawFilledPolygon(page, userPts, COLOR.indigo, 0.65);
  // Stronger outline on top so the shape pops against the indigo fill
  drawStrokedPolygon(page, userPts, COLOR.indigo, 1.5, 1);

  // Vertex labels + nodes (rendered AFTER fills so they sit on top)
  const dimLabels = ['Footprint','Clarity','Authority','Cadence','Visual','Network'];
  VERTS.forEach((v, i) => {
    page.drawCircle({ x: v.x, y: v.y, size: 3, color: COLOR.indigo });
    const labelOffset = 20;
    const dx = (v.x - cx) / R * labelOffset;
    const dy = (v.y - cy) / R * labelOffset;
    const lx = v.x + dx;
    const ly = v.y + dy;
    const score = subs[dimKeys[i]] ?? 0;
    const labelText = `${dimLabels[i]} ${score}/3`;
    const w = ctx.helvBold.widthOfTextAtSize(labelText, 9);
    let textX = lx;
    if (i === 0 || i === 3) textX = lx - w / 2;
    else if (i === 1 || i === 2) textX = lx;
    else textX = lx - w;
    drawText(page, labelText, {
      x: textX, y: ly - 3, size: 9, font: ctx.helvBold, color: COLOR.black
    });
  });

  // User-score nodes ON TOP of the vertex labels - tiny dots showing exactly where
  // the user lands on each spoke
  userPts.forEach(p => {
    page.drawCircle({ x: p.x, y: p.y, size: 2.5, color: COLOR.indigo });
  });
}

// Filled closed polygon. Builds a single SVG path (M ... L ... Z) and lets pdf-lib's
// drawSvgPath handle the y-flip. Setting borderColor + borderWidth (even if tiny)
// guarantees the fill operator is emitted - some pdf-lib builds drop fills when
// borderWidth is exactly 0.
function drawFilledPolygon(page, points, fillColor, fillOpacity = 1) {
  if (!points || points.length < 3) return;
  // SVG path with y-flipped to match pdf-lib's drawSvgPath convention
  let path = `M ${points[0].x.toFixed(2)},${(PAGE_H - points[0].y).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    path += ` L ${points[i].x.toFixed(2)},${(PAGE_H - points[i].y).toFixed(2)}`;
  }
  path += ' Z';
  page.drawSvgPath(path, {
    color: fillColor,
    opacity: fillOpacity,
    borderColor: fillColor,
    borderWidth: 0.5,
    borderOpacity: fillOpacity
  });
}

// Stroked-only polygon - drawn with successive drawLine calls so we can control opacity
// per stroke. Used for the faint hex scaffold lines.
function drawStrokedPolygon(page, points, strokeColor, strokeWidth = 1, strokeOpacity = 1) {
  if (!points || points.length < 2) return;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    page.drawLine({
      start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
      thickness: strokeWidth,
      color: strokeColor,
      opacity: strokeOpacity
    });
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

// Word-wrap with a hard line cap. If the text would render past `maxLines`,
// the final visible line is truncated with an ellipsis. Used to keep
// AI-generated paragraphs from blowing past the page region they're given.
function drawWrappedClamped(page, text, opts) {
  const { x, y, maxWidth, size, font, color, lineHeight, maxLines } = opts;
  const safe = sanitizeText(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!safe) return y;
  const words = safe.split(' ');
  // First pass - break into lines without drawing
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    const w = font.widthOfTextAtSize(test, size);
    if (w > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const cap = Math.max(1, maxLines || lines.length);
  const visible = lines.slice(0, cap);
  // If we truncated, append ellipsis to the last visible line (trimming words
  // until "…" fits within maxWidth).
  if (lines.length > cap && visible.length) {
    let last = visible[visible.length - 1];
    const ELLIPSIS = '…';
    while (last && font.widthOfTextAtSize(last + ELLIPSIS, size) > maxWidth) {
      const parts = last.split(' ');
      parts.pop();
      last = parts.join(' ');
    }
    visible[visible.length - 1] = (last || '').trimEnd() + ELLIPSIS;
  }
  let curY = y;
  for (const ln of visible) {
    page.drawText(ln, { x, y: curY, size, font, color });
    curY -= lineHeight;
  }
  return curY;
}
