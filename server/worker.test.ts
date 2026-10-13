import { afterEach, expect, it, vi } from 'vitest';
import worker, { GameDurableObject } from './worker.js';
import { createWorkerTestStorage } from './worker-test-storage.js';
import { createInitialState } from '../src/shared/rules.js';
import { acknowledgeRankedReady, createRankedShell, markRankedReadyPresence } from './ranked.js';
import { sessionTokenId } from './invitation-secrets.js';
import { createQuickRoom, joinQuickRoom } from './rooms.js';
import { createBotMatch, getMatch, lockAction, markConnected } from './matches.js';
import { pruneExpiredGuestData } from './maintenance.js';
import { asDomainDatabase, WorkerSqliteDatabase } from './worker-sqlite.js';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;
const originalFirebase = process.env.FIREBASE_WEB_CONFIG;
const originalKey = process.env.INVITATION_ENCRYPTION_KEY;
const stores: ReturnType<typeof createWorkerTestStorage>[] = [];

function blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> { return callback(); }

function fixture() {
  process.env.NODE_ENV = 'test';
  const store = createWorkerTestStorage();
  stores.push(store);
  const sockets: WorkerWebSocket[] = [];
  const env = {
    PUBLIC_ORIGIN: 'http://localhost:5173',
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    RECOVERY_CONTROL_TOKEN: 'local-recovery-token-for-test-only-0123456789',
    GAME: { idFromName(name: string) { return name; }, get() { throw new Error('Not used'); } },
    ASSETS: { async fetch() { return new Response('app'); } },
  };
  const ctx = { blockConcurrencyWhile, storage: store.storage, acceptWebSocket() {}, getWebSockets() { return sockets; } };
  return { store, sockets, env, ctx };
}

