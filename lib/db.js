/**
 * lib/db.js — Postgres client + schema bootstrap for the team-audit feature.
 *
 * Uses @vercel/postgres (Neon-backed) — set POSTGRES_URL on Vercel and locally.
 * ensureSchema() is idempotent; safe to call on every cold start.
 *
 * Tables:
 *   manager           — authenticated team-leader accounts
 *   magic_link        — short-lived email auth tokens
 *   team_member       — LinkedIn URLs a manager has added (max 10/manager)
 *   score_snapshot    — weekly score history per team_member
 *   consent_token     — opt-in/out tokens emailed to team members
 */

import { sql } from '@vercel/postgres';

let _schemaReady = null;

export async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS manager (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
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

export { sql };

/* ─────────── id + week helpers ─────────── */

export function newId() {
  // 22-char URL-safe base62-ish id, plenty of entropy for this scale.
  const bytes = new Uint8Array(16);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 22);
}

/**
 * ISO week-start (Monday) as YYYY-MM-DD. All snapshots bucket to a single
 * week_of value so weekly aggregates and "did they move?" deltas are clean.
 */
export function weekOf(d = new Date()) {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7; // Sunday = 7
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}
