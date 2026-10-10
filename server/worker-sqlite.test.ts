import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from './schema-initializer.js';
import { WorkerSqliteDatabase, asDomainDatabase } from './worker-sqlite.js';
import { createQuickRoom, joinQuickRoom } from './rooms.js';
import { resignMatch } from './matches.js';
import { requestQuickRematch, acceptQuickRematch } from './quick-rematch.js';
import { createRankedChallenge, acceptRankedChallenge, requestRankedRematch, acceptRankedRematch } from './invitations.js';
import { acknowledgeRankedReady, markRankedReadyPresence, settleRankedMatch } from './ranked.js';
import { createWorkerTestStorage } from './worker-test-storage.js';

const originalEnvironment = process.env.NODE_ENV;
const originalKey = process.env.INVITATION_ENCRYPTION_KEY;
const stores: ReturnType<typeof createWorkerTestStorage>[] = [];

afterEach(() => {
  for (const { sqlite } of stores.splice(0)) sqlite.close();
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
  else process.env.INVITATION_ENCRYPTION_KEY = originalKey;
});

it('creates and accepts Quick and Ranked invitations using the platform binding contract', () => {
  process.env.NODE_ENV = 'test';
  process.env.INVITATION_ENCRYPTION_KEY = 'worker-adapter-test-key';
  const { db } = workerDatabase();
  initializeDatabase(db);
  const now = Date.now();
  const host = { id: 'host', uid: null, createdAt: now, expiresAt: now + 86_400_000 };
  const guest = { ...host, id: 'guest' };
  for (const session of [host, guest]) {
    db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(session.id, now, session.expiresAt);
  }
  const room = createQuickRoom(db, host, 'Host');
  const joined = joinQuickRoom(db, guest, { code: room.code }, 'Guest');
  resignMatch(db, joined.matchId!, host);
  const quick = requestQuickRematch(db, joined.matchId!, host.id);
  const quickAccepted = acceptQuickRematch(db, quick.token, guest.id);
  expect(quickAccepted.matchId).not.toBe(joined.matchId);
  expect(acceptQuickRematch(db, quick.token, guest.id)).toEqual(quickAccepted);

  for (const uid of ['a', 'b']) {
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
  }
  const challenge = createRankedChallenge(db, 'a');
  const shell = acceptRankedChallenge(db, challenge.token, 'b');
  for (const uid of ['a', 'b']) markRankedReadyPresence(db, shell.matchId, uid, true);
  for (const uid of ['a', 'b']) acknowledgeRankedReady(db, shell.matchId, uid);
  resignMatch(db, shell.matchId, { ...host, uid: 'a' });
  settleRankedMatch(db, shell.matchId);
  const ranked = requestRankedRematch(db, shell.matchId, 'a');
  const rankedAccepted = acceptRankedRematch(db, ranked.token, 'b');
  expect(rankedAccepted.matchId).not.toBe(shell.matchId);
  expect(acceptRankedRematch(db, ranked.token, 'b')).toEqual(rankedAccepted);
});

it.each(['get', 'all', 'run', 'exec', 'pragma'] as const)('counts final cursor reads and writes for %s', (operation) => {
  const sql = {
    exec(statement: string) {
      let consumed = false;
      const changes = statement === 'SELECT changes() AS changes';
      const rows = changes ? [{ changes: 10 }] : [{ value: 1 }, { value: 2 }];
      return {
        get rowsRead() { return consumed ? changes ? 1 : 100 : 0; },
        get rowsWritten() { return consumed && !changes ? 10 : 0; },
        next() { return { done: false as const, value: rows[0] }; },
        toArray() { consumed = true; return rows; },
      };
    },
  };
  const adapter = new WorkerSqliteDatabase(sql, { transactionSync: (callback) => callback() });
  if (operation === 'exec') adapter.exec('statement');
  else if (operation === 'pragma') adapter.pragma('page_count');
  else adapter.prepare('statement')[operation]();
  expect(adapter.takeUsage()).toEqual({ rowsRead: operation === 'run' ? 101 : 100, rowsWritten: 10 });
  expect(adapter.takeUsage()).toEqual({ rowsRead: 0, rowsWritten: 0 });
});

function workerDatabase() {
  const store = createWorkerTestStorage();
  stores.push(store);
  const adapter = new WorkerSqliteDatabase(store.storage.sql, store.storage);
  return { adapter, db: asDomainDatabase(adapter) };
}

it('initializes the app schema and applies atomic domain transactions through the Worker SQLite adapter', () => {
  process.env.NODE_ENV = 'test';
  process.env.INVITATION_ENCRYPTION_KEY = 'worker-adapter-test-key';
  const { adapter, db } = workerDatabase();
  initializeDatabase(db);

  const changes = adapter.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run('session-1', 1, 999_999);
  expect(changes.changes).toBe(1);
  const host = { id: 'session-1', uid: null, createdAt: 1, expiresAt: 999_999 };
  const room = createQuickRoom(db, host, 'Host');
  expect(room.hostDisplayName).toBe('Host');
  expect(room.inviteUrl).toContain('/join/');
  expect(adapter.prepare('SELECT count(*) AS count FROM rooms').get()).toEqual({ count: 1 });

  expect(() => adapter.transaction(() => {
    adapter.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
      .run('rollback-me', 1, 999_999);
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(adapter.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get('rollback-me')).toBeUndefined();
});

it('initializes the current Worker schema without unsupported table_info pragmas', () => {
  process.env.NODE_ENV = 'test';
  process.env.INVITATION_ENCRYPTION_KEY = 'worker-adapter-test-key';
  const store = createWorkerTestStorage();
  stores.push(store);
  const sql = {
    ...store.storage.sql,
    exec(statement: string, ...bindings: unknown[]) {
      if (/^\s*PRAGMA\s+table_info\b/i.test(statement)) throw new Error('not authorized: SQLITE_AUTH');
      return store.storage.sql.exec(statement, ...bindings);
    },
  };
  const adapter = new WorkerSqliteDatabase(sql, store.storage);
  const db = asDomainDatabase(adapter);

  expect(() => initializeDatabase(db, { workerBaseline: true })).not.toThrow();
  expect(adapter.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
    .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
});
