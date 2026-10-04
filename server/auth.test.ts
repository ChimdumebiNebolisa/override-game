import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { openDatabase } from './db.js';
import { HttpError } from './http.js';
import {
  attachGoogleIdentity,
  claimHandle,
  getPublicProfile,
  issueGoogleNonce,
  renameHandle,
  validateHandle,
  verifyGoogleIdToken,
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

test('Google ID token verifies signature, issuer, audience, expiry, and subject before session attachment', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const exported = await exportJWK(publicKey);
  const localJwks = createLocalJWKSet({ keys: [{ ...exported, kid: 'test-key', alg: 'RS256' } as JWK] });
  const now = Math.floor(Date.now() / 1000);
  const sign = (subject: string, audience = 'client-id', issuer = 'https://accounts.google.com', expiry = now + 300, nonce?: string) =>
    new SignJWT({ email: 'private@example.com', ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(expiry)
      .sign(privateKey);

  const token = await sign('google-uid');
  assert.deepEqual(await verifyGoogleIdToken(token, { clientId: 'client-id', keySet: localJwks }), { uid: 'google-uid' });
  await assert.rejects(verifyGoogleIdToken(token, { clientId: 'other-client', keySet: localJwks }), (error) => {
    assertHttpError(error, 401);
    return true;
  });
  await assert.rejects(verifyGoogleIdToken(await sign('u', 'client-id', 'https://attacker.invalid'), {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 401);
    return true;
  });
  await assert.rejects(verifyGoogleIdToken(await sign('u', 'client-id', 'https://accounts.google.com', now - 1), {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 401);
    return true;
  });

  const database = db();
  const sessionId = 's'.repeat(64);
  database.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(sessionId, Date.now(), Date.now() + 60_000);
  const challengeTime = Date.now();
  const nonce = issueGoogleNonce(database, sessionId, challengeTime);
  const sessionToken = await sign('google-uid', 'client-id', 'https://accounts.google.com', now + 300, nonce);
  await assert.rejects(attachGoogleIdentity(database, sessionId,
    await sign('google-uid', 'client-id', 'https://accounts.google.com', now + 300, 'wrong-nonce'), challengeTime, {
      clientId: 'client-id', keySet: localJwks,
    }), (error) => {
    assertHttpError(error, 401);
    return true;
  });
  assert.equal((database.prepare('SELECT uid FROM sessions WHERE id = ?').get(sessionId) as { uid: string | null }).uid, null);

  const otherSessionId = 'y'.repeat(64);
  database.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(otherSessionId, challengeTime, challengeTime + 600_000);
  issueGoogleNonce(database, otherSessionId, challengeTime);
  await assert.rejects(attachGoogleIdentity(database, otherSessionId, sessionToken, challengeTime, {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 401);
    return true;
  });
  assert.equal((database.prepare('SELECT uid FROM sessions WHERE id = ?').get(otherSessionId) as { uid: string | null }).uid, null);

  const expiredSessionId = 'z'.repeat(64);
  database.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(expiredSessionId, challengeTime, challengeTime + 600_000);
  issueGoogleNonce(database, expiredSessionId, challengeTime);
  await assert.rejects(attachGoogleIdentity(database, expiredSessionId, sessionToken, challengeTime + 300_000, {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 401);
    return true;
  });

  assert.deepEqual(await attachGoogleIdentity(database, sessionId, sessionToken, challengeTime, {
    clientId: 'client-id', keySet: localJwks,
  }), { uid: 'google-uid' });
  assert.equal((database.prepare('SELECT uid FROM sessions WHERE id = ?').get(sessionId) as { uid: string }).uid, 'google-uid');
  assert.equal(getPublicProfile(database, 'google-uid')?.handle, null);
  await assert.rejects(attachGoogleIdentity(database, sessionId, sessionToken, challengeTime, {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 409);
    return true;
  });

  const invalidSessionId = 'x'.repeat(64);
  await assert.rejects(attachGoogleIdentity(database, invalidSessionId, token, Date.now(), {
    clientId: 'client-id', keySet: localJwks,
  }), (error) => {
    assertHttpError(error, 401);
    return true;
  });
});
