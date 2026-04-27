# The Visibility Index

A lead-magnet calculator for **Von Peach FutureMakers** — the personal-branding
service line targeting C-suite executives. Inspired by the FIN tax-savings
calculator (~20 leads/week conversion benchmark).

## What this is

A self-contained, single-file HTML prototype (v0) of an executive
"Visibility Index" assessment. Eight inputs in, one composite score out
(0–100), plus a peer-cohort ranking, sub-score breakdown, and an email gate
that unlocks the full leaderboard.

The downstream lead funnel pushes qualified executives toward the
**FutureMakers Circle** — a 12-seat quarterly cohort, application only.

## Versions

- **v0 (this file)** — Design prototype with mocked LinkedIn data.
  Brand-correct, copy-complete, scoring formula working. No backend.
- **v1 (next)** — ProxyCurl integration for live LinkedIn lookups,
  Mailchimp wired for email capture, Netlify Functions backend,
  synthetic peer baselines from published research.
- **v2 (post-launch)** — Real peer database built from accumulated leads,
  swap synthetic baselines for live cohort ranking. Relaunch moment.

## Deployment (GitHub Pages)

This repo deploys as a static site. After pushing to GitHub:

1. Repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` · folder: `/ (root)`
4. Save. URL appears in 30–60 seconds at
   `https://<username>.github.io/visibility-index/`

For a custom domain (e.g. `visibility.vonpeach.com`), add a `CNAME` file
with the domain and create a CNAME DNS record pointing to
`<username>.github.io`.

## Brand

Built on the **FutureMakers** palette (Von Peach personal-branding service):

| Token        | Hex       |
|--------------|-----------|
| Deep navy    | `#0B0359` |
| Indigo       | `#3F36B2` |
| Lavender     | `#8683E5` |
| Ice          | `#EBF0FF` |

Typography: Aileron (display, system fallback in v0) + General Sans (body,
Fontshare CDN). Aileron should be self-hosted from the brand zip in v1.

## Scoring rubric

Total = 100 points, normalised to a 0–100 score.

| Component        | Weight | Inputs                                       |
|------------------|--------|----------------------------------------------|
| Profile strength | 15     | LinkedIn URL provided, role clarity          |
| Reach            | 25     | Follower band                                |
| Cadence          | 15     | Posting frequency last 90 days               |
| Authority        | 30     | Press mentions + speaking engagements (12mo) |
| External roles   | 15     | Board seats / advisory roles                 |

## License

Proprietary — Von Peach GmbH, 2026.
