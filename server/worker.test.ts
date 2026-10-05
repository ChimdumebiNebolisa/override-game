import { afterEach, expect, it, vi } from 'vitest';
import worker, { GameDurableObject } from './worker.js';
import { createWorkerTestStorage } from './worker-test-storage.js';
import { createInitialState } from '../src/shared/rules.js';
import { createRankedShell } from './ranked.js';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;
const originalFirebase = process.env.FIREBASE_WEB_CONFIG;
const originalKey = process.env.INVITATION_ENCRYPTION_KEY;
const stores: ReturnType<typeof createWorkerTestStorage>[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const { sqlite } of stores.splice(0)) sqlite.close();
  for (const [key, value] of Object.entries({
    NODE_ENV: originalEnvironment,
    PUBLIC_ORIGIN: originalOrigin,
    FIREBASE_WEB_CONFIG: originalFirebase,
    INVITATION_ENCRYPTION_KEY: originalKey,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('routes Worker API requests through durable SQLite sessions and room creation', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const config = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
  };
  const store = createWorkerTestStorage();
  stores.push(store);
  const sql = {
    ...store.storage.sql,
    exec(statement: string, ...bindings: unknown[]) {
      if (/^\s*PRAGMA\s+page_count\b/i.test(statement)) throw new Error('not authorized: SQLITE_AUTH');
      if (/^SELECT MIN\(column1\) AS due_at FROM \(VALUES/i.test(statement) && /\bUNION\b/i.test(statement)) {
        throw new Error('too many terms in compound SELECT: SQLITE_ERROR');
      }
      return store.storage.sql.exec(statement, ...bindings);
    },
  };
  const storage = { ...store.storage, sql };
  const sockets: WorkerWebSocket[] = [];
  const ctx = {
    storage,
    acceptWebSocket(socket: WorkerWebSocket) { sockets.push(socket); },
    getWebSockets() { return sockets; },
  };
  let durable!: GameDurableObject;
  const namespace = {
    idFromName(name: string) { return name; },
    get() { return { fetch: durable.fetch.bind(durable) }; },
  };
  const assets = { async fetch() { return new Response('app'); } };
  const workerEnv = { ...config, GAME: namespace, ASSETS: assets };
  durable = new GameDurableObject(ctx, workerEnv);

  const health = await worker.fetch(new Request(`${origin}/api/health`), workerEnv);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  const configResponse = await worker.fetch(new Request(`${origin}/api/config`), workerEnv);
  expect((await configResponse.json()).firebaseConfig).toMatchObject({ authDomain: 'localhost:5173' });

  const sessionResponse = await worker.fetch(new Request(`${origin}/api/session`), workerEnv);
  expect(sessionResponse.status).toBe(200);
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^override_session=[a-f0-9]{64}$/);

  const roomResponse = await worker.fetch(new Request(`${origin}/api/rooms`, {
    method: 'POST',
    headers: { cookie: cookie!, origin, 'x-requested-with': 'override-game', 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host', creationKey: '11111111-1111-4111-8111-111111111111' }),
  }), workerEnv);
  expect(roomResponse.status).toBe(201);
  expect(await roomResponse.json()).toMatchObject({ room: { hostDisplayName: 'Host', mode: 'quick' } });

  const staticResponse = await worker.fetch(new Request(origin), workerEnv);
  expect(await staticResponse.text()).toBe('app');
  expect(await store.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_usage').get()).toEqual({ count: 1 });
});

it('reopens an initialized Worker database after guest session data has been written', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const env = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { throw new Error('Not used by this test'); } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const store = createWorkerTestStorage();
  stores.push(store);
  const ctx = { storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
  const request = new Request(`${origin}/api/session`);

  const firstInstance = new GameDurableObject(ctx, env);
  expect((await firstInstance.fetch(request)).status).toBe(200);

  const restartedInstance = new GameDurableObject(ctx, env);
  expect((await restartedInstance.fetch(request)).status).toBe(200);
});

it('rejects an oversized JSON stream before consuming the remaining request body', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const store = createWorkerTestStorage();
  stores.push(store);
  let durable!: GameDurableObject;
  const env = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { return { fetch(request: Request): Promise<Response> { return durable.fetch(request); } }; } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const ctx = { storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
  durable = new GameDurableObject(ctx, env);
  let deliveredChunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      deliveredChunks += 1;
      controller.enqueue(new Uint8Array(8_192));
      if (deliveredChunks === 4) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await worker.fetch(new Request(`${origin}/api/telemetry`, {
    method: 'POST',
    headers: { origin, 'x-requested-with': 'override-game', 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit), env);

  expect(response.status).toBe(413);
  expect(deliveredChunks).toBeLessThan(4);
  expect(cancelled).toBe(true);
});

it('proxies Firebase auth helper requests to the configured project without following redirects', async () => {
  const upstreamFetch = vi.fn(async (_request: Request, _options?: RequestInit) => new Response('helper', { status: 200 }));
  vi.stubGlobal('fetch', upstreamFetch);
  const env = {
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { throw new Error('Not used by this test'); } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };

  const response = await worker.fetch(new Request('https://game.example/__/auth/iframe?apiKey=test'), env);
  expect(response.status).toBe(200);
  const [upstreamRequest, options] = upstreamFetch.mock.calls[0]!;
  expect(new URL(upstreamRequest.url).href).toBe('https://override-game.firebaseapp.com/__/auth/iframe?apiKey=test');
  expect(options).toMatchObject({ redirect: 'manual' });
});

it('protects PITR bookmarks and restores, then keeps player API paused until the Durable Object restarts', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const store = createWorkerTestStorage();
  stores.push(store);
  const restoredBookmarks: string[] = [];
  const alarms: number[] = [];
  const abort = vi.fn();
  const storage = {
    ...store.storage,
    async getCurrentBookmark() { return 'bookmark-current'; },
    async getBookmarkForTime(timestamp: number) { return `bookmark-at-${timestamp}`; },
    async onNextSessionRestoreBookmark(bookmark: string) { restoredBookmarks.push(bookmark); return 'bookmark-before-restore'; },
    async setAlarm(timestamp: number) { alarms.push(timestamp); await store.storage.setAlarm(timestamp); },
  };
  let durable!: GameDurableObject;
  const env = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    RECOVERY_CONTROL_TOKEN: 'local-recovery-token-for-test-only-0123456789',
    GAME: { idFromName(name: string) { return name; }, get() { return { fetch(request: Request): Promise<Response> { return durable.fetch(request); } }; } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const ctx = { storage, abort, acceptWebSocket() {}, getWebSockets() { return []; } };
  durable = new GameDurableObject(ctx, env);
  const endpoint = `${origin}/__ops/recovery/bookmark`;
  const unauthorized = await worker.fetch(new Request(endpoint, { method: 'POST' }), env);
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toMatchObject({ error: 'Unauthorized' });
  const unauthorizedRestore = await worker.fetch(new Request(`${origin}/__ops/recovery/restore`, { method: 'POST', body: '{}' }), env);
  expect(unauthorizedRestore.status).toBe(401);

  const headers = { authorization: `Bearer ${env.RECOVERY_CONTROL_TOKEN}`, 'content-type': 'application/json' };
  const bookmark = await worker.fetch(new Request(endpoint, { method: 'POST', headers, body: '{}' }), env);
  expect(bookmark.status).toBe(200);
  expect(await bookmark.json()).toEqual({ bookmark: 'bookmark-current' });

  const requestedAt = Date.now() - 24 * 60 * 60_000;
  const oversizedRestore = await worker.fetch(new Request(`${origin}/__ops/recovery/restore`, {
    method: 'POST', headers, body: JSON.stringify({ timestamp: requestedAt, extra: 'x'.repeat(2_048) }),
  }), env);
  expect(oversizedRestore.status).toBe(413);
  expect(restoredBookmarks).toEqual([]);
  const restore = await worker.fetch(new Request(`${origin}/__ops/recovery/restore`, {
    method: 'POST', headers, body: JSON.stringify({ timestamp: requestedAt }),
  }), env);
  expect(restore.status).toBe(202);
  expect(await restore.json()).toMatchObject({ status: 'restore-scheduled', targetBookmark: `bookmark-at-${requestedAt}`, undoBookmark: 'bookmark-before-restore' });
  expect(restoredBookmarks).toEqual([`bookmark-at-${requestedAt}`]);
  expect(alarms).toHaveLength(1);
  expect((await worker.fetch(new Request(`${origin}/api/health`), env)).status).toBe(503);

  await durable.alarm();
  expect(abort).toHaveBeenCalledOnce();
});

it('pauses new games at the safety threshold while accepted match actions and alarms continue', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const store = createWorkerTestStorage();
  stores.push(store);
  let durable!: GameDurableObject;
  const env = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { return { fetch(request: Request): Promise<Response> { return durable.fetch(request); } }; } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const ctx = { storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
  durable = new GameDurableObject(ctx, env);
  const session = await worker.fetch(new Request(`${origin}/api/session`), env);
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, origin, 'x-requested-with': 'override-game', 'content-type': 'application/json' };
  const created = await worker.fetch(new Request(`${origin}/api/bot-matches`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'practice', difficulty: 'easy', displayName: 'Worker', creationKey: '11111111-1111-4111-8111-111111111111' }),
  }), env);
  expect(created.status).toBe(201);
  const { match } = await created.json() as { match: { id: string; revision: number } };
  const month = new Date().toISOString().slice(0, 7);
  store.sqlite.prepare(`INSERT INTO worker_usage (month, request_units, active_ms, rows_read, rows_written)
    VALUES (?, 3200000, 0, 0, 0) ON CONFLICT(month) DO UPDATE SET request_units = 3200000`).run(month);

  const refused = await worker.fetch(new Request(`${origin}/api/bot-matches`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'quick', difficulty: 'easy', displayName: 'Worker', creationKey: '22222222-2222-4222-8222-222222222222' }),
  }), env);
  expect(refused.status).toBe(503);

  const action = await worker.fetch(new Request(`${origin}/api/matches/${match.id}/actions`, {
    method: 'POST', headers, body: JSON.stringify({ action: { type: 'pass' }, round: 1, revision: match.revision }),
  }), env);
  expect(action.status).toBe(200);
  store.sqlite.prepare('UPDATE matches SET transition_at = ? WHERE id = ?').run(Date.now() - 1, match.id);
  await durable.alarm();
  const resumed = await worker.fetch(new Request(`${origin}/api/matches/${match.id}`, { headers: { cookie } }), env);
  expect(resumed.status).toBe(200);
  expect((await resumed.json()).match).toMatchObject({ status: 'decision', state: { round: 2 } });

  store.sqlite.prepare('UPDATE worker_usage SET request_units = 0 WHERE month = ?').run(month);
  store.sqlite.prepare('UPDATE worker_daily_usage SET request_units = 1600000 WHERE day = ?').run(new Date().toISOString().slice(0, 10));
  const dailyLimitRefusal = await worker.fetch(new Request(`${origin}/api/bot-matches`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'quick', difficulty: 'easy', displayName: 'Worker', creationKey: '33333333-3333-4333-8333-333333333333' }),
  }), env);
  expect(dailyLimitRefusal.status).toBe(503);
});

