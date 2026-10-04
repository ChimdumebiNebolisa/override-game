import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { openDatabase } from './db.js';
import { HttpError } from './http.js';
import { dueMatches, markConnected, resignMatch, resolveMatch } from './matches.js';
import {
  acknowledgeRankedReady,
  clearRankedReadyPresenceOnStartup,
  createRankedShell,
  expireRankedLeases,
  expireRankedReady,
  joinRankedQueue,
  markRankedReadyPresence,
  rankedQueueStatus,
  settleRankedMatch,
  settlePendingRankedMatches,
} from './ranked.js';

const databases: ReturnType<typeof openDatabase>[] = [];
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
});

test('search stops at 15 seconds even when the client keeps polling', () => {
  const db = makeDb();
  joinRankedQueue(db, 'a', 1_000);
  assert.equal(rankedQueueStatus(db, 'a', 14_999)?.state, 'searching');
  assert.equal(rankedQueueStatus(db, 'a', 16_000), null);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE uid = ?', 'a').count, 0);
});

function row<T>(db: ReturnType<typeof openDatabase>, sql: string, ...values: unknown[]): T {
  return db.prepare(sql).get(...values) as T;
}

function assertHttpError(error: unknown, status: number): void {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
}

function bindBoth(db: ReturnType<typeof openDatabase>, matchId: string, now: number): void {
  const match = row<{ player_a_key: string; player_b_key: string }>(db,
    'SELECT player_a_key, player_b_key FROM matches WHERE id = ?', matchId);
  markRankedReadyPresence(db, matchId, match.player_a_key, true);
  markRankedReadyPresence(db, matchId, match.player_b_key, true);
  acknowledgeRankedReady(db, matchId, match.player_a_key, now);
  acknowledgeRankedReady(db, matchId, match.player_b_key, now + 1);
  markConnected(db, matchId, 'A', now + 1);
  markConnected(db, matchId, 'B', now + 1);
}

test('queue lease pairs two eligible players atomically and gives second tabs the same shell', () => {
  const db = makeDb();
  assert.deepEqual(joinRankedQueue(db, 'a', 10_000), {
    state: 'searching', matchId: null, competitiveMultiplier: null, readyDeadline: null,
  });
  const paired = joinRankedQueue(db, 'b', 10_001);
  assert.equal(paired.state, 'readying');
  assert.equal(paired.competitiveMultiplier, 1);
  assert.ok(paired.matchId);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_queue').count, 0);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE state = ?', 'match_shell').count, 2);
  const shell = row<{ started_at: number | null; player_a_name: string; player_b_name: string }>(db,
    'SELECT started_at, player_a_name, player_b_name FROM matches WHERE id = ?', paired.matchId);
  assert.equal(shell.started_at, null);
  assert.deepEqual([shell.player_a_name, shell.player_b_name], ['Ranked Player', 'Ranked Player']);

  const resumed = joinRankedQueue(db, 'a', 10_002);
  assert.equal(resumed.matchId, paired.matchId);
  assert.equal(resumed.competitiveMultiplier, paired.competitiveMultiplier);
});

test('queue broadens at 5 and 10 seconds and prefers a full-credit opponent', () => {
  const db = makeDb();
  db.prepare('UPDATE profiles SET rating = 1000 WHERE uid = ?').run('a');
  db.prepare('UPDATE profiles SET rating = 1200 WHERE uid = ?').run('b');
  joinRankedQueue(db, 'a', 0);
  assert.equal(joinRankedQueue(db, 'b', 1).state, 'searching');
  const paired = rankedQueueStatus(db, 'a', 5_000);
  assert.ok(paired);
  assert.equal(paired.state, 'readying');
  assert.equal(paired.competitiveMultiplier, 1);
});

