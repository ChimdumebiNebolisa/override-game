import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { invitationTokenHash, protectInvitationSecret, revealInvitationSecret, sessionTokenId } from './invitation-secrets.js';
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
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
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
      invite_token_hash TEXT,
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
      code TEXT,
      code_hash TEXT,
      token_hash TEXT,
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
      token_hash TEXT,
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
  try {
    db.transaction(() => {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
      if (applied) return;
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
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    db.transaction(() => {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get();
      if (applied) return;
      const invitationColumns = db.prepare('PRAGMA table_info(ranked_invitations)').all() as { name: string }[];
      if (!invitationColumns.some((column) => column.name === 'code')) {
        db.exec('ALTER TABLE ranked_invitations ADD COLUMN code TEXT');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS ranked_code_attempts (
        uid TEXT PRIMARY KEY REFERENCES profiles(uid),
        window_started_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      )`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ranked_challenge_code ON ranked_invitations(code) WHERE code IS NOT NULL');
      const legacyChallenges = db.prepare(`SELECT id FROM ranked_invitations
        WHERE kind = 'challenge' AND status = 'open' AND expires_at > ? AND code IS NULL`).all(Date.now()) as { id: string }[];
      const update = db.prepare('UPDATE ranked_invitations SET code = ? WHERE id = ? AND code IS NULL');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (const invite of legacyChallenges) {
        let assigned = false;
        for (let attempt = 0; attempt < 20 && !assigned; attempt++) {
          const code = [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join('');
          try { assigned = update.run(code, invite.id).changes === 1; }
          catch (error) {
            if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
          }
        }
        if (!assigned) throw new Error('Could not assign a unique Ranked challenge code');
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(Date.now());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    db.transaction(() => {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get();
      if (applied) return;
      const addColumn = (table: string, column: string) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      };
      addColumn('rooms', 'invite_token_hash');
      addColumn('ranked_invitations', 'token_hash');
      addColumn('ranked_invitations', 'code_hash');
      addColumn('quick_rematch_invitations', 'token_hash');
      const protectRows = (table: string, column: string, digest: string) => {
        const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS secret, ${digest} AS secret_hash FROM ${table}`)
          .all() as { row_id: number; secret: string; secret_hash: string | null }[];
        const update = db.prepare(`UPDATE ${table} SET ${column} = ?, ${digest} = ? WHERE rowid = ?`);
        for (const row of rows) {
          if (row.secret_hash && row.secret.startsWith('enc:v1:')) continue;
          const plain = revealInvitationSecret(row.secret);
          update.run(protectInvitationSecret(plain), invitationTokenHash(plain), row.row_id);
        }
      };
      protectRows('rooms', 'invite_token', 'invite_token_hash');
      protectRows('ranked_invitations', 'token', 'token_hash');
      protectRows('quick_rematch_invitations', 'token', 'token_hash');
      const codes = db.prepare('SELECT rowid AS row_id, code, code_hash FROM ranked_invitations WHERE code IS NOT NULL')
        .all() as { row_id: number; code: string; code_hash: string | null }[];
      const updateCode = db.prepare('UPDATE ranked_invitations SET code = ?, code_hash = ? WHERE rowid = ?');
      for (const row of codes) {
        if (row.code_hash && row.code.startsWith('enc:v1:')) continue;
        const plain = revealInvitationSecret(row.code);
        updateCode.run(protectInvitationSecret(plain), invitationTokenHash(plain), row.row_id);
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_token_hash ON rooms(invite_token_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS ranked_invite_token_hash ON ranked_invitations(token_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS ranked_challenge_code_hash ON ranked_invitations(code_hash) WHERE code_hash IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS quick_rematch_token_hash ON quick_rematch_invitations(token_hash);`);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(Date.now());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    db.transaction(() => {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get();
      if (applied) return;
      for (const [table, column] of [
        ['rooms', 'invite_token'], ['ranked_invitations', 'token'], ['ranked_invitations', 'code'],
        ['quick_rematch_invitations', 'token'],
      ]) {
        const values = db.prepare(`SELECT ${column} AS secret FROM ${table} WHERE ${column} LIKE 'enc:v1:%'`)
          .all() as { secret: string }[];
        try {
          for (const { secret } of values) revealInvitationSecret(secret);
        } catch {
          throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
        }
      }
      const sessions = db.prepare('SELECT id, uid, created_at, expires_at, google_nonce_hash, google_nonce_expires_at FROM sessions')
        .all() as Array<{ id: string; uid: string | null; created_at: number; expires_at: number;
          google_nonce_hash: string | null; google_nonce_expires_at: number | null }>;
      const insert = db.prepare(`INSERT INTO sessions (id, uid, created_at, expires_at, google_nonce_hash, google_nonce_expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const update = (table: string, column: string, oldId: string, newId: string) =>
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newId, oldId);
      for (const session of sessions) {
        const nextId = sessionTokenId(session.id);
        insert.run(nextId, session.uid, session.created_at, session.expires_at,
          session.google_nonce_hash, session.google_nonce_expires_at);
        for (const [table, column] of [
          ['rooms', 'host_key'], ['rooms', 'guest_key'], ['matches', 'player_a_key'], ['matches', 'player_b_key'],
          ['join_attempts', 'session_id'], ['telemetry_events', 'session_id'],
          ['quick_rematch_invitations', 'creator_session_id'], ['quick_rematch_invitations', 'invitee_session_id'],
        ]) update(table, column, session.id, nextId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(Date.now());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    db.transaction(() => {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 5').get();
      if (applied) return;
      db.exec(`CREATE TABLE IF NOT EXISTS secret_key_verification (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      )`);
      db.prepare('INSERT OR IGNORE INTO secret_key_verification (id, value) VALUES (1, ?)')
        .run(protectInvitationSecret('override invitation key verification v1'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)').run(Date.now());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  const keyCheck = db.prepare('SELECT value FROM secret_key_verification WHERE id = 1').get() as { value: string } | undefined;
  try {
    if (!keyCheck || revealInvitationSecret(keyCheck.value) !== 'override invitation key verification v1') {
      throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
    }
  } catch (error) {
    db.close();
    if (error instanceof Error && error.message.includes('INVITATION_ENCRYPTION_KEY')) throw error;
    throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
  }
  return db;
}
