import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { invitationTokenHash, protectInvitationSecret, revealInvitationSecret, sessionTokenId } from './invitation-secrets.js';
import { initialSchema } from './schema.js';

const APPLICATION_TABLES = [
  'sessions', 'new_session_limits', 'profiles', 'rooms', 'join_attempts', 'matches', 'pending_actions',
  'round_results', 'presence_events', 'telemetry_events', 'ranked_ownership', 'ranked_queue',
  'rating_settlements', 'settlement_failures', 'settlement_duplicate_attempts', 'disconnect_incidents',
  'ranked_invitations', 'ranked_code_attempts', 'quick_rematch_invitations',
];

function hasApplicationData(db: Database.Database): boolean {
  return APPLICATION_TABLES.filter((table) => table !== 'ranked_code_attempts')
    .some((table) => Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()));
}

export function initializeDatabase(db: Database.Database, options: { workerBaseline?: boolean } = {}): Database.Database {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(initialSchema);
  if (options.workerBaseline) {
    const workerBaselineApplied = [1, 2, 3, 4, 5].every((version) =>
      Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)));
    if (!workerBaselineApplied && hasApplicationData(db)) {
      db.close();
      throw new Error('Cannot apply the current Worker schema baseline to a database with application data');
    }
    if (!workerBaselineApplied) db.exec(`CREATE TABLE IF NOT EXISTS ranked_code_attempts (
      uid TEXT PRIMARY KEY REFERENCES profiles(uid),
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_room_per_creation_key
      ON rooms(host_key, creation_key) WHERE creation_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_bot_match_per_human_creation_key
      ON matches(CASE WHEN player_a_key LIKE 'bot:%' THEN player_b_key ELSE player_a_key END, creation_key)
      WHERE creation_key IS NOT NULL AND bot_difficulty IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ranked_challenge_code
      ON ranked_invitations(code) WHERE code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_token_hash ON rooms(invite_token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS ranked_invite_token_hash ON ranked_invitations(token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS ranked_challenge_code_hash
      ON ranked_invitations(code_hash) WHERE code_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS quick_rematch_token_hash ON quick_rematch_invitations(token_hash);`);
    if (!workerBaselineApplied) {
      for (const version of [1, 2, 3, 4]) {
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      }
    }
  } else {
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
  let keyCheck = db.prepare('SELECT value FROM secret_key_verification WHERE id = 1').get() as { value: string } | undefined;
  try {
    if (!keyCheck || revealInvitationSecret(keyCheck.value) !== 'override invitation key verification v1') {
      throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
    }
  } catch (error) {
    if (hasApplicationData(db)) {
      db.close();
      if (error instanceof Error && error.message.includes('INVITATION_ENCRYPTION_KEY')) throw error;
      throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
    }
    const replacement = protectInvitationSecret('override invitation key verification v1');
    db.prepare('UPDATE secret_key_verification SET value = ? WHERE id = 1').run(replacement);
    keyCheck = { value: replacement };
  }
  if (!keyCheck || revealInvitationSecret(keyCheck.value) !== 'override invitation key verification v1') {
    db.close();
    throw new Error('INVITATION_ENCRYPTION_KEY does not match this database');
  }
  return db;
}
