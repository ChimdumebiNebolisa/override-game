import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { openDatabase } from './db.js';
import { HttpError } from './http.js';
import { createInitialState } from '../src/shared/rules.js';
import {
  acceptQuickRematch,
  expireQuickRematches,
  pendingQuickRematch,
  quickRematchOfferLifetimeMs,
  requestQuickRematch,
} from './quick-rematch.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const makeDb = () => {
  const db = openDatabase(':memory:');
  databases.push(db);
  return db;
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function row<T>(db: ReturnType<typeof openDatabase>, sql: string, ...values: unknown[]): T {
  return db.prepare(sql).get(...values) as T;
}

function assertHttpError(error: unknown, status: number): void {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
}

function completedQuickRoom(db: ReturnType<typeof openDatabase>, now: number) {
  const sessionA = 'a'.repeat(64);
  const sessionB = 'b'.repeat(64);
  const roomId = 'room-1';
  const matchId = 'match-1';
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?), (?, ?, ?)')
    .run(sessionA, now - 1000, now + 86_400_000, sessionB, now - 1000, now + 86_400_000);
  db.prepare(`INSERT INTO rooms (id, code, invite_token, mode, host_key, guest_key, host_name, guest_name,
      status, match_id, created_at, expires_at) VALUES (?, ?, ?, 'quick', ?, ?, ?, ?, 'finished', ?, ?, ?)`)
    .run(roomId, 'CODE22', 'room-token', sessionA, sessionB, 'Host', 'Guest', matchId, now - 10_000, now + 1_000_000);
  const finished = { ...createInitialState(), status: 'finished' as const, winner: 'A' as const, endingReason: 'standard' as const };
  db.prepare(`INSERT INTO matches (id, room_id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at, ended_at, result_type)
    VALUES (?, ?, 'quick', ?, ?, ?, ?, ?, 'finished', ?, ?, 'standard')`)
    .run(matchId, roomId, sessionA, sessionB, 'Host', 'Guest', JSON.stringify(finished), now - 9_000, now);
  return { roomId, matchId, sessionA, sessionB };
}

test('request offer is participant-only, private, idempotent, and expires in 30 seconds', () => {
  const db = makeDb();
  const now = 1_000_000;
  const match = completedQuickRoom(db, now);
  const offer = requestQuickRematch(db, match.matchId, match.sessionA, now);
  assert.equal(Buffer.from(offer.token, 'base64url').length, 32);
  assert.equal(offer.expiresAt, now + quickRematchOfferLifetimeMs());
  assert.ok(offer.inviteUrl.endsWith(`/quick/rematch/${offer.token}`));
  assert.equal(requestQuickRematch(db, match.matchId, match.sessionB, now + 1).token, offer.token);
  assert.equal(pendingQuickRematch(db, match.matchId, match.sessionA, now + 2)?.token, offer.token);
  assert.equal(pendingQuickRematch(db, match.matchId, match.sessionB, now + 2)?.token, offer.token);

  const intruder = 'c'.repeat(64);
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(intruder, now - 1, now + 1000);
  assert.throws(() => requestQuickRematch(db, match.matchId, intruder, now + 3), (error) => {
    assertHttpError(error, 404);
    return true;
  });
  assert.throws(() => pendingQuickRematch(db, match.matchId, intruder, now + 3), (error) => {
    assertHttpError(error, 404);
    return true;
  });
});

test('opponent acceptance starts one authoritative fresh match with sides swapped and updates the room', () => {
  const db = makeDb();
  const now = 2_000_000;
  const prior = completedQuickRoom(db, now);
  const offer = requestQuickRematch(db, prior.matchId, prior.sessionA, now + 1);
  const accepted = acceptQuickRematch(db, offer.token, prior.sessionB, now + 2);
  const created = row<{
    id: string; room_id: string; player_a_key: string; player_b_key: string;
    player_a_name: string; player_b_name: string; state_json: string; status: string;
    started_at: number; deadline: number; revision: number;
  }>(db, 'SELECT * FROM matches WHERE id = ?', accepted.matchId);
  assert.notEqual(created.id, prior.matchId);
  assert.equal(created.room_id, prior.roomId);
  assert.equal(created.player_a_key, prior.sessionB);
  assert.equal(created.player_b_key, prior.sessionA);
  assert.deepEqual([created.player_a_name, created.player_b_name], ['Guest', 'Host']);
  assert.equal(created.status, 'decision');
  assert.equal(created.started_at, now + 2);
  assert.equal(created.deadline, now + 2 + 5_000);
  assert.equal(created.revision, 1);
  assert.deepEqual(JSON.parse(created.state_json), createInitialState());

  assert.deepEqual(row<{ match_id: string; status: string }>(db,
    'SELECT match_id, status FROM rooms WHERE id = ?', prior.roomId), { match_id: accepted.matchId, status: 'active' });
  const acceptedOffer = pendingQuickRematch(db, prior.matchId, prior.sessionA, now + 3);
  assert.equal(acceptedOffer?.status, 'accepted');
  assert.equal(acceptedOffer?.newMatchId, accepted.matchId);
  assert.deepEqual(acceptQuickRematch(db, offer.token, prior.sessionB, now + 3), accepted);
  assert.equal(row<{ count: number }>(db,
    'SELECT COUNT(*) AS count FROM matches WHERE room_id = ?', prior.roomId).count, 2);
});

test('only the invited opponent may accept and an expired offer cannot start a match', () => {
  const db = makeDb();
  const now = 3_000_000;
  const prior = completedQuickRoom(db, now);
  const offer = requestQuickRematch(db, prior.matchId, prior.sessionA, now);
  assert.throws(() => acceptQuickRematch(db, offer.token, prior.sessionA, now + 1), (error) => {
    assertHttpError(error, 404);
    return true;
  });
  assert.equal(expireQuickRematches(db, offer.expiresAt), 1);
  assert.equal(pendingQuickRematch(db, prior.matchId, prior.sessionB, offer.expiresAt), null);
  assert.throws(() => acceptQuickRematch(db, offer.token, prior.sessionB, offer.expiresAt), (error) => {
    assertHttpError(error, 410);
    return true;
  });
  assert.equal(row<{ count: number }>(db,
    'SELECT COUNT(*) AS count FROM matches WHERE room_id = ?', prior.roomId).count, 1);
});

test('bot, unbound, and stale room matches cannot create Quick friend rematch offers', () => {
  const db = makeDb();
  const now = 4_000_000;
  const match = completedQuickRoom(db, now);
  db.prepare("UPDATE rooms SET status = 'active' WHERE id = ?").run(match.roomId);
  assert.throws(() => requestQuickRematch(db, match.matchId, match.sessionA, now + 1), (error) => {
    assertHttpError(error, 409);
    return true;
  });
});
