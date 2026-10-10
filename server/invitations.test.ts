import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { afterEach, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { invitationTokenHash, revealInvitationSecret } from './invitation-secrets.js';
import { HttpError } from './http.js';
import { acknowledgeRankedReady, createRankedShell, markRankedReadyPresence, settleRankedMatch } from './ranked.js';
import {
  acceptRankedChallenge,
  acceptRankedChallengeByCode,
  acceptRankedRematch,
  createRankedChallenge,
  expireRankedInvitations,
  pendingRankedChallenge,
  pendingRankedRematch,
  rankedRematchLifetimeMs,
  requestRankedRematch,
} from './invitations.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const tempDirectories: string[] = [];
const makeDb = () => {
  const db = openDatabase(':memory:');
  databases.push(db);
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('a', 'Alpha', 'alpha', 1);
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('b', 'Bravo', 'bravo', 1);
  return db;
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of tempDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error; }
  }
});

function row<T>(db: ReturnType<typeof openDatabase>, sql: string, ...values: unknown[]): T {
  return db.prepare(sql).get(...values) as T;
}

function assertHttpError(error: unknown, status: number): void {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
}

function makeSettledMatch(db: ReturnType<typeof openDatabase>, now: number) {
  const shell = createRankedShell(db, 'a', 'b', now);
  const players = row<{ player_a_key: string; player_b_key: string }>(db,
    'SELECT player_a_key, player_b_key FROM matches WHERE id = ?', shell.matchId);
  markRankedReadyPresence(db, shell.matchId, players.player_a_key, true);
  markRankedReadyPresence(db, shell.matchId, players.player_b_key, true);
  acknowledgeRankedReady(db, shell.matchId, players.player_a_key, now + 1);
  acknowledgeRankedReady(db, shell.matchId, players.player_b_key, now + 2);
  const match = row<{ state_json: string; player_a_key: string; player_b_key: string }>(db,
    'SELECT state_json, player_a_key, player_b_key FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = 'A';
  state.endingReason = 'standard';
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, result_type = 'standard'
    WHERE id = ?`).run(JSON.stringify(state), now + 10_000, shell.matchId);
  settleRankedMatch(db, shell.matchId, now + 10_001);
  return { id: shell.matchId, playerA: match.player_a_key, playerB: match.player_b_key };
}

test('challenge token is high entropy, private, expiring, and redeems once into a ready shell', () => {
  const db = makeDb();
  const now = 1_000_000;
  const invite = createRankedChallenge(db, 'a', now);
  const stored = row<{ token: string; token_hash: string; code: string; code_hash: string }>(db,
    'SELECT token, token_hash, code, code_hash FROM ranked_invitations WHERE id = ?', invite.id);
  assert.notEqual(stored.token, invite.token);
  assert.equal(stored.token_hash, invitationTokenHash(invite.token));
  assert.equal(revealInvitationSecret(stored.token), invite.token);
  assert.notEqual(stored.code, invite.code);
  assert.equal(stored.code_hash, invitationTokenHash(invite.code ?? ''));
  assert.equal(revealInvitationSecret(stored.code), invite.code);
  assert.equal(invite.kind, 'challenge');
  assert.match(invite.code ?? '', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  assert.equal(Buffer.from(invite.token, 'base64url').length, 32);
  assert.equal(invite.expiresAt, now + 30 * 60_000);
  assert.ok(invite.inviteUrl.endsWith(`/ranked/challenge/${invite.token}`));
  assert.deepEqual(pendingRankedChallenge(db, 'a', now + 1), invite);
  assert.deepEqual(createRankedChallenge(db, 'a', now + 1), invite);
  assert.equal(pendingRankedChallenge(db, 'b', now + 1), null);
  assert.throws(() => acceptRankedChallenge(db, invite.token, 'a', now + 1), (error) => {
    assertHttpError(error, 400);
    return true;
  });

  const splitCode = `${invite.code?.slice(0, 5)}-${invite.code?.slice(5)}`.toLowerCase();
  const accepted = acceptRankedChallengeByCode(db, splitCode, 'b', now + 2);
  assert.equal(pendingRankedChallenge(db, 'a', now + 3), null);
  assert.equal(accepted.competitiveMultiplier, 1);
  assert.equal(accepted.readyDeadline, now + 2 + 15_000);
  assert.deepEqual(acceptRankedChallenge(db, invite.token, 'b', now + 3), accepted);
  assert.deepEqual(acceptRankedChallengeByCode(db, splitCode, 'b', now + 3), accepted);
  assert.throws(() => acceptRankedChallenge(db, invite.token, 'a', now + 3), (error) => {
    assertHttpError(error, 410);
    return true;
  });
});

test('challenge code attempts are rate limited and the window resets', () => {
  const db = makeDb();
  const now = 1_500_000;
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.throws(() => acceptRankedChallengeByCode(db, 'AAAAAAAAAA', 'b', now), (error) => {
      assertHttpError(error, 404);
      return true;
    });
  }
  assert.throws(() => acceptRankedChallengeByCode(db, 'AAAAAAAAAA', 'b', now + 1), (error) => {
    assertHttpError(error, 429);
    return true;
  });
  const invite = createRankedChallenge(db, 'a', now + 61_000);
  assert.doesNotThrow(() => acceptRankedChallengeByCode(db, invite.code ?? '', 'b', now + 61_001));
});

test('challenge expiry is enforced and cleanup marks expired links', () => {
  const db = makeDb();
  const invite = createRankedChallenge(db, 'a', 2_000_000);
  assert.equal(expireRankedInvitations(db, invite.expiresAt), 1);
  assert.throws(() => acceptRankedChallenge(db, invite.token, 'b', invite.expiresAt), (error) => {
    assertHttpError(error, 410);
    return true;
  });
  assert.throws(() => acceptRankedChallengeByCode(db, invite.code ?? '', 'b', invite.expiresAt), (error) => {
    assertHttpError(error, 410);
    return true;
  });
});

test('link and code competitors can create only one Ranked shell', () => {
  const db = makeDb();
  const now = 2_500_000;
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('c', 'Charlie', 'charlie', now);
  const invite = createRankedChallenge(db, 'a', now);
  const accepted = acceptRankedChallenge(db, invite.token, 'b', now + 1);
  assert.throws(() => acceptRankedChallengeByCode(db, invite.code ?? '', 'c', now + 2), (error) => {
    assertHttpError(error, 410);
    return true;
  });
  assert.equal(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM matches WHERE mode = 'ranked'").count, 1);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership').count, 2);
  assert.deepEqual(acceptRankedChallenge(db, invite.token, 'b', now + 3), accepted);
});

test('concurrent link and code redemption across workers creates one shell', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'override-invite-race-'));
  tempDirectories.push(directory);
  const path = join(directory, 'race.sqlite');
  try {
    const db = openDatabase(path);
    const now = 2_750_000;
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
      .run('a', 'Alpha', 'alpha', now);
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
      .run('b', 'Bravo', 'bravo', now);
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
      .run('c', 'Charlie', 'charlie', now);
    const invite = createRankedChallenge(db, 'a', now);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();

    const race = (method: 'token' | 'code', value: string, uid: string) => new Promise<{ ok: boolean; matchId?: string; status?: number | null }>((resolve, reject) => {
      const worker = new Worker(new URL('./invitation-race.worker.ts', import.meta.url), {
        workerData: { path, method, value, uid, now: now + 1 },
        execArgv: ['--import', 'tsx'],
      });
      let result: { ok: boolean; matchId?: string; status?: number | null } | null = null;
      let exited = false;
      const finish = () => { if (exited && result) resolve(result); };
      worker.once('message', (message) => { result = message; finish(); });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Race worker exited with ${code}`));
        else { exited = true; finish(); }
      });
    });
    const results = await Promise.all([
      race('token', invite.token, 'b'),
      race('code', invite.code ?? '', 'c'),
    ]);
    const check = openDatabase(path);
    try {
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(results.filter((result) => result.status === 410).length, 1);
      assert.equal(row<{ count: number }>(check, "SELECT COUNT(*) AS count FROM matches WHERE mode = 'ranked'").count, 1);
      assert.equal(row<{ count: number }>(check, 'SELECT COUNT(*) AS count FROM ranked_ownership').count, 2);
    } finally {
      check.pragma('wal_checkpoint(TRUNCATE)');
      check.pragma('journal_mode = DELETE');
      check.close();
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test('rematch invitation expires after 30 seconds and can be accepted only by the opponent', () => {
  const db = makeDb();
  const previous = makeSettledMatch(db, 3_000_000);
  const invite = requestRankedRematch(db, previous.id, previous.playerA, 3_020_000);
  assert.equal(invite.kind, 'rematch');
  assert.ok(invite.inviteUrl.endsWith(`/ranked/rematch/${invite.token}`));
  assert.equal(invite.expiresAt, 3_020_000 + rankedRematchLifetimeMs());
  assert.throws(() => acceptRankedRematch(db, invite.token, previous.playerA, 3_020_001), (error) => {
    assertHttpError(error, 404);
    return true;
  });
  assert.equal(expireRankedInvitations(db, invite.expiresAt), 1);
  assert.throws(() => acceptRankedRematch(db, invite.token, previous.playerB, invite.expiresAt), (error) => {
    assertHttpError(error, 410);
    return true;
  });
});

test('accepted rematch creates a fresh shell with sides swapped and fresh credit assessment', () => {
  const db = makeDb();
  db.prepare('UPDATE profiles SET placement_progress = 2, rated_match_count = 2 WHERE uid IN (?, ?)').run('a', 'b');
  const previous = makeSettledMatch(db, 4_000_000);
  const invite = requestRankedRematch(db, previous.id, previous.playerA, 4_020_000);
  const accepted = acceptRankedRematch(db, invite.token, previous.playerB, 4_020_001);
  const rematch = row<{ player_a_key: string; player_b_key: string; started_at: number | null; credit_assessed_at: number; competitive_multiplier: number }>(
    db, 'SELECT player_a_key, player_b_key, started_at, credit_assessed_at, competitive_multiplier FROM matches WHERE id = ?', accepted.matchId);
  assert.equal(rematch.player_a_key, previous.playerB);
  assert.equal(rematch.player_b_key, previous.playerA);
  assert.equal(rematch.started_at, null);
  assert.equal(rematch.credit_assessed_at, 4_020_001);
  assert.equal(rematch.competitive_multiplier, 1);
  assert.deepEqual(acceptRankedRematch(db, invite.token, previous.playerB, 4_020_002), accepted);
});

test('only one open rematch invitation exists per completed match', () => {
  const db = makeDb();
  const previous = makeSettledMatch(db, 5_000_000);
  const first = requestRankedRematch(db, previous.id, previous.playerA, 5_020_000);
  const retry = requestRankedRematch(db, previous.id, previous.playerA, 5_020_001);
  const responseFromInvitee = requestRankedRematch(db, previous.id, previous.playerB, 5_020_002);
  assert.equal(retry.token, first.token);
  assert.equal(responseFromInvitee.token, first.token);
});

test('pending rematch lookup is participant-only and hides expired invitations', () => {
  const db = makeDb();
  const previous = makeSettledMatch(db, 5_500_000);
  const invite = requestRankedRematch(db, previous.id, previous.playerA, 5_520_000);
  assert.equal(pendingRankedRematch(db, previous.id, previous.playerA, 5_520_001)?.token, invite.token);
  assert.equal(pendingRankedRematch(db, previous.id, previous.playerB, 5_520_001)?.token, invite.token);
  assert.throws(() => pendingRankedRematch(db, previous.id, 'intruder', 5_520_001), (error) => {
    assertHttpError(error, 404);
    return true;
  });
  assert.equal(pendingRankedRematch(db, previous.id, previous.playerB, invite.expiresAt), null);
});

test('expired and unbound matches cannot issue a rematch', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 6_000_000);
  const players = row<{ player_a_key: string }>(db, 'SELECT player_a_key FROM matches WHERE id = ?', shell.matchId);
  assert.throws(() => requestRankedRematch(db, shell.matchId, players.player_a_key, 6_000_001), (error) => {
    assertHttpError(error, 409);
    return true;
  });
});