it('settles an interrupted terminal Ranked match once from the Worker alarm path', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const store = createWorkerTestStorage();
  stores.push(store);
  let durable!: GameDurableObject;
  const env = {
    PUBLIC_ORIGIN: origin,
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { return { fetch(request: Request): Promise<Response> { return durable.fetch(request); } }; } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const ctx = { storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
  durable = new GameDurableObject(ctx, env);
  store.sqlite.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run('runtime-a', 'RuntimeA', 'runtimea', 1);
  store.sqlite.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run('runtime-b', 'RuntimeB', 'runtimeb', 1);
  const shell = createRankedShell(store.sqlite, 'runtime-a', 'runtime-b', Date.now() - 10_000);
  const terminal = { ...createInitialState(), status: 'finished' as const, winner: 'A' as const, endingReason: 'board-control' as const };
  store.sqlite.prepare(`UPDATE matches SET status = 'finished', started_at = ?, ended_at = ?, ready_deadline = NULL,
    state_json = ?, result_type = 'result' WHERE id = ?`).run(Date.now() - 10_000, Date.now() - 1, JSON.stringify(terminal), shell.matchId);

  await durable.alarm();
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(shell.matchId)).toEqual({ count: 1 });
  expect(store.sqlite.prepare('SELECT placement_progress FROM profiles WHERE uid = ?').get('runtime-a')).toEqual({ placement_progress: 1 });

  await durable.alarm();
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(shell.matchId)).toEqual({ count: 1 });
  expect(store.sqlite.prepare('SELECT placement_progress FROM profiles WHERE uid = ?').get('runtime-a')).toEqual({ placement_progress: 1 });
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM settlement_duplicate_attempts WHERE match_id = ?').get(shell.matchId)).toEqual({ count: 0 });
});
