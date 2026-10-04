import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db';

const directories: string[] = [];

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
    INSERT INTO sessions VALUES ('saved-session', NULL, 1, 999999);
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
  db.close();
  return path;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

describe('database schema migration', () => {
  it('upgrades an old file once and preserves existing data', () => {
    const path = oldDatabasePath();
    let db = openDatabase(path);
    expect(columns(db, 'sessions')).toContain('google_nonce_hash');
    expect(columns(db, 'rooms')).toContain('creation_key');
    expect(columns(db, 'matches')).toContain('decision_duration_ms');
    expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: 'saved-session' });
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    db.close();

    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: 'saved-session' });
    db.close();
  });

  it('rolls back a failed migration and can retry it', () => {
    const path = oldDatabasePath();
    const blocker = new Database(path);
    blocker.exec(`CREATE TRIGGER block_schema_version BEFORE INSERT ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'migration marker failure'); END;`);
    blocker.close();

    expect(() => openDatabase(path)).toThrow('migration marker failure');
    const check = new Database(path);
    expect(columns(check, 'sessions')).not.toContain('google_nonce_hash');
    check.exec('DROP TRIGGER block_schema_version');
    check.close();

    const recovered = openDatabase(path);
    expect(columns(recovered, 'sessions')).toContain('google_nonce_hash');
    expect(recovered.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    recovered.close();
  });
});
