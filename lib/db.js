/**
 * lib/db.js — Postgres client + schema bootstrap for the team-audit feature.
 *
 * Uses the `postgres` package (Porsager) — talks to any PostgreSQL including
 * Supabase, Neon, RDS, etc. Reads POSTGRES_URL from env.
 *
 * `prepare: false` is required because the Supabase / Vercel integration
 * routes POSTGRES_URL through pgbouncer in transaction-pooling mode, which
 * doesn't support prepared statements. Add &sslmode=require to the URL
 * if your provider doesn't already include it (Supabase + Neon do).
 *
 * ensureSchema() is idempotent; safe to call on every cold start.
 *
 * Tables:
 *   manager           — authenticated team-leader accounts
 *   magic_link        — short-lived email auth tokens
 *   team_member       — LinkedIn URLs a manager has added (max 10/manager)
 *   score_snapshot    — monthly score history per team_member (column is still
 *                       named `week_of` for back-compat — it's a date bucket
 *                       holding the first-of-month for the current period)
 *   consent_token     — opt-in/out tokens emailed to team members
 */

import postgres from 'postgres';

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('POSTGRES_URL (or DATABASE_URL) must be set');
  _sql = postgres(url, {
    prepare: false,           // pgbouncer transaction mode compatibility
    ssl: 'require',           // Supabase / Neon / most managed PG require TLS
    idle_timeout: 20,         // close idle conns quickly in serverless
    max: 1                    // one conn per warm container; pgbouncer pools the rest
  });
  return _sql;
}

// Note on result shape (Porsager `postgres` package, NOT @vercel/postgres):
//   await sql`SELECT ...`  → Array<Row>          (use directly, no .rows)
//   await sql`UPDATE ...`  → { count, ...rows }  (use result.count, not .rowCount)
export const sql = (strings, ...values) => getSql()(strings, ...values);

let _schemaReady = null;

export async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS manager (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    // Invite token for the manager's "share this link with your team" flow.
    // ALTER + IF NOT EXISTS so we can roll forward without dropping the table.
    await sql`ALTER TABLE manager ADD COLUMN IF NOT EXISTS invite_token TEXT UNIQUE`;
    await sql`ALTER TABLE manager ADD COLUMN IF NOT EXISTS invite_created_at TIMESTAMPTZ`;
    await sql`CREATE TABLE IF NOT EXISTS magic_link (
      token         TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      used_at       TIMESTAMPTZ
    )`;
    await sql`CREATE TABLE IF NOT EXISTS team_member (
      id                TEXT PRIMARY KEY,
      manager_id        TEXT NOT NULL REFERENCES manager(id) ON DELETE CASCADE,
      linkedin_url      TEXT NOT NULL,
      display_name      TEXT,
      member_email      TEXT,
      tracking_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
      consent_state     TEXT NOT NULL DEFAULT 'none',
      consent_sent_at   TIMESTAMPTZ,
      added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS team_member_manager_idx ON team_member(manager_id)`;
    // Flag rows as joined-via-invite vs manager-added (so the dashboard can
    // show different pills). Defaults to manager-added for legacy rows.
    await sql`ALTER TABLE team_member ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manager-added'`;
    await sql`CREATE TABLE IF NOT EXISTS score_snapshot (
      id              TEXT PRIMARY KEY,
      team_member_id  TEXT NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
      week_of         DATE NOT NULL,
      total           INTEGER NOT NULL,
      sub_scores      JSONB NOT NULL,
      tier            TEXT,
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(team_member_id, week_of)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS score_snapshot_member_idx ON score_snapshot(team_member_id, week_of DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS consent_token (
      token           TEXT PRIMARY KEY,
      team_member_id  TEXT NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
      expires_at      TIMESTAMPTZ NOT NULL
    )`;
  })();
  return _schemaReady;
}

/* ─────────── id + week helpers ─────────── */

export function newId() {
  // 22-char URL-safe base62-ish id, plenty of entropy for this scale.
  const bytes = new Uint8Array(16);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 22);
}

/**
 * First-of-month UTC as YYYY-MM-DD. All snapshots bucket to a single
 * period_of value so monthly aggregates and "did they move?" deltas are clean.
 * (Stored in the DB column `week_of` for legacy reasons — same shape, just
 * holds a different cadence's anchor date now.)
 */
export function periodOf(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}-01`;
}

/** Returns the period anchor for the previous month — used for month-over-month deltas. */
export function previousPeriodOf(d = new Date()) {
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return periodOf(prev);
}

// Back-compat alias so any straggling import doesn't break.
export const weekOf = periodOf;
