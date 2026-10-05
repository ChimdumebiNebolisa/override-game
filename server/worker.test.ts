import { afterEach, expect, it } from 'vitest';
import worker, { GameDurableObject } from './worker.js';
import { createWorkerTestStorage } from './worker-test-storage.js';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;
const originalFirebase = process.env.FIREBASE_WEB_CONFIG;
const originalKey = process.env.INVITATION_ENCRYPTION_KEY;
const stores: ReturnType<typeof createWorkerTestStorage>[] = [];

afterEach(() => {
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