test('ready handshake binds only when both players confirm and freezes startedAt then', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 50_000);
  const match = row<{ player_a_key: string; player_b_key: string; player_a_name: string; player_b_name: string }>(db,
    'SELECT player_a_key, player_b_key, player_a_name, player_b_name FROM matches WHERE id = ?', shell.matchId);
  markRankedReadyPresence(db, shell.matchId, match.player_a_key, true);
  markRankedReadyPresence(db, shell.matchId, match.player_b_key, true);
  const first = acknowledgeRankedReady(db, shell.matchId, match.player_a_key, 50_100);
  assert.equal(first.state, 'readying');
  assert.equal(row<{ started_at: number | null }>(db, 'SELECT started_at FROM matches WHERE id = ?', shell.matchId).started_at, null);
  assert.equal(acknowledgeRankedReady(db, shell.matchId, match.player_b_key, 50_200).state, 'active');
  const bound = row<{ started_at: number; deadline: number; ready_deadline: number | null; player_a_name: string; player_b_name: string }>(db,
    'SELECT started_at, deadline, ready_deadline, player_a_name, player_b_name FROM matches WHERE id = ?', shell.matchId);
  assert.equal(bound.started_at, 50_200);
  assert.equal(bound.deadline, 55_200);
  assert.equal(bound.ready_deadline, null);
  assert.deepEqual([bound.player_a_name, bound.player_b_name].sort(), ['Alpha', 'Bravo']);
  assert.equal(row<{ state: string; lease_expires_at: number | null }>(db,
    'SELECT state, lease_expires_at FROM ranked_ownership WHERE match_id = ? LIMIT 1', shell.matchId).state, 'active_match');
});

test('ready acknowledgements cannot bind a Ranked shell before both arena connections are present', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 50_000);
  const match = row<{ player_a_key: string; player_b_key: string }>(db,
    'SELECT player_a_key, player_b_key FROM matches WHERE id = ?', shell.matchId);

  acknowledgeRankedReady(db, shell.matchId, match.player_a_key, 50_100);
  acknowledgeRankedReady(db, shell.matchId, match.player_b_key, 50_200);

  assert.deepEqual(row<{ status: string; started_at: number | null }>(db,
    'SELECT status, started_at FROM matches WHERE id = ?', shell.matchId),
  { status: 'readying', started_at: null });
});

test('a reconnect binds a shell after both players already acknowledged ready', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 50_000);
  const match = row<{ player_a_key: string; player_b_key: string }>(db,
    'SELECT player_a_key, player_b_key FROM matches WHERE id = ?', shell.matchId);

  markRankedReadyPresence(db, shell.matchId, match.player_a_key, true);
  acknowledgeRankedReady(db, shell.matchId, match.player_a_key, 50_100);
  acknowledgeRankedReady(db, shell.matchId, match.player_b_key, 50_200);
  assert.equal(row<{ status: string }>(db, 'SELECT status FROM matches WHERE id = ?', shell.matchId).status, 'readying');

  markRankedReadyPresence(db, shell.matchId, match.player_b_key, true, 50_300);
  assert.deepEqual(row<{ status: string; started_at: number | null }>(db,
    'SELECT status, started_at FROM matches WHERE id = ?', shell.matchId),
  { status: 'decision', started_at: 50_300 });
});

test('startup clears stale readying presence without discarding ready acknowledgements', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 50_000);
  const match = row<{ player_a_key: string }>(db, 'SELECT player_a_key FROM matches WHERE id = ?', shell.matchId);
  db.prepare(`UPDATE matches SET ready_a = 1, ready_b = 1, ready_connected_a = 1, ready_connected_b = 1
    WHERE id = ?`).run(shell.matchId);

  clearRankedReadyPresenceOnStartup(db);

  assert.deepEqual(row<{ ready_a: number; ready_b: number; ready_connected_a: number; ready_connected_b: number }>(db,
    'SELECT ready_a, ready_b, ready_connected_a, ready_connected_b FROM matches WHERE id = ?', shell.matchId),
  { ready_a: 1, ready_b: 1, ready_connected_a: 0, ready_connected_b: 0 });
  assert.equal(acknowledgeRankedReady(db, shell.matchId, match.player_a_key, 50_100).state, 'readying');
});

test('a bound Ranked match enters disconnect grace when its arena connections are gone', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 50_000);
  const match = row<{ player_a_key: string; player_b_key: string }>(db,
    'SELECT player_a_key, player_b_key FROM matches WHERE id = ?', shell.matchId);
  markRankedReadyPresence(db, shell.matchId, match.player_a_key, true);
  markRankedReadyPresence(db, shell.matchId, match.player_b_key, true);
  acknowledgeRankedReady(db, shell.matchId, match.player_a_key, 50_100);
  acknowledgeRankedReady(db, shell.matchId, match.player_b_key, 50_101);
  const start = row<{ deadline: number; disconnected_a_at: number | null; disconnected_b_at: number | null }>(db,
    'SELECT deadline, disconnected_a_at, disconnected_b_at FROM matches WHERE id = ?', shell.matchId);
  assert.deepEqual([start.disconnected_a_at, start.disconnected_b_at], [50_101, 50_101]);
  assert.equal(resolveMatch(db, shell.matchId, start.deadline), true);
  const waiting = row<{ status: string; afk_a: number; afk_b: number; grace_until: number }>(db,
    'SELECT status, afk_a, afk_b, grace_until FROM matches WHERE id = ?', shell.matchId);
  assert.deepEqual(waiting, { status: 'grace', afk_a: 0, afk_b: 0, grace_until: start.deadline + 20_000 });
});

