import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createApiHandler } from './api.js';
import { publicOrigin } from './config.js';
import { sessionTokenId } from './invitation-secrets.js';
import { createQuickRoom, joinQuickRoom } from './rooms.js';
import { resignMatch } from './matches.js';
import { createRankedChallenge, acceptRankedChallenge } from './invitations.js';
import { acknowledgeRankedReady, markRankedReadyPresence, settleRankedMatch } from './ranked.js';
import { initializeDatabase } from './schema-initializer.js';
import { WorkerSqliteDatabase, asDomainDatabase } from './worker-sqlite.js';
import { createWorkerTestStorage } from './worker-test-storage.js';

const stores: ReturnType<typeof createWorkerTestStorage>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.sqlite.close(); });

function fixture() {
  const store = createWorkerTestStorage();
  stores.push(store);
  const db = asDomainDatabase(new WorkerSqliteDatabase(store.storage.sql, store.storage));
  initializeDatabase(db, { workerBaseline: true });
  const now = Date.now();
  const callers = ['a', 'b', 'c'].map((uid) => {
    const token = uid.repeat(64);
    const session = { id: sessionTokenId(token), uid, createdAt: now, expiresAt: now + 86_400_000 };
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
    db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)').run(session.id, uid, now, session.expiresAt);
    return { token, session };
  });
  let admitted = true;
  const handler = createApiHandler({ db, publicOrigin, allowNewGame: () => admitted,
    logMatchEvent() {}, notifyRoom() {}, notifyMatch() {}, connectLiveParticipants() {} });
  async function call(path: string, caller = callers[0], body: object = {}, method = 'POST') {
    let status = 0;
    let data: unknown;
    const response = { setHeader() {}, writeHead(value: number) { status = value; },
      end(value: string) { data = JSON.parse(value); } } as unknown as ServerResponse;
    const request = { url: `${publicOrigin}${path}`, method,
      headers: { origin: publicOrigin, 'x-requested-with': 'override-game', cookie: `override_session=${caller.token}` },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
    } as unknown as IncomingMessage;
    await handler(request, response);
    return { status, data };
  }
  return { db, callers, call, capacity(value: boolean) { admitted = value; } };
}

it('rejects new rooms, joins and bots at capacity while creation and join retries resume', async () => {
  const { db, callers, call, capacity } = fixture();
  const roomKey = '11111111-1111-4111-8111-111111111111';
  const botKey = '22222222-2222-4222-8222-222222222222';
  const room = createQuickRoom(db, callers[0].session, 'Host', roomKey);
  const joined = joinQuickRoom(db, callers[1].session, { code: room.code }, 'Guest');
  const open = createQuickRoom(db, callers[0].session, 'Host');
  const botBody = { displayName: 'Host', mode: 'practice', creationKey: botKey };
  expect((await call('/api/bot-matches', callers[0], botBody)).status).toBe(201);
  capacity(false);
  expect((await call('/api/rooms', callers[0], { displayName: 'Host', creationKey: roomKey })).status).toBe(201);
  expect((await call('/api/bot-matches', callers[0], botBody)).status).toBe(201);
  expect((await call('/api/rooms/join', callers[1], { displayName: 'Guest', code: room.code })).status).toBe(200);
  const newKey = '33333333-3333-4333-8333-333333333333';
  expect((await call('/api/rooms', callers[0], { displayName: 'Host', creationKey: newKey })).status).toBe(503);
  expect((await call('/api/bot-matches', callers[0], { displayName: 'Host', creationKey: newKey })).status).toBe(503);
  expect((await call('/api/rooms/join', callers[2], { displayName: 'Other', code: open.code })).status).toBe(503);
  expect((await call('/api/rooms/join', callers[2], { displayName: 'Other', code: 'INVALID' })).status).toBe(404);
  expect(db.prepare('SELECT COUNT(*) AS count FROM matches').get()).toEqual({ count: 2 });
  expect(db.prepare('SELECT match_id FROM rooms WHERE id = ?').get(room.id)).toEqual({ match_id: joined.matchId });
});

