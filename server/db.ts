import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const databasePath = process.env.DB_PATH ?? resolve('data/override.sqlite');

export function openDatabase(path = databasePath): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      uid TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      google_nonce_hash TEXT,
      google_nonce_expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS profiles (
      uid TEXT PRIMARY KEY,
      handle TEXT,
      normalized_handle TEXT UNIQUE,
      rating INTEGER NOT NULL DEFAULT 1000,
      peak_rating INTEGER NOT NULL DEFAULT 1000,
      placement_progress INTEGER NOT NULL DEFAULT 0,
      rated_match_count INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      renamed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      creation_key TEXT,
      code TEXT NOT NULL UNIQUE,
      invite_token TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('quick', 'ranked')),
      host_key TEXT NOT NULL,
      guest_key TEXT,
      host_name TEXT NOT NULL,
      guest_name TEXT,
      status TEXT NOT NULL,
      match_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_expires_at ON rooms(expires_at);
    CREATE TABLE IF NOT EXISTS join_attempts (
      session_id TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      creation_key TEXT,
      parent_match_id TEXT REFERENCES matches(id),
      restart_match_id TEXT REFERENCES matches(id),
      mode TEXT NOT NULL CHECK (mode IN ('quick', 'ranked', 'practice')),
      bot_difficulty TEXT,
      player_a_key TEXT NOT NULL,
      player_b_key TEXT NOT NULL,
      player_a_name TEXT NOT NULL,
      player_b_name TEXT NOT NULL,
      state_json TEXT NOT NULL,
      decision_duration_ms INTEGER NOT NULL DEFAULT 5000,
      status TEXT NOT NULL,
      deadline INTEGER,
      transition_at INTEGER,
      ready_deadline INTEGER,
      ready_a INTEGER NOT NULL DEFAULT 0,
      ready_b INTEGER NOT NULL DEFAULT 0,
      ready_connected_a INTEGER NOT NULL DEFAULT 0,
      ready_connected_b INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      ended_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 0,
      last_result_json TEXT,
      afk_a INTEGER NOT NULL DEFAULT 0,
      afk_b INTEGER NOT NULL DEFAULT 0,
      disconnect_a INTEGER NOT NULL DEFAULT 0,
      disconnect_b INTEGER NOT NULL DEFAULT 0,
      disconnected_a_at INTEGER,
      disconnected_b_at INTEGER,
      grace_until INTEGER,
      credit_assessed_at INTEGER,
      competitive_multiplier REAL,
      result_type TEXT,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );
    CREATE INDEX IF NOT EXISTS matches_due ON matches(status, deadline, transition_at);
    CREATE TABLE IF NOT EXISTS pending_actions (
      match_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      player TEXT NOT NULL CHECK (player IN ('A', 'B')),
      action_json TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      PRIMARY KEY (match_id, round, player),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS round_results (
      match_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      resolved_at INTEGER NOT NULL,
      PRIMARY KEY (match_id, round),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS presence_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      player TEXT NOT NULL CHECK (player IN ('A', 'B')),
      changed_at INTEGER NOT NULL,
      offline INTEGER NOT NULL CHECK (offline IN (0, 1)),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE INDEX IF NOT EXISTS presence_at_deadline ON presence_events(match_id, player, changed_at, id);
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mode TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telemetry_by_time ON telemetry_events(created_at, name);
    CREATE TABLE IF NOT EXISTS ranked_ownership (
      uid TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      match_id TEXT,
      lease_expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ranked_queue (
      uid TEXT PRIMARY KEY,
      joined_at INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      FOREIGN KEY (uid) REFERENCES profiles(uid)
    );
    CREATE TABLE IF NOT EXISTS rating_settlements (
      match_id TEXT PRIMARY KEY,
      settlement_json TEXT NOT NULL,
      settled_at INTEGER NOT NULL,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS settlement_failures (
      match_id TEXT PRIMARY KEY REFERENCES matches(id),
      attempts INTEGER NOT NULL,
      first_failed_at INTEGER NOT NULL,
      last_failed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlement_duplicate_attempts (
      match_id TEXT PRIMARY KEY REFERENCES matches(id),
      attempts INTEGER NOT NULL,
      first_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disconnect_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      match_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranked_invitations (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('challenge', 'rematch')),
      creator_uid TEXT NOT NULL REFERENCES profiles(uid),
      invitee_uid TEXT REFERENCES profiles(uid),
      parent_match_id TEXT REFERENCES matches(id),
      status TEXT NOT NULL CHECK(status IN ('open', 'accepted', 'expired', 'cancelled')),
      match_id TEXT REFERENCES matches(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ranked_invitations_due ON ranked_invitations(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_ranked_rematch
      ON ranked_invitations(parent_match_id) WHERE kind = 'rematch' AND status = 'open';
    CREATE TABLE IF NOT EXISTS quick_rematch_invitations (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      parent_match_id TEXT NOT NULL REFERENCES matches(id),
      room_id TEXT NOT NULL REFERENCES rooms(id),
      creator_session_id TEXT NOT NULL REFERENCES sessions(id),
      invitee_session_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK(status IN ('open', 'accepted', 'expired', 'cancelled')),
      new_match_id TEXT REFERENCES matches(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS quick_rematches_due ON quick_rematch_invitations(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_quick_rematch
      ON quick_rematch_invitations(parent_match_id) WHERE status = 'open';
  `);
  const matchColumns = db.prepare('PRAGMA table_info(matches)').all() as { name: string }[];
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[];
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === 'google_nonce_hash')) {
    db.exec('ALTER TABLE sessions ADD COLUMN google_nonce_hash TEXT');
  }
  if (!sessionColumns.some((column) => column.name === 'google_nonce_expires_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN google_nonce_expires_at INTEGER');
  }
  if (!roomColumns.some((column) => column.name === 'creation_key')) {
    db.exec('ALTER TABLE rooms ADD COLUMN creation_key TEXT');
  }
  if (!matchColumns.some((column) => column.name === 'creation_key')) {
    db.exec('ALTER TABLE matches ADD COLUMN creation_key TEXT');
  }
  if (!matchColumns.some((column) => column.name === 'decision_duration_ms')) {
    db.exec('ALTER TABLE matches ADD COLUMN decision_duration_ms INTEGER NOT NULL DEFAULT 5000');
  }
  if (!matchColumns.some((column) => column.name === 'parent_match_id')) {
    db.exec('ALTER TABLE matches ADD COLUMN parent_match_id TEXT REFERENCES matches(id)');
  }
  if (!matchColumns.some((column) => column.name === 'restart_match_id')) {
    db.exec('ALTER TABLE matches ADD COLUMN restart_match_id TEXT REFERENCES matches(id)');
  }
  if (!matchColumns.some((column) => column.name === 'ready_connected_a')) {
    db.exec('ALTER TABLE matches ADD COLUMN ready_connected_a INTEGER NOT NULL DEFAULT 0');
  }
  if (!matchColumns.some((column) => column.name === 'ready_connected_b')) {
    db.exec('ALTER TABLE matches ADD COLUMN ready_connected_b INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_room_per_creation_key
    ON rooms(host_key, creation_key) WHERE creation_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_bot_match_per_human_creation_key
    ON matches(CASE WHEN player_a_key LIKE 'bot:%' THEN player_b_key ELSE player_a_key END, creation_key)
    WHERE creation_key IS NOT NULL AND bot_difficulty IS NOT NULL;
    DROP INDEX IF EXISTS one_bot_match_per_creation_key;`);
  return db;
}