test('ready timeout cancels shell, releases ownership, and consumes no repeat credit', () => {
  const db = makeDb();
  const first = createRankedShell(db, 'a', 'b', 100_000);
  assert.equal(expireRankedReady(db, first.matchId, first.readyDeadline), true);
  const voided = row<{ status: string; started_at: number | null }>(db,
    'SELECT status, started_at FROM matches WHERE id = ?', first.matchId);
  assert.deepEqual(voided, { status: 'voided', started_at: null });
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership').count, 0);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements').count, 0);
  const second = createRankedShell(db, 'a', 'b', first.readyDeadline + 1);
  assert.equal(second.competitiveMultiplier, 1);
});

test('ready acknowledgement at the deadline commits expiry before rejecting the request', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 150_000);
  const match = row<{ player_a_key: string }>(db, 'SELECT player_a_key FROM matches WHERE id = ?', shell.matchId);
  assert.throws(() => acknowledgeRankedReady(db, shell.matchId, match.player_a_key, shell.readyDeadline), (error) => {
    assertHttpError(error, 409);
    return true;
  });
  assert.equal(row<{ status: string }>(db, 'SELECT status FROM matches WHERE id = ?', shell.matchId).status, 'voided');
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
});

test('D1 placement-ineligible repeat gives both players zero and D6 credit remains frozen', () => {
  const db = makeDb();
  db.prepare('UPDATE profiles SET placement_progress = 4 WHERE uid = ?').run('a');
  db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at) VALUES ('old-1', 'ranked', 'a', 'b', '', '', '{}', 'finished', ?),
      ('old-2', 'ranked', 'b', 'a', '', '', '{}', 'finished', ?)`)
    .run(200_000, 300_000);
  const shell = createRankedShell(db, 'a', 'b', 400_000);
  assert.equal(shell.competitiveMultiplier, 0);
  db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at) VALUES ('later-1', 'ranked', 'a', 'b', '', '', '{}', 'finished', ?)`)
    .run(400_001);
  assert.equal(row<{ competitive_multiplier: number; credit_assessed_at: number }>(db,
    'SELECT competitive_multiplier, credit_assessed_at FROM matches WHERE id = ?', shell.matchId).competitive_multiplier, 0);
  assert.equal(row<{ credit_assessed_at: number }>(db,
    'SELECT credit_assessed_at FROM matches WHERE id = ?', shell.matchId).credit_assessed_at, 400_000);
  bindBoth(db, shell.matchId, 400_100);
  const match = row<{ state_json: string }>(db, 'SELECT state_json FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = 'A';
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, result_type = 'standard'
    WHERE id = ?`).run(JSON.stringify(state), 401_000, shell.matchId);
  const before = row<{ rating: number; placement_progress: number; wins: number; losses: number; rated_match_count: number }>(
    db, 'SELECT rating, placement_progress, wins, losses, rated_match_count FROM profiles WHERE uid = ?', 'a');
  settleRankedMatch(db, shell.matchId, 401_001);
  assert.deepEqual(row<typeof before>(db,
    'SELECT rating, placement_progress, wins, losses, rated_match_count FROM profiles WHERE uid = ?', 'a'), before);
});

test('settlement atomically updates ratings/stats once and returns saved result on retry', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 500_000);
  bindBoth(db, shell.matchId, 500_100);
  const match = row<{ state_json: string }>(db, 'SELECT state_json FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = 'A';
  state.endingReason = 'standard';
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, result_type = 'standard'
    WHERE id = ?`).run(JSON.stringify(state), 600_000, shell.matchId);

  const result = settleRankedMatch(db, shell.matchId, 600_001) as { playerA: { updatedProfile: { wins: number; rating: number } } };
  const retry = settleRankedMatch(db, shell.matchId, 600_002);
  assert.deepEqual(retry, result);
  assert.equal(row<{ wins: number; rating: number }>(db, 'SELECT wins, rating FROM profiles WHERE uid = ?',
    row<{ player_a_key: string }>(db, 'SELECT player_a_key FROM matches WHERE id = ?', shell.matchId).player_a_key).wins, 1);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 1);
  assert.deepEqual(row<{ attempts: number; first_attempt_at: number; last_attempt_at: number }>(db,
    'SELECT attempts, first_attempt_at, last_attempt_at FROM settlement_duplicate_attempts WHERE match_id = ?', shell.matchId),
  { attempts: 1, first_attempt_at: 600_002, last_attempt_at: 600_002 });
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
});