it('guards both Quick rematch acceptance routes and permits existing offers and accepted retries', async () => {
  const { db, callers, call, capacity } = fixture();
  const room = createQuickRoom(db, callers[0].session, 'Host');
  const joined = joinQuickRoom(db, callers[1].session, { code: room.code }, 'Guest');
  resignMatch(db, joined.matchId!, callers[0].session);
  const offerPath = `/api/matches/${joined.matchId}/rematch`;
  capacity(false);
  expect((await call(offerPath)).status).toBe(503);
  capacity(true);
  const offer = await call(offerPath);
  expect(offer.status).toBe(201);
  const { invitation } = offer.data as { invitation: { token: string } };
  capacity(false);
  expect((await call(offerPath)).data).toEqual(offer.data);
  const paths = ['/api/quick/rematches/accept', `${offerPath}/accept`];
  for (const path of paths) expect((await call(path, callers[1], { token: invitation.token })).status).toBe(503);
  capacity(true);
  const accepted = await call(paths[0], callers[1], { token: invitation.token });
  expect(accepted.status).toBe(200);
  capacity(false);
  for (const path of paths) {
    const retry = await call(path, callers[1], { token: invitation.token });
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ match: { id: (accepted.data as { match: { id: string } }).match.id, status: 'decision' } });
  }
  expect(db.prepare('SELECT COUNT(*) AS count FROM matches').get()).toEqual({ count: 2 });
});

it('guards new Ranked challenges and both redemptions but resumes accepted challenges', async () => {
  const { db, callers, call, capacity } = fixture();
  capacity(false);
  expect((await call('/api/ranked/challenges')).status).toBe(503);
  capacity(true);
  const created = await call('/api/ranked/challenges');
  expect(created.status).toBe(201);
  const { invitation } = created.data as { invitation: { token: string; code: string } };
  capacity(false);
  expect((await call('/api/ranked/challenges')).data).toEqual(created.data);
  const redemptions = [
    { path: '/api/ranked/challenges/accept', body: { token: invitation.token } },
    { path: '/api/ranked/challenges/accept-code', body: { code: invitation.code } },
  ];
  for (const { path, body } of redemptions) expect((await call(path, callers[1], body)).status).toBe(503);
  capacity(true);
  const accepted = await call(redemptions[0].path, callers[1], redemptions[0].body);
  expect(accepted.status).toBe(200);
  capacity(false);
  for (const { path, body } of redemptions) {
    const retry = await call(path, callers[1], body);
    expect(retry.status).toBe(200);
    expect(retry.data).toEqual(accepted.data);
  }
  expect(db.prepare('SELECT COUNT(*) AS count FROM matches').get()).toEqual({ count: 1 });
});

it('guards Ranked rematch offers and shells while accepted shell retries remain available', async () => {
  const { db, callers, call, capacity } = fixture();
  const challenge = createRankedChallenge(db, 'a');
  const shell = acceptRankedChallenge(db, challenge.token, 'b');
  for (const uid of ['a', 'b']) markRankedReadyPresence(db, shell.matchId, uid, true);
  for (const uid of ['a', 'b']) acknowledgeRankedReady(db, shell.matchId, uid);
  resignMatch(db, shell.matchId, callers[0].session);
  settleRankedMatch(db, shell.matchId);
  const offerPath = `/api/ranked/matches/${shell.matchId}/rematch`;
  capacity(false);
  expect((await call(offerPath)).status).toBe(503);
  capacity(true);
  const offer = await call(offerPath);
  expect(offer.status).toBe(201);
  const { invitation } = offer.data as { invitation: { token: string } };
  capacity(false);
  expect((await call(offerPath)).data).toEqual(offer.data);
  const accept = () => call('/api/ranked/rematches/accept', callers[1], { token: invitation.token });
  expect((await accept()).status).toBe(503);
  capacity(true);
  const accepted = await accept();
  expect(accepted.status).toBe(200);
  capacity(false);
  expect(await accept()).toEqual(accepted);
  expect(db.prepare('SELECT COUNT(*) AS count FROM matches').get()).toEqual({ count: 2 });
});

it('blocks new queue leases but lets admitted leases refresh, pair, and resume at capacity', async () => {
  const { db, callers, call, capacity } = fixture();
  expect((await call('/api/ranked/queue')).data).toMatchObject({ queue: { state: 'searching' } });
  capacity(false);
  expect((await call('/api/ranked/queue')).status).toBe(200);
  expect((await call('/api/ranked/queue', callers[1])).status).toBe(503);
  // A second lease was admitted before the cap: polling must still pair both.
  db.prepare("INSERT INTO ranked_ownership (uid, state, lease_expires_at) VALUES ('b', 'searching', ?)").run(Date.now() + 60_000);
  db.prepare("INSERT INTO ranked_queue (uid, joined_at, rating) VALUES ('b', ?, 1000)").run(Date.now());
  expect((await call('/api/ranked/queue', callers[0], {}, 'GET')).data).toMatchObject({ queue: { state: 'readying' } });
  for (const caller of callers.slice(0, 2)) expect((await call('/api/ranked/queue', caller)).status).toBe(200);
  expect((await call('/api/ranked/queue', callers[2])).status).toBe(503);
  expect(db.prepare('SELECT COUNT(*) AS count FROM matches').get()).toEqual({ count: 1 });
});
