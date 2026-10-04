import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { openDatabase } from './db.js';
import { HttpError } from './http.js';
import {
  attachFirebaseIdentity,
  claimHandle,
  getPublicProfile,
  renameHandle,
  validateHandle,
  verifyFirebaseIdToken,
} from './auth.js';

const dbs: ReturnType<typeof openDatabase>[] = [];
const db = () => {
  const value = openDatabase(':memory:');
  dbs.push(value);
  return value;
};

afterEach(() => {
  for (const value of dbs.splice(0)) value.close();
});

function assertHttpError(error: unknown, status: number): void {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
}

test('handle syntax, length, character set, and basic profanity are enforced', () => {
  assert.deepEqual(validateHandle('Override_7'), { handle: 'Override_7', normalizedHandle: 'override_7' });
  for (const value of ['ab', 'a'.repeat(17), 'bad handle', 'éclair', 'fuckyou']) {
    assert.throws(() => validateHandle(value), (error) => {
      assertHttpError(error, 400);
      return true;
    });
  }
});

test('handle claims are case-insensitive and reservation is atomic', () => {
  const database = db();
  database.prepare('INSERT INTO profiles (uid, created_at) VALUES (?, ?)').run('u1', 1);
  database.prepare('INSERT INTO profiles (uid, created_at) VALUES (?, ?)').run('u2', 1);
  assert.equal(claimHandle(database, 'u1', 'Mitch', 10).handle, 'Mitch');
  assert.throws(() => claimHandle(database, 'u2', 'mItCh', 11), (error) => {
    assertHttpError(error, 409);
    return true;
  });
  assert.equal(getPublicProfile(database, 'u2')?.handle, null);
});

test('first rename is allowed immediately; subsequent renames observe exact 30-day boundary', () => {
  const database = db();
  database.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('u1', 'First', 'first', 1);
  const now = 1_000_000;
  assert.equal(renameHandle(database, 'u1', 'Second', now).handle, 'Second');
  assert.throws(() => renameHandle(database, 'u1', 'Third', now + 30 * 24 * 60 * 60 * 1000 - 1), (error) => {
    assertHttpError(error, 429);
    return true;
  });
  assert.equal(renameHandle(database, 'u1', 'Third', now + 30 * 24 * 60 * 60 * 1000).handle, 'Third');
});

test('rename uniqueness failure leaves original handle unchanged', () => {
  const database = db();
  database.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('u1', 'One', 'one', 1);
  database.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('u2', 'Two', 'two', 1);
  assert.throws(() => renameHandle(database, 'u1', 'TWO', 100), (error) => {
    assertHttpError(error, 409);
    return true;
  });
  assert.equal(getPublicProfile(database, 'u1')?.handle, 'One');
});

test('public profile omits UID, email, and internal rename metadata', () => {
  const database = db();
  database.prepare(`INSERT INTO profiles (uid, handle, normalized_handle, rating, peak_rating, placement_progress,
    rated_match_count, wins, losses, draws, streak, renamed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('secret-uid', 'Player_1', 'player_1', 1234, 1300, 5, 21, 7, 2, 1, 3, 42, 10);
  assert.deepEqual(getPublicProfile(database, 'secret-uid'), {
    handle: 'Player_1', rating: 1234, peakRating: 1300, placementProgress: 5,
    ratedMatchCount: 21, wins: 7, losses: 2, draws: 1, streak: 3,
  });

  database.prepare(`INSERT INTO profiles (uid, handle, normalized_handle, rating, peak_rating, placement_progress,
    rated_match_count, wins, losses, draws, streak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('placing-uid', 'Placing', 'placing', 1188, 1210, 4, 4, 2, 1, 1, 1, 10);
  assert.deepEqual(getPublicProfile(database, 'placing-uid'), {
    handle: 'Placing', placementProgress: 4,
  });
});

test('Firebase ID tokens require Google provider and bind verified UID to game session', async () => {
  const verifiedGoogle = async () => ({ uid: 'firebase-uid', firebase: { sign_in_provider: 'google.com' } });
  assert.deepEqual(await verifyFirebaseIdToken('valid-token', verifiedGoogle), { uid: 'firebase-uid' });
  await assert.rejects(verifyFirebaseIdToken('valid-token', async () => ({ uid: 'email-uid', firebase: { sign_in_provider: 'password' } })), (error) => {
    assertHttpError(error, 401);
    return true;
  });
  await assert.rejects(verifyFirebaseIdToken('', verifiedGoogle), (error) => {
    assertHttpError(error, 400);
    return true;
  });

  const database = db();
  const sessionId = 's'.repeat(64);
  const now = Date.now();
  database.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)').run(sessionId, now, now + 60_000);
  assert.deepEqual(await attachFirebaseIdentity(database, sessionId, 'valid-token', now, verifiedGoogle), { uid: 'firebase-uid' });
  assert.equal((database.prepare('SELECT uid FROM sessions WHERE id = ?').get(sessionId) as { uid: string }).uid, 'firebase-uid');
  assert.equal(getPublicProfile(database, 'firebase-uid')?.handle, null);
  await assert.rejects(attachFirebaseIdentity(database, sessionId, 'valid-token', now, verifiedGoogle), (error) => {
    assertHttpError(error, 409);
    return true;
  });
});
