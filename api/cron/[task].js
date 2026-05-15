/**
 * /api/cron/[task] — single dispatcher for all cron + internal tasks.
 * Consolidated to stay under the Hobby-tier serverless-function cap.
 *
 * Tasks:
 *   weekly-rescore  (GET)  — fans out one /api/cron/rescore-one per tracked member
 *   rescore-one     (POST) — scores one member, writes a snapshot
 *   weekly-digest   (GET)  — emails the manager digest
 *
 * Vercel cron always sends `Authorization: Bearer ${CRON_SECRET}`. Manual
 * triggers can use `?secret=...` instead.
 */

import { ensureSchema, sql, newId, weekOf } from '../../lib/db.js';
import { renderBrandedEmail, escapeHtml } from '../../lib/email-template.js';

const RESEND_API = 'https://api.resend.com/emails';

function authed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const query  = String(req.query?.secret || '');
  return header === expected || query === expected;
}

function prevWeekOf() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return weekOf(d);
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const task = String(req.query?.task || '');
  if (task === 'weekly-rescore') return weeklyRescore(req, res);
  if (task === 'rescore-one')    return rescoreOne(req, res);
  if (task === 'weekly-digest')  return weeklyDigest(req, res);
  return res.status(404).json({ error: `Unknown cron task: ${task}` });
}

/* ─────────── weekly-rescore: fan out ─────────── */
async function weeklyRescore(req, res) {
  await ensureSchema();
  const week = weekOf();
  const due = await sql`
    SELECT tm.id
    FROM team_member tm
    LEFT JOIN score_snapshot ss
      ON ss.team_member_id = tm.id AND ss.week_of = ${week}
    WHERE tm.tracking_enabled = TRUE
      AND tm.consent_state IN ('granted','none')
      AND ss.id IS NULL`;

  const host = `https://${req.headers.host}`;
  const secret = process.env.CRON_SECRET || '';
  for (const row of due) {
    fetch(`${host}/api/cron/rescore-one`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
      body: JSON.stringify({ memberId: row.id })
    }).catch(() => {});
  }
  return res.status(200).json({ ok: true, queued: due.length, week });
}

