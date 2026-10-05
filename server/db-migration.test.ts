import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingSession, type Session } from './http';
import { openDatabase } from './db';
import { invitationTokenHash, revealInvitationSecret, sessionTokenId } from './invitation-secrets';
import { createQuickRoom } from './rooms';

const directories: string[] = [];
const legacySessionToken = 'a'.repeat(64);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function oldDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'override-migration-'));
  directories.push(directory);
  const path = join(directory, 'old.sqlite');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE profiles (uid TEXT PRIMARY KEY, handle TEXT, normalized_handle TEXT UNIQUE, created_at INTEGER NOT NULL);
    INSERT INTO profiles VALUES ('creator', 'Creator', 'creator', 1);
    CREATE TABLE ranked_invitations (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, creator_uid TEXT NOT NULL REFERENCES profiles(uid),
      invitee_uid TEXT REFERENCES profiles(uid), parent_match_id TEXT REFERENCES matches(id), status TEXT NOT NULL,
      match_id TEXT REFERENCES matches(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, invite_token TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL, host_key TEXT NOT NULL, guest_key TEXT, host_name TEXT NOT NULL,
      guest_name TEXT, status TEXT NOT NULL, match_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, room_id TEXT, mode TEXT NOT NULL, bot_difficulty TEXT,
      player_a_key TEXT NOT NULL, player_b_key TEXT NOT NULL, player_a_name TEXT NOT NULL,
      player_b_name TEXT NOT NULL, state_json TEXT NOT NULL, status TEXT NOT NULL,
      deadline INTEGER, transition_at INTEGER
    );
  `);
  db.prepare('INSERT INTO sessions VALUES (?, NULL, 1, ?)').run(legacySessionToken, Date.now() + 60_000);
  db.close();
  return path;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

describe('database schema migration', () => {
  it('upgrades an old file once and preserves existing data', () => {
    const path = oldDatabasePath();
    const old = new Database(path);
    old.prepare(`INSERT INTO rooms (id, code, invite_token, mode, host_key, host_name, status, created_at, expires_at)
      VALUES ('legacy-room', 'ABC234', 'legacy-room-token', 'quick', ?, 'Host', 'open', 1, ?)`)
      .run(legacySessionToken, Date.now() + 60_000);
    old.prepare(`INSERT INTO ranked_invitations (id, token, kind, creator_uid, status, created_at, expires_at)
      VALUES ('legacy-challenge', 'legacy-token', 'challenge', 'creator', 'open', ?, ?)`)
      .run(Date.now(), Date.now() + 60_000);
    old.close();
    let db = openDatabase(path);
    expect(columns(db, 'sessions')).toContain('google_nonce_hash');
    expect(columns(db, 'rooms')).toContain('creation_key');
    expect(columns(db, 'matches')).toContain('decision_duration_ms');
    expect(columns(db, 'ranked_invitations')).toContain('code');
    expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: sessionTokenId(legacySessionToken) });
    expect(existingSession({ headers: { cookie: `override_session=${legacySessionToken}` } } as never, db)?.id)
      .toBe(sessionTokenId(legacySessionToken));
    expect(db.prepare("SELECT host_key FROM rooms WHERE id = 'legacy-room'").get())
      .toEqual({ host_key: sessionTokenId(legacySessionToken) });
    const challenge = db.prepare("SELECT token, token_hash, code, code_hash FROM ranked_invitations WHERE id = 'legacy-challenge'").get() as { token: string; token_hash: string; code: string; code_hash: string };
    expect(challenge.token).not.toBe('legacy-token');
    expect(challenge.token_hash).toBe(invitationTokenHash('legacy-token'));
    expect(revealInvitationSecret(challenge.code)).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    const legacyRoom = db.prepare("SELECT invite_token, invite_token_hash FROM rooms WHERE id = 'legacy-room'").get() as { invite_token: string; invite_token_hash: string };
    expect(legacyRoom.invite_token).not.toBe('legacy-room-token');
    expect(legacyRoom.invite_token_hash).toBe(invitationTokenHash('legacy-room-token'));
    expect(revealInvitationSecret(legacyRoom.invite_token)).toBe('legacy-room-token');
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 },
    ]);
    db.close();

    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 5 });
    expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: sessionTokenId(legacySessionToken) });
    db.close();
  });

  it('rolls back a failed migration and can retry it', () => {
    const path = oldDatabasePath();
    const blocker = new Database(path);
    blocker.exec(`CREATE TRIGGER block_schema_version BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'migration marker failure'); END;`);
    blocker.close();

    expect(() => openDatabase(path)).toThrow('migration marker failure');
    const check = new Database(path);
    expect(columns(check, 'sessions')).toContain('google_nonce_hash');
    expect(columns(check, 'ranked_invitations')).not.toContain('code');
    expect(columns(check, 'ranked_code_attempts')).toHaveLength(0);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ranked_challenge_code'").get()).toBeUndefined();
    check.exec('DROP TRIGGER block_schema_version');
    check.close();

    const recovered = openDatabase(path);
    expect(columns(recovered, 'sessions')).toContain('google_nonce_hash');
    expect(columns(recovered, 'ranked_invitations')).toContain('code');
    expect(recovered.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 },
    ]);
    recovered.close();
  });

  it('rejects restoring the database with a different invitation encryption key', () => {
    const path = oldDatabasePath();
    const priorKey = process.env.INVITATION_ENCRYPTION_KEY;
    try {
      process.env.INVITATION_ENCRYPTION_KEY = 'restore-key-that-is-correct';
      const original = openDatabase(path);
      original.close();
      process.env.INVITATION_ENCRYPTION_KEY = 'restore-key-that-is-wrong';
      expect(() => openDatabase(path)).toThrow('INVITATION_ENCRYPTION_KEY does not match this database');
      process.env.INVITATION_ENCRYPTION_KEY = 'restore-key-that-is-correct';
      const restored = openDatabase(path);
      expect(restored.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
      restored.close();
    } finally {
      if (priorKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
      else process.env.INVITATION_ENCRYPTION_KEY = priorKey;
    }
  });

  it('rekeys an initialized but empty database when the production key is added later', () => {
    const directory = mkdtempSync(join(tmpdir(), 'override-empty-migration-'));
    directories.push(directory);
    const path = join(directory, 'empty.sqlite');
    const priorKey = process.env.INVITATION_ENCRYPTION_KEY;
    try {
      process.env.INVITATION_ENCRYPTION_KEY = 'initial-local-fallback-key';
      openDatabase(path).close();
      process.env.INVITATION_ENCRYPTION_KEY = 'production-encryption-key';
      const db = openDatabase(path);
      expect(db.prepare('SELECT value FROM secret_key_verification WHERE id = 1').get()).toBeDefined();
      db.close();
    } finally {
      if (priorKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
      else process.env.INVITATION_ENCRYPTION_KEY = priorKey;
    }
  });

  it('rejects a wrong key before migrating sessions in an older encrypted database', () => {
    const path = oldDatabasePath();
    const priorKey = process.env.INVITATION_ENCRYPTION_KEY;
    const legacyId = 'b'.repeat(64);
    try {
      process.env.INVITATION_ENCRYPTION_KEY = 'legacy-ciphertext-key-a';
      const db = openDatabase(path);
      db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
        .run(legacyId, Date.now(), Date.now() + 60_000);
      createQuickRoom(db, { id: legacyId, uid: null, createdAt: Date.now(), expiresAt: Date.now() + 60_000 } satisfies Session, 'Host');
      db.prepare('DELETE FROM schema_migrations WHERE version IN (4, 5)').run();
      db.exec('DROP TABLE secret_key_verification');
      db.close();

      process.env.INVITATION_ENCRYPTION_KEY = 'legacy-ciphertext-key-b';
      expect(() => openDatabase(path)).toThrow('INVITATION_ENCRYPTION_KEY does not match this database');
      const check = new Database(path);
      expect(check.prepare('SELECT id FROM sessions WHERE id = ?').get(legacyId)).toEqual({ id: legacyId });
      expect(check.prepare('SELECT version FROM schema_migrations WHERE version = 4').get()).toBeUndefined();
      check.close();
    } finally {
      if (priorKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
      else process.env.INVITATION_ENCRYPTION_KEY = priorKey;
    }
  });
});
