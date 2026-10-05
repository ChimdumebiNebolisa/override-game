import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from './schema-initializer.js';
import { WorkerSqliteDatabase, asDomainDatabase } from './worker-sqlite.js';
import { createQuickRoom } from './rooms.js';
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
