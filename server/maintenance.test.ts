import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openDatabase } from './db';
import { pruneExpiredGuestData } from './maintenance';
import { createBotMatch } from './matches';
import type { Session } from './http';

test('retention removes old guest match chains and telemetry but preserves Ranked audit rows', () => {
  const db = openDatabase(':memory:');
  try {
    const now = 100 * 24 * 60 * 60_000;
    const session: Session = { id: 'guest', uid: null, createdAt: 0, expiresAt: 1_000 };
    db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, 0, ?)')
      .run(session.id, session.expiresAt);
    const parent = createBotMatch(db, session, 'Player', 'practice', 'easy');
    db.prepare("UPDATE matches SET status = 'finished', started_at = 1, ended_at = 2 WHERE id = ?").run(parent);
    const child = createBotMatch(db, session, 'Player', 'practice', 'easy', parent);
    db.prepare("UPDATE matches SET status = 'finished', started_at = 3, ended_at = 4 WHERE id = ?").run(child);
    db.prepare("INSERT INTO pending_actions (match_id, round, player, action_json, locked_at) VALUES (?, 1, 'A', '{}', 1)").run(parent);
    db.prepare('INSERT INTO telemetry_events (session_id, name, mode, created_at) VALUES (?, ?, NULL, 1)')
      .run(session.id, 'homepage_opened');
    db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at, ended_at) VALUES ('ranked-audit', 'ranked', 'a', 'b', 'A', 'B', '{}', 'finished', 1, 2)`).run();

    const removed = pruneExpiredGuestData(db, now);
    assert.equal(removed.matches, 2);
    assert.equal(removed.telemetry, 1);
    assert.equal(removed.sessions, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM matches').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM pending_actions').get() as { count: number }).count, 0);
    assert.ok(db.prepare("SELECT 1 FROM matches WHERE id = 'ranked-audit'").get());
  } finally {
    db.close();
  }
});

test('retention removes old Ranked invitation tokens without deleting match or settlement audit', () => {
  const db = openDatabase(':memory:');
  try {
    const day = 24 * 60 * 60_000;
    const now = 100 * day;
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, 1)')
      .run('a', 'Alpha', 'alpha');
    db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, started_at, ended_at) VALUES ('ranked-audit', 'ranked', 'a', 'b', 'A', 'B', '{}', 'finished', 1, 2)`).run();
    db.prepare('INSERT INTO rating_settlements (match_id, settlement_json, settled_at) VALUES (?, ?, 2)')
      .run('ranked-audit', '{}');
    const insert = db.prepare(`INSERT INTO ranked_invitations
      (id, token, kind, creator_uid, parent_match_id, status, match_id, created_at, expires_at)
      VALUES (?, ?, ?, 'a', ?, ?, ?, 1, ?)`);
    insert.run('old-challenge', 'old-challenge-token', 'challenge', null, 'expired', null, day);
    insert.run('old-accepted', 'old-accepted-token', 'rematch', 'ranked-audit', 'accepted', 'ranked-audit', day);
    insert.run('recent-challenge', 'recent-token', 'challenge', null, 'expired', null, 90 * day);
    db.prepare('INSERT INTO ranked_code_attempts (uid, window_started_at, attempts) VALUES (?, ?, ?)')
      .run('a', 1, 10);
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, 1)')
      .run('b', 'Bravo', 'bravo');
    db.prepare('INSERT INTO ranked_code_attempts (uid, window_started_at, attempts) VALUES (?, ?, ?)')
      .run('b', now - 30_000, 1);

    const removed = pruneExpiredGuestData(db, now);
    assert.equal(removed.invitations, 2);
    assert.equal(removed.challengeAttempts, 1);
    assert.deepEqual(db.prepare('SELECT uid FROM ranked_code_attempts').all(), [{ uid: 'b' }]);
    assert.deepEqual(db.prepare('SELECT id FROM ranked_invitations').all(), [{ id: 'recent-challenge' }]);
    assert.ok(db.prepare("SELECT 1 FROM matches WHERE id = 'ranked-audit'").get());
    assert.ok(db.prepare("SELECT 1 FROM rating_settlements WHERE match_id = 'ranked-audit'").get());
  } finally {
    db.close();
  }
});