it.each(['actions', 'deadline', 'restart', 'account-recovery'] as const)('settles a rated Hard bot through Worker %s exactly once', async (completion) => {
  const { store, env, ctx } = fixture();
  let durable = new GameDurableObject(ctx, env);
  await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`));
  const now = Date.now(); const token = 'c'.repeat(64); const uid = 'bot-player';
  const actor = { id: sessionTokenId(token), uid, createdAt: now, expiresAt: now + 86_400_000 };
  store.sqlite.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
  store.sqlite.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)').run(actor.id, uid, now, actor.expiresAt);
  const send = (path: string, body?: object) => durable.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, {
    method: body ? 'POST' : 'GET', headers: { cookie: `override_session=${token}`, origin: env.PUBLIC_ORIGIN,
      'x-requested-with': 'override-game', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }));
  expect(await (await send('/api/bot-rating')).json()).toEqual({ eligible: true, opponentRating: 1000, multiplier: 0.5 });
  const body = { mode: 'quick', difficulty: 'hard', creationKey: '00000000-0000-4000-8000-000000000077' };
  const creations = await Promise.all([send('/api/bot-matches', body), send('/api/bot-matches', body)]);
  expect(creations.map((response) => response.status)).toEqual([201, 201]);
  const first = await creations[0].json() as { match: { id: string; player: 'A' | 'B'; ratedBot: { opponentRating: number } } };
  expect((await creations[1].json() as typeof first).match.id).toBe(first.match.id);
  const { id, player } = first.match;
  expect(first.match.ratedBot).toEqual({ opponentRating: 1000 });
  expect((await send('/api/bot-matches', { ...body, creationKey: '00000000-0000-4000-8000-000000000078' })).status).toBe(409);
  if (completion === 'actions') {
    const state = { ...createInitialState(), round: 12, energy: { A: 0, B: 0 }, board: Array(25).fill(player) };
    store.sqlite.prepare('UPDATE matches SET state_json = ? WHERE id = ?').run(JSON.stringify(state), id);
    const locks = await Promise.all([send(`/api/matches/${id}/actions`, { action: { type: 'pass' }, round: 12, revision: 1 }),
      send(`/api/matches/${id}/actions`, { action: { type: 'pass' }, round: 12, revision: 1 })]);
    expect(locks.map((response) => response.status).sort()).toEqual([200, 409]);
  } else if (completion === 'deadline') {
    store.sqlite.prepare(`UPDATE matches SET deadline = ?, ${player === 'A' ? 'afk_a' : 'afk_b'} = 2 WHERE id = ?`).run(now - 1, id);
    await durable.alarm();
  } else if (completion === 'account-recovery') {
    const replacement = 'd'.repeat(64);
    store.sqlite.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionTokenId(replacement), uid, now, actor.expiresAt);
    store.sqlite.prepare("UPDATE matches SET status = 'review', deadline = NULL WHERE id = ?").run(id);
    const recover = () => durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/bot-matches/${id}/resign`, {
      method: 'POST', headers: { cookie: `override_session=${replacement}`, origin: env.PUBLIC_ORIGIN,
        'x-requested-with': 'override-game', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    }));
    const recovered = await Promise.all([recover(), recover()]);
    expect(recovered.map(response => response.status)).toEqual([200, 200]);
    expect(await recovered[0].json()).toMatchObject({ settlement: { player: { outcome: 'loss' } } });
    expect((await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/matches/${id}`, {
      headers: { cookie: `override_session=${replacement}` },
    }))).status).toBe(404);
  } else {
    store.sqlite.prepare("UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, deadline = NULL WHERE id = ?")
      .run(JSON.stringify({ ...createInitialState(), status: 'finished', winner: player }), now - 10_000, id);
    expect((await send('/api/health')).status).toBe(503);
    durable = new GameDurableObject(ctx, env);
    await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`));
    await durable.alarm();
  }
  const read = await send(`/api/matches/${id}/settlement`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ settlement: { multiplier: 0.5, ratedBot: { opponentRating: 1000 }, player: { placementProgress: 1 } } });
  await durable.alarm();
  expect(store.sqlite.prepare('SELECT rating, placement_progress, rated_match_count FROM profiles WHERE uid = ?').get(uid))
    .toEqual({ rating: completion === 'deadline' || completion === 'account-recovery' ? 984 : 1016, placement_progress: 1, rated_match_count: 1 });
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(id)).toEqual({ count: 1 });
  expect(store.sqlite.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
  expect((await send('/api/health')).status).toBe(200);
  store.sqlite.prepare('UPDATE sessions SET uid = NULL WHERE id = ?').run(actor.id);
  expect((await send(`/api/matches/${id}/settlement`)).status).toBe(401);
  expect((await send(`/api/matches/${id}`)).status).toBe(200);
  expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
});

it('releases 80 orphaned reviews through the Worker adapter so new visitors can start a game', async () => {
  const { store, env, ctx } = fixture();
  const durable = new GameDurableObject(ctx, env);
  await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`));
  const now = Date.now();
  for (let index = 0; index < 80; index++) {
    const session = { id: `expired-bot-${index}`, uid: null, createdAt: now, expiresAt: now - 1 };
    store.sqlite.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(session.id, now, session.expiresAt);
    const id = createBotMatch(store.sqlite, session, 'Player', 'practice', 'easy', undefined, undefined, undefined, undefined, false);
    lockAction(store.sqlite, id, session, { type: 'pass' }, 1, getMatch(store.sqlite, id)!.revision);
  }
  const db = asDomainDatabase(new WorkerSqliteDatabase(store.storage.sql, store.storage));
  expect(pruneExpiredGuestData(db, now).abandonedMatches).toBe(80);
  expect(pruneExpiredGuestData(db, now).abandonedMatches).toBe(0);
  store.sqlite.prepare('DELETE FROM worker_usage').run();
  store.sqlite.prepare('DELETE FROM worker_daily_usage').run();
  const response = await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/bot-matches`, {
    method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-requested-with': 'override-game', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'practice', difficulty: 'easy', displayName: 'Player', creationKey: '00000000-0000-4000-8000-000000000099' }),
  }));
  expect(response.status).toBe(201);
  expect((await response.json() as { match: { status: string } }).match.status).toBe('decision');
  expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
});

