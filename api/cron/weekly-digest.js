/**
 * GET /api/cron/weekly-digest
 *
 * Vercel cron (Monday 09:30 UTC, 30 min after weekly-rescore). For every
 * manager with at least one tracked member that got a fresh snapshot this
 * week, send a digest email: team avg, biggest mover, biggest regression,
 * weakest dimension.
 */

import { ensureSchema, sql, weekOf } from '../../lib/db.js';

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
  await ensureSchema();
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY missing' });

  const thisWeek = weekOf();
  const lastWeek = prevWeekOf();

  // Managers with at least one tracked member scored this week.
  const { rows: managers } = await sql`
    SELECT DISTINCT m.id, m.email
    FROM manager m
    JOIN team_member tm ON tm.manager_id = m.id AND tm.tracking_enabled = TRUE
    JOIN score_snapshot ss ON ss.team_member_id = tm.id AND ss.week_of = ${thisWeek}`;

  const from = process.env.RESEND_FROM_TRANSACTIONAL || 'Von Peach <hello@vonpeach.com>';
  let sent = 0;
  for (const mgr of managers) {
    const { rows: members } = await sql`
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
    let mover = null;
    let regression = null;
    for (const m of scored) {
      if (m.last_total == null) continue;
      const delta = m.this_total - m.last_total;
      if (delta > 0 && (!mover || delta > mover.delta)) mover = { name: m.display_name || m.linkedin_url, delta };
      if (delta < 0 && (!regression || delta < regression.delta)) regression = { name: m.display_name || m.linkedin_url, delta };
    }
    // Weakest dimension across team.
    const subKeys = Object.keys(scored[0].this_subs || {});
    const subAvg = {};
    for (const k of subKeys) {
      const vals = scored.map(m => Number(m.this_subs?.[k]) || 0);
      subAvg[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const weakest = subKeys.length ? subKeys.reduce((a, b) => subAvg[a] < subAvg[b] ? a : b) : null;

    const host = `https://${req.headers.host}`;
    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0c0b09;max-width:560px;margin:0 auto;padding:32px 24px;line-height:1.6">
      <h2 style="color:#3F36B2;margin:0 0 12px">Your team this week</h2>
      <p style="color:#56556B;margin:0 0 24px">Week of ${thisWeek} · ${scored.length} tracked</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
        <tr><td style="padding:10px 14px;background:#fafafa;border-radius:8px"><strong>Team average</strong></td><td style="padding:10px 14px;text-align:right;background:#fafafa;border-radius:8px"><strong>${avg} / 18</strong></td></tr>
      </table>
      <p style="margin:6px 0"><strong>Biggest mover:</strong> ${mover ? `${mover.name} (+${mover.delta})` : '—'}</p>
      <p style="margin:6px 0"><strong>Biggest regression:</strong> ${regression ? `${regression.name} (${regression.delta})` : '—'}</p>
      <p style="margin:6px 0"><strong>Weakest dimension:</strong> ${weakest || '—'}</p>
      <p style="margin:28px 0 0"><a href="${host}/team-dashboard" style="background:#3F36B2;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Open team dashboard</a></p>
    </body></html>`;

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