/* ─────────── rescore-one: score + persist a single member ─────────── */
async function rescoreOne(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();
  const memberId = String(req.body?.memberId || '');
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const rows = await sql`SELECT id, linkedin_url FROM team_member WHERE id = ${memberId}`;
  if (!rows.length) return res.status(404).json({ error: 'Member not found' });

  const host = `https://${req.headers.host}`;
  try {
    const r = await fetch(`${host}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://' + rows[0].linkedin_url })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error || 'score failed' });

    const week = weekOf();
    await sql`
      INSERT INTO score_snapshot (id, team_member_id, week_of, total, sub_scores, tier)
      VALUES (${newId()}, ${memberId}, ${week}, ${j.total}, ${JSON.stringify(j.subs)}::jsonb, ${j.tier?.name || ''})
      ON CONFLICT (team_member_id, week_of) DO UPDATE
        SET total = EXCLUDED.total, sub_scores = EXCLUDED.sub_scores, tier = EXCLUDED.tier, captured_at = NOW()`;
    return res.status(200).json({ ok: true, week_of: week, total: j.total });
  } catch (err) {
    console.error('[rescore-one]', err);
    return res.status(500).json({ error: err?.message });
  }
}

/* ─────────── weekly-digest: email each manager ─────────── */
async function weeklyDigest(req, res) {
  await ensureSchema();
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY missing' });

  const thisWeek = weekOf();
  const lastWeek = prevWeekOf();
  const managers = await sql`
    SELECT DISTINCT m.id, m.email
    FROM manager m
    JOIN team_member tm ON tm.manager_id = m.id AND tm.tracking_enabled = TRUE
    JOIN score_snapshot ss ON ss.team_member_id = tm.id AND ss.week_of = ${thisWeek}`;

  const from = process.env.RESEND_FROM_TRANSACTIONAL || 'Von Peach <hello@vonpeach.com>';
  let sent = 0;
  for (const mgr of managers) {
    const members = await sql`
      SELECT tm.id, tm.linkedin_url, tm.display_name,
             this_w.total AS this_total, this_w.sub_scores AS this_subs, this_w.tier AS this_tier,
             last_w.total AS last_total
      FROM team_member tm
      LEFT JOIN score_snapshot this_w ON this_w.team_member_id = tm.id AND this_w.week_of = ${thisWeek}
      LEFT JOIN score_snapshot last_w ON last_w.team_member_id = tm.id AND last_w.week_of = ${lastWeek}
      WHERE tm.manager_id = ${mgr.id} AND tm.tracking_enabled = TRUE`;

    const scored = members.filter(m => m.this_total != null);
    if (!scored.length) continue;
    const avg = (scored.reduce((s, m) => s + m.this_total, 0) / scored.length).toFixed(1);

    let mover = null, regression = null;
    for (const m of scored) {
      if (m.last_total == null) continue;
      const delta = m.this_total - m.last_total;
      if (delta > 0 && (!mover || delta > mover.delta)) mover = { name: m.display_name || m.linkedin_url, delta };
      if (delta < 0 && (!regression || delta < regression.delta)) regression = { name: m.display_name || m.linkedin_url, delta };
    }
    const subKeys = Object.keys(scored[0].this_subs || {});
    const subAvg = {};
    for (const k of subKeys) {
      const vals = scored.map(m => Number(m.this_subs?.[k]) || 0);
      subAvg[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const weakest = subKeys.length ? subKeys.reduce((a, b) => subAvg[a] < subAvg[b] ? a : b) : null;

    const host = `https://${req.headers.host}`;
    const moverHtml      = mover      ? `${escapeHtml(mover.name)} <span style="color:#16a34a;font-weight:700">(+${mover.delta})</span>`              : '—';
    const regressionHtml = regression ? `${escapeHtml(regression.name)} <span style="color:#b91c1c;font-weight:700">(${regression.delta})</span>`     : '—';
    const html = renderBrandedEmail({
      title: `Team visibility — week of ${thisWeek}`,
      heroEyebrow: `Week of ${thisWeek}`,
      heroHeadline: `Your team this&nbsp;week.`,
      bodyHtml: `
        <p style="font-size:15px;color:#56556B;margin:0 0 24px;text-align:center;">
          ${scored.length} member${scored.length === 1 ? '' : 's'} tracked
        </p>
        <table style="width:100%;border-collapse:separate;border-spacing:0 8px;margin:0 0 18px;">
          <tr>
            <td style="padding:14px 16px;background:#f1efff;border-radius:8px;font-size:15px;color:#0c0b09;"><strong>Team average</strong></td>
            <td style="padding:14px 16px;background:#f1efff;border-radius:8px;font-size:18px;color:#3F36B2;text-align:right;font-weight:700;">${avg} <span style="font-size:12px;color:#56556B;font-weight:400">/ 18</span></td>
          </tr>
          <tr>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:8px 0 0 8px;border-right:0;font-size:14px;color:#56556B;">Biggest mover</td>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:0 8px 8px 0;border-left:0;font-size:14px;color:#0c0b09;text-align:right;">${moverHtml}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:8px 0 0 8px;border-right:0;font-size:14px;color:#56556B;">Biggest regression</td>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:0 8px 8px 0;border-left:0;font-size:14px;color:#0c0b09;text-align:right;">${regressionHtml}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:8px 0 0 8px;border-right:0;font-size:14px;color:#56556B;">Weakest dimension</td>
            <td style="padding:12px 16px;background:#fff;border:1px solid rgba(12,11,9,0.06);border-radius:0 8px 8px 0;border-left:0;font-size:14px;color:#0c0b09;text-align:right;text-transform:capitalize;">${escapeHtml(weakest || '—')}</td>
          </tr>
        </table>`,
      cta: { label: 'Open dashboard', href: `${host}/team-dashboard` },
      bodyFootnote: 'Re-runs every Monday morning. Pause any time from the dashboard.'
    });

    try {
      const r = await fetch(RESEND_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [mgr.email], subject: `Team visibility — week of ${thisWeek}`, html })
      });
      if (r.ok) sent++;
    } catch (err) {
      console.error('[weekly-digest] send', mgr.email, err?.message);
    }
  }
  return res.status(200).json({ ok: true, managers: managers.length, sent });
}