it('serializes concurrent final Ranked locks and a duplicate request into one result and settlement', async () => {
  const { store, env, ctx } = fixture();
  const durable = new GameDurableObject(ctx, env);
  await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`));
  const now = Date.now();
  const tokens = ['a'.repeat(64), 'b'.repeat(64)];
  const uids = ['rank-a', 'rank-b'];
  uids.forEach((uid, index) => {
    store.sqlite.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
    store.sqlite.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionTokenId(tokens[index]), uid, now, now + 86400000);
  });
  const shell = createRankedShell(store.sqlite, ...uids as [string, string]);
  uids.forEach((uid) => markRankedReadyPresence(store.sqlite, shell.matchId, uid, true));
  uids.forEach((uid) => acknowledgeRankedReady(store.sqlite, shell.matchId, uid));
  const state = { ...createInitialState(), round: 12,
    board: createInitialState().board.map((cell, index) => index === 2 ? 'A' as const : cell) };
  store.sqlite.prepare('UPDATE matches SET state_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(state), shell.matchId);
  const revision = getMatch(store.sqlite, shell.matchId)!.revision;
  const lock = (index: number) => durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/matches/${shell.matchId}/actions`, {
    method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-requested-with': 'override-game', 'content-type': 'application/json', cookie: `override_session=${tokens[index]}` },
    body: JSON.stringify({ action: { type: 'pass' }, round: 12, revision }),
  }));
  const responses = await Promise.all([lock(0), lock(1), lock(1)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 409]);
  expect(getMatch(store.sqlite, shell.matchId)).toMatchObject({ status: 'finished', deadline: null, transition_at: null });
  await durable.alarm();
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(shell.matchId)).toEqual({ count: 1 });
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(shell.matchId)).toEqual({ count: 1 });
  expect(store.sqlite.prepare('SELECT rated_match_count FROM profiles ORDER BY uid').all()).toEqual([{ rated_match_count: 1 }, { rated_match_count: 1 }]);
});