test('worker retry settles a finished Ranked match after an interrupted terminal write', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 500_000);
  bindBoth(db, shell.matchId, 500_100);
  const match = row<{ state_json: string }>(db, 'SELECT state_json FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = 'A';
  db.prepare("UPDATE matches SET state_json = ?, status = 'finished', result_type = 'standard', ended_at = ? WHERE id = ?")
    .run(JSON.stringify(state), 600_000, shell.matchId);

  assert.deepEqual(settlePendingRankedMatches(db, 600_001), [shell.matchId]);
  assert.deepEqual(settlePendingRankedMatches(db, 600_002), []);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 1);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
});

test('file-backed restart recovers a resigned Ranked match with no settlement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'override-recovery-'));
  const path = join(directory, 'game.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
      .run('a', 'Alpha', 'alpha', 1);
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
      .run('b', 'Bravo', 'bravo', 1);
    const shell = createRankedShell(db, 'a', 'b', 500_000);
    bindBoth(db, shell.matchId, 500_100);
    resignMatch(db, shell.matchId, { id: 'session-a', uid: 'a', createdAt: 0, expiresAt: 1_000_000 }, 500_200);
    assert.deepEqual(dueMatches(db, 500_300), []);
    db.close();
    db = openDatabase(path);
    assert.deepEqual(settlePendingRankedMatches(db, 500_300), [shell.matchId]);
    assert.deepEqual(settlePendingRankedMatches(db, 500_301), []);
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 1);
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
  } finally {
    db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repeated internal settlement failure voids a bound match without changing ratings', () => {
  const db = makeDb();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const shell = createRankedShell(db, 'a', 'b', 500_000);
    bindBoth(db, shell.matchId, 500_100);
    resignMatch(db, shell.matchId, { id: 'session-a', uid: 'a', createdAt: 0, expiresAt: 1_000_000 }, 500_200);
    db.prepare('UPDATE matches SET credit_assessed_at = NULL WHERE id = ?').run(shell.matchId);
    assert.deepEqual(settlePendingRankedMatches(db, 500_300), []);
    assert.deepEqual(settlePendingRankedMatches(db, 501_300), []);
    assert.deepEqual(settlePendingRankedMatches(db, 502_300), [shell.matchId]);
    assert.deepEqual(row<{ status: string; result_type: string }>(db,
      'SELECT status, result_type FROM matches WHERE id = ?', shell.matchId),
    { status: 'voided', result_type: 'server-error' });
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 0);
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
    assert.equal(row<{ rating: number }>(db, 'SELECT rating FROM profiles WHERE uid = ?', 'a').rating, 1000);
    assert.equal(row<{ rating: number }>(db, 'SELECT rating FROM profiles WHERE uid = ?', 'b').rating, 1000);
  } finally {
    errors.mockRestore();
  }
});

test('transient profile write failure retries settlement without voiding the match', () => {
  const db = makeDb();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const shell = createRankedShell(db, 'a', 'b', 500_000);
    bindBoth(db, shell.matchId, 500_100);
    resignMatch(db, shell.matchId, { id: 'session-a', uid: 'a', createdAt: 0, expiresAt: 1_000_000 }, 500_200);
    db.exec(`CREATE TRIGGER temporary_profile_failure BEFORE UPDATE OF rating ON profiles
      BEGIN SELECT RAISE(ABORT, 'temporary write failure'); END`);
    assert.deepEqual(settlePendingRankedMatches(db, 500_300), []);
    assert.deepEqual(settlePendingRankedMatches(db, 501_300), []);
    assert.deepEqual(settlePendingRankedMatches(db, 502_300), []);
    assert.equal(errors.mock.calls.length, 1);
    assert.equal(row<{ status: string }>(db, 'SELECT status FROM matches WHERE id = ?', shell.matchId).status, 'finished');
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 2);
    db.exec('DROP TRIGGER temporary_profile_failure');
    assert.deepEqual(settlePendingRankedMatches(db, 503_300), [shell.matchId]);
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 1);
    assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 0);
  } finally {
    errors.mockRestore();
  }
});

