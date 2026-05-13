# The Visibility Index

A lead-magnet calculator for **Von Peach FutureMakers** — the personal-branding service line targeting C-suite executives. Inspired by the FIN tax-savings calculator (~20 leads/week conversion benchmark).

The user pastes their LinkedIn URL. We run a forensic audit using public signals only (LinkedIn data via ProxyCurl, Google footprint via SerpAPI, brand-clarity scoring via Claude Haiku), score the profile across six dimensions (0–3 each, total 0–18), and place them in one of four tiers. Email gate captures the lead into Mailchimp with full UTM attribution.

## Architecture

```
Frontend  (index.html, static)
   │
   ▼  POST /api/score { url }
api/score.js
   ├─ ProxyCurl        → LinkedIn profile JSON
   ├─ SerpAPI          → Google footprint
   └─ Claude Haiku     → brand clarity 0-3
   ▼ returns { total, subs, tier }

   ▼  POST /api/lead   { email, goal, score, attribution }
api/lead.js
   └─ Mailchimp        → upsert with merge fields + tags
```

Hosted on **Vercel**: static frontend + serverless functions on the same domain. No CORS hops, single env-var dashboard, single deploy pipeline.

## Versions

- **v0.0–v0.2 (shipped)** — Single-URL UX, six-dimension scoring, four tiers, ad-optimised hero, sample-peer pills, UTM capture. All client-side mock scoring on GitHub Pages.
- **v1 (this repo, current)** — Real backend on Vercel. ProxyCurl + SerpAPI + Claude Haiku → live scoring. Mailchimp wiring → live lead capture with attribution.
- **v2 (planned, post-launch)** — Once 200+ leads accumulated, swap synthetic peer baselines for a real cohort DB built from opted-in profiles. Relaunch moment.
- **Team audit (current)** — Manager-facing flow at `/team-audit`. Magic-link sign-in, paste up to 10 LinkedIn URLs, get a team scorecard, optional weekly tracking with quarterly trends and a Monday-morning digest email.

## Team audit setup

The team-audit feature needs Postgres + a session secret + a cron secret on top of the existing env vars.

1. **Provision Postgres**: Vercel dashboard → Storage → Create Database → Postgres. Link it to the project. Vercel auto-injects `POSTGRES_URL` etc.
2. **Generate secrets**:
   ```bash
   openssl rand -hex 32   # → SESSION_SECRET
   openssl rand -hex 24   # → CRON_SECRET
   ```
   Add both under Project Settings → Environment Variables.
3. **Cron is configured in `vercel.json`** — `weekly-rescore` runs Monday 09:00 UTC, `weekly-digest` runs Monday 09:30 UTC. Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically.
4. **Schema bootstrap is automatic** — `lib/db.js` creates the tables on first request.
5. **Transactional email** reuses `RESEND_API_KEY` (already wired for ops alerts). Override the from-line with `RESEND_FROM_TRANSACTIONAL` if you want sign-in / digest / opt-in emails to come from a different verified address than ops alerts.

Routes:
- `/team-audit` — public lander, manager enters email, gets sign-in link.
- `/team-dashboard` — authed dashboard (paste URLs, see scores, toggle tracking, send opt-in).
- `/team-consent` — landing page team members hit after clicking the opt-in email.

## Local development

```bash
npm i -g vercel
vercel login
vercel link            # link to your Vercel project
cp .env.example .env.local
# edit .env.local — paste your real keys
vercel dev             # runs frontend + functions locally
```

## Production deployment (Vercel)

1. Sign in to [vercel.com](https://vercel.com) and click **Add New → Project**.
2. Import the GitHub repo (`visibility-index`).
3. Build settings: leave everything default — Vercel detects static + serverless functions automatically.
4. **Environment Variables** — add the following at Project Settings → Environment Variables. **Set them for Production, Preview AND Development**.

   | Variable | Value source |
   |---|---|
   | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
   | `PROXYCURL_API_KEY` | nubela.co/proxycurl → Dashboard → API Key |
   | `SERPAPI_API_KEY` | serpapi.com/dashboard → API Key |
   | `MAILCHIMP_API_KEY` | Mailchimp → Account → Extras → API keys |
   | `MAILCHIMP_AUDIENCE_ID` | Audience → Settings → Audience name and defaults → "Audience ID" |
   | `MAILCHIMP_SERVER_PREFIX` | The `usX` in your Mailchimp dashboard URL (e.g. `us17`) |

5. Deploy. The first deploy takes ~30 seconds.
6. Custom domain — Project Settings → Domains → add `visibility.vonpeach.com` and follow the DNS instructions.

## Mailchimp setup (one-time)

The `/api/lead` function writes merge fields to your Mailchimp audience. Add these custom fields **before** going live, or the merge values will be silently dropped.

1. Mailchimp → Audience → **Settings** → **Audience fields and *|MERGE|* tags**
2. Add the following:

   | Field name | Tag | Type |
   |---|---|---|
   | Visibility Score | `VIS_SCORE` | Number |
   | Visibility Tier | `VIS_TIER` | Text |
   | Visibility Goal | `VIS_GOAL` | Text |
   | Visibility LinkedIn | `VIS_LINKEDIN` | Text |
   | UTM Source | `UTM_SOURCE` | Text |
   | UTM Campaign | `UTM_CAMP` | Text |
   | UTM Medium | `UTM_MED` | Text |

Tags are added automatically per submission: `tier:<slug>`, `goal:<value>`, `campaign:<utm_campaign>`. You can build segments and automations off these.

## Scoring rubric

Total = sum of six dimensions, each 0–3. Range: 0–18.

| Dimension | Source |
|---|---|
| Digital Footprint | LinkedIn presence (photo, banner, About length) + SerpAPI organic results count + press domains |
| Brand Clarity | Claude Haiku scores LinkedIn headline + About against a 4-point rubric |
| Authority Signals | Recommendations, articles, honors, press keywords in headline/About |
| Content Cadence | Activities array length from ProxyCurl (recent posts) |
| Visual Identity | Profile photo + banner + About length + brand-clarity correlation |
| Network Recognition | Followers, connections, recommendations |

## Tiers

| Score | Tier | Tagline |
|---|---|---|
| 0–5 | The Hidden Gem | Real expertise. The world just doesn't know it yet. |
| 6–10 | The Rising Voice | Building momentum, but gaps are holding you back. |
| 11–15 | The Emerging Authority | Solid foundations. Time to scale your reach. |
| 16–18 | The Recognised Leader | Strong brand. Let's make it legacy-level. |

## Brand

Built on the **FutureMakers** palette (Von Peach personal-branding service):

| Token | Hex |
|---|---|
| Deep navy | `#0B0359` |
| Indigo | `#3F36B2` |
| Lavender | `#8683E5` |
| Ice | `#EBF0FF` |

Typography: **Aileron** (display, system fallback in v0–v1) + **General Sans** (body, Fontshare CDN). Aileron should be self-hosted from the brand assets in v1.1.

## Cost per audit

| Service | Approx. per audit |
|---|---|
| ProxyCurl | $0.01 |
| SerpAPI | $0.01 |
| Claude Haiku | $0.001 |
| Mailchimp | flat (per-list pricing) |
| **Total** | **~$0.025 per audit** |

Rate limit defaults to 5 audits per IP per hour to bound spend on bots. Override via `RATE_LIMIT_PER_HOUR` env var.

## License

Proprietary — Von Peach GmbH, 2026.