it.each(['unrelated-room', 'same-room', 'same-match', 'room-to-match', 'other-player'] as const)(
  'checks effective socket identity for %s during disconnect debounce', async (replacement) => {
    const { store, sockets, env, ctx } = fixture();
    const durable = new GameDurableObject(ctx, env);
    await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`));
    const now = Date.now();
    const host = { id: 'host', uid: null, createdAt: now, expiresAt: now + 86_400_000 };
    const guest = { ...host, id: 'guest' };
    for (const session of [host, guest]) store.sqlite.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(session.id, now, session.expiresAt);
    const room = createQuickRoom(store.sqlite, host, 'Host');
    const joined = joinQuickRoom(store.sqlite, guest, { code: room.code }, 'Guest');
    const other = createQuickRoom(store.sqlite, host, 'Host');
    const side = getMatch(store.sqlite, joined.matchId!)!.player_a_key === host.id ? 'A' : 'B';
    markConnected(store.sqlite, joined.matchId!, side, now);
    const closed: { key: string; sessionId: string; roomId: string | null; matchId: string | null } =
      { key: host.id, sessionId: host.id, roomId: room.id, matchId: null };
    if (replacement === 'room-to-match') { closed.roomId = null; closed.matchId = joined.matchId!; }
    const current = {
      ...closed,
      key: replacement === 'other-player' ? guest.id : host.id,
      roomId: replacement === 'unrelated-room' ? other.id : replacement === 'same-match' ? null : room.id,
      matchId: replacement === 'same-match' ? joined.matchId! : null,
    };
    sockets.push({ deserializeAttachment: () => current, send() {} } as unknown as WorkerWebSocket);
    await durable.webSocketClose({ deserializeAttachment: () => closed } as unknown as WorkerWebSocket);
    await durable.alarm();
    expect(getMatch(store.sqlite, joined.matchId!)![side === 'A' ? 'disconnected_a_at' : 'disconnected_b_at']).toBeNull();
    store.sqlite.prepare('UPDATE worker_socket_closures SET due_at = ?').run(now - 1);
    await durable.alarm();
    const disconnected = getMatch(store.sqlite, joined.matchId!)![side === 'A' ? 'disconnected_a_at' : 'disconnected_b_at'];
    if (replacement === 'unrelated-room' || replacement === 'other-player') expect(disconnected).not.toBeNull();
    else expect(disconnected).toBeNull();
  },
);

it('keeps recovery available after rejected bookmarks or an alarm scheduling failure', async () => {
  const { store, env, ctx } = fixture();
  const restoreBookmark = vi.fn(async (bookmark: string) => {
    if (bookmark === 'rejected') throw new Error('Unknown bookmark');
    return 'undo';
  });
  const storage = {
    ...store.storage,
    getCurrentBookmark: async () => 'current',
    getBookmarkForTime: async () => { throw new Error('Unavailable time'); },
    onNextSessionRestoreBookmark: restoreBookmark,
  };
  const durable = new GameDurableObject({ ...ctx, storage, abort() {} }, env);
  const headers = { authorization: `Bearer ${env.RECOVERY_CONTROL_TOKEN}` };
  const restore = (body: object) => durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/__ops/recovery/restore`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  const unavailable = new GameDurableObject(ctx, env);
  expect((await unavailable.fetch(new Request(`${env.PUBLIC_ORIGIN}/__ops/recovery/restore`, {
    method: 'POST', headers, body: '{}',
  }))).status).toBe(501);
  const disabled = new GameDurableObject(ctx, { ...env, RECOVERY_CONTROL_TOKEN: undefined });
  expect((await disabled.fetch(new Request(`${env.PUBLIC_ORIGIN}/__ops/recovery/bookmark`, { method: 'POST' }))).status).toBe(404);
  expect((await restore({ bookmark: 'invalid/bookmark' })).status).toBe(400);
  expect((await restore({ bookmark: 'rejected' })).status).toBe(400);
  expect((await restore({ timestamp: Date.now() + 86_400_000 })).status).toBe(400);
  expect((await restore({ timestamp: Date.now() - 31 * 86_400_000 })).status).toBe(400);
  expect((await restore({ timestamp: Date.now() - 1_000 })).status).toBe(400);
  expect((await durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/health`))).status).toBe(200);
  storage.setAlarm = async () => { throw new Error('Alarm unavailable'); };
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await restore({ bookmark: 'valid' })).status).toBe(500);
  errorLog.mockRestore();
  expect(restoreBookmark).toHaveBeenCalledTimes(1);
  expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_recovery_control').get()).toEqual({ count: 0 });
});

it('serializes overlapping restores so only one platform restore is scheduled', async () => {
  const { env, ctx, store } = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const restoreBookmark = vi.fn(async () => { await waiting; return 'undo'; });
  let gate: Promise<unknown> = Promise.resolve();
  const serializeCalls = vi.fn();
  const serialize = <T>(callback: () => Promise<T>): Promise<T> => {
    serializeCalls();
    const operation = gate.then(callback);
    gate = operation.catch(() => {});
    return operation;
  };
  const storage = { ...store.storage, getBookmarkForTime: async () => 'prior', onNextSessionRestoreBookmark: restoreBookmark };
  const durable = new GameDurableObject({ ...ctx, blockConcurrencyWhile: serialize, storage, abort() {} }, env);
  const restore = () => durable.fetch(new Request(`${env.PUBLIC_ORIGIN}/__ops/recovery/restore`, {
    method: 'POST', headers: { authorization: `Bearer ${env.RECOVERY_CONTROL_TOKEN}` }, body: JSON.stringify({ bookmark: 'prior' }),
  }));
  const first = restore();
  await vi.waitFor(() => expect(restoreBookmark).toHaveBeenCalledOnce());
  const second = restore();
  await vi.waitFor(() => expect(serializeCalls).toHaveBeenCalledTimes(2));
  release();
  expect((await first).status).toBe(202);
  expect((await second).status).toBe(409);
  expect(restoreBookmark).toHaveBeenCalledOnce();
});

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
    blockConcurrencyWhile,
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
  const ctx = { blockConcurrencyWhile, storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
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
  const ctx = { blockConcurrencyWhile, storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
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

it('serves Firebase auth helper config as JSON on the app origin', async () => {
  const assetsFetch = vi.fn(async () => new Response('<!doctype html>app'));
  const env = {
    FIREBASE_WEB_CONFIG: JSON.stringify({ apiKey: 'test', authDomain: 'override-game.firebaseapp.com', projectId: 'override-game', appId: 'test' }),
    INVITATION_ENCRYPTION_KEY: 'worker-integration-test-key',
    GAME: { idFromName(name: string) { return name; }, get() { throw new Error('Not used by this test'); } },
    ASSETS: { fetch: assetsFetch },
  };

  const response = await worker.fetch(new Request('https://game.example/__/firebase/init.json'), env);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ apiKey: 'test', authDomain: 'game.example', projectId: 'override-game', appId: 'test' });
  expect(assetsFetch).not.toHaveBeenCalled();
});

it('protects PITR bookmarks and restores, then keeps player API paused until the Durable Object restarts', async () => {
  process.env.NODE_ENV = 'test';
  const origin = 'http://localhost:5173';
  const store = createWorkerTestStorage();
  stores.push(store);
  const restoredBookmarks: string[] = [];
  const alarms: number[] = [];
  const abort = vi.fn();
  const restartSteps: string[] = [];
  const storage = {
    ...store.storage,
    async getCurrentBookmark() { return 'bookmark-current'; },
    async getBookmarkForTime(timestamp: number) { return `bookmark-at-${timestamp}`; },
    async onNextSessionRestoreBookmark(bookmark: string) { restoredBookmarks.push(bookmark); return 'bookmark-before-restore'; },
    async setAlarm(timestamp: number) { alarms.push(timestamp); await store.storage.setAlarm(timestamp); },
    async sync() {
      expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_recovery_control').get()).toEqual({ count: 0 });
      restartSteps.push('flush');
    },
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
  const ctx = { blockConcurrencyWhile, storage, abort: (...args: unknown[]) => { restartSteps.push('abort'); abort(...args); }, acceptWebSocket() {}, getWebSockets() { return []; } };
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
  const duplicate = await durable.fetch(new Request(`${origin}/__ops/recovery/restore`, {
    method: 'POST', headers, body: JSON.stringify({ bookmark: 'bookmark-other' }),
  }));
  expect(duplicate.status).toBe(409);

  await durable.alarm();
  expect(abort).toHaveBeenCalledOnce();
  expect(abort).toHaveBeenCalledWith('Recovery restart', { retryAlarm: false });
  expect(restartSteps).toEqual(['flush', 'abort']);
  const restarted = new GameDurableObject(ctx, env);
  expect((await restarted.fetch(new Request(`${origin}/api/health`))).status).toBe(200);
  // Model an older snapshot containing the old persistent recovery intent.
  store.sqlite.prepare('INSERT INTO worker_recovery_control VALUES (1, ?, ?, ?)').run(Date.now(), 'prior', 'undo');
  const legacy = new GameDurableObject(ctx, env);
  await Promise.resolve();
  expect(alarms).toHaveLength(2);
  expect((await legacy.fetch(new Request(`${origin}/api/health`))).status).toBe(503);
  await legacy.alarm();
  const afterUndo = new GameDurableObject(ctx, env);
  expect((await afterUndo.fetch(new Request(`${origin}/api/health`))).status).toBe(200);
  expect(abort).toHaveBeenCalledTimes(2);
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
  const ctx = { blockConcurrencyWhile, storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
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
  await durable.alarm();
  expect(store.sqlite.prepare('SELECT status, deadline, transition_at FROM matches WHERE id = ?').get(match.id))
    .toEqual({ status: 'review', deadline: null, transition_at: null });
  const next = await worker.fetch(new Request(`${origin}/api/matches/${match.id}/next`, {
    method: 'POST', headers, body: JSON.stringify({ round: 1, revision: match.revision, acknowledgementKey: '44444444-4444-4444-8444-444444444444' }),
  }), env);
  expect(next.status).toBe(200);
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
  const ctx = { blockConcurrencyWhile, storage: store.storage, acceptWebSocket() {}, getWebSockets() { return []; } };
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