test('no contest creates only the audit ledger and disconnect incidents, with no competitive changes', () => {
  const db = makeDb();
  db.prepare('UPDATE profiles SET wins = 2, streak = 2, placement_progress = 3 WHERE uid = ?').run('a');
  const shell = createRankedShell(db, 'a', 'b', 700_000);
  bindBoth(db, shell.matchId, 700_100);
  const match = row<{ state_json: string }>(db, 'SELECT state_json FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = null;
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, result_type = 'no-contest',
    disconnected_a_at = ?, disconnected_b_at = ? WHERE id = ?`)
    .run(JSON.stringify(state), 800_000, 799_000, 799_000, shell.matchId);
  const before = row<{ rating: number; wins: number; streak: number; placement_progress: number; rated_match_count: number }>(
    db, 'SELECT rating, wins, streak, placement_progress, rated_match_count FROM profiles WHERE uid = ?', 'a');
  const settled = settleRankedMatch(db, shell.matchId, 800_001) as { multiplier: number };
  const after = row<typeof before>(db, 'SELECT rating, wins, streak, placement_progress, rated_match_count FROM profiles WHERE uid = ?', 'a');
  assert.equal(settled.multiplier, 0);
  assert.deepEqual(after, before);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM disconnect_incidents WHERE match_id = ?', shell.matchId).count, 2);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?', shell.matchId).count, 1);
});

test('settled no-contests do not consume same-pair anti-farming credit', () => {
  const db = makeDb();
  db.prepare('UPDATE profiles SET placement_progress = 5, rated_match_count = 5 WHERE uid IN (?, ?)').run('a', 'b');
  const noContests = Array.from({ length: 5 }, (_, index) => `('nc-${index}', 'ranked', 'a', 'b', '', '', '{}', 'finished', ?, 'no-contest')`).join(',');
  db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at, result_type) VALUES ${noContests}`)
    .run(100_000, 200_000, 300_000, 400_000, 500_000);
  const shell = createRankedShell(db, 'a', 'b', 600_000);
  assert.equal(shell.competitiveMultiplier, 1);
});

test('a no-contest caused by simultaneous AFK does not record disconnect incidents', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 850_000);
  bindBoth(db, shell.matchId, 850_100);
  const match = row<{ state_json: string }>(db, 'SELECT state_json FROM matches WHERE id = ?', shell.matchId);
  const state = JSON.parse(match.state_json) as Record<string, unknown>;
  state.status = 'finished';
  state.winner = null;
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, result_type = 'no-contest'
    WHERE id = ?`).run(JSON.stringify(state), 900_000, shell.matchId);
  settleRankedMatch(db, shell.matchId, 900_001);
  assert.equal(row<{ count: number }>(db,
    'SELECT COUNT(*) AS count FROM disconnect_incidents WHERE match_id = ?', shell.matchId).count, 0);
});

test('active Ranked ownership blocks a second pair until settlement', () => {
  const db = makeDb();
  const shell = createRankedShell(db, 'a', 'b', 900_000);
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run('c', 'Charlie', 'charlie', 1);
  assert.throws(() => createRankedShell(db, 'a', 'c', 900_001), (error) => {
    assertHttpError(error, 409);
    return true;
  });
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership WHERE match_id = ?', shell.matchId).count, 2);
});

test('expired searching leases are removed but active-match ownership is preserved', () => {
  const db = makeDb();
  joinRankedQueue(db, 'a', 1_000);
  assert.deepEqual(expireRankedLeases(db, 61_000), []);
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_ownership').count, 0);
});

test('three mutual no-contests in 24 hours trigger a 15-minute Ranked queue cooldown', () => {
  const db = makeDb();
  db.prepare('INSERT INTO disconnect_incidents (uid, match_id, created_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .run('a', 'nc-1', 1_000, 'a', 'nc-2', 2_000, 'a', 'nc-3', 3_000);
  assert.deepEqual(rankedQueueStatus(db, 'a', 3_000), {
    state: 'cooldown', matchId: null, competitiveMultiplier: null, readyDeadline: null,
    cooldownUntil: 903_000,
  });
  assert.throws(() => joinRankedQueue(db, 'a', 3_000), (error) => {
    assertHttpError(error, 429);
    return true;
  });
  assert.equal(row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM ranked_queue').count, 0);
  assert.equal(rankedQueueStatus(db, 'a', 903_000), null);
  assert.equal(joinRankedQueue(db, 'a', 903_000).state, 'searching');
});
