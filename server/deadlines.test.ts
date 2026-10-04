import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db';
import { dueMatches, getMatch, markConnected, matchForSession } from './matches';
import { createQuickRoom, joinQuickRoom } from './rooms';
import { settlePendingRankedMatches } from './ranked';
import type { Session } from './http';

describe('deadline failure recovery', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    db = openDatabase(':memory:');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function match(label: string) {
    const host: Session = { id: `${label}-host`, uid: null, createdAt: 0, expiresAt: 1_000_000 };
    const guest: Session = { ...host, id: `${label}-guest` };
    const room = createQuickRoom(db, host, 'Host');
    const id = joinQuickRoom(db, guest, { code: room.code }, 'Guest').matchId!;
    markConnected(db, id, 'A');
    markConnected(db, id, 'B');
    return { id, host, guest, roomId: room.id };
  }

  it.each(['state-json', 'state-shape', 'action-json', 'illegal-action'])('voids %s without competitive effects and resolves the next match', (corruption) => {
    const broken = match('broken');
    const healthy = match('healthy');
    db.prepare("UPDATE matches SET mode = 'ranked', deadline = 104000 WHERE id = ?").run(broken.id);
    for (const actor of [broken.host, broken.guest]) {
      db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, 1)')
        .run(actor.id, actor.id, actor.id);
      db.prepare("INSERT INTO ranked_ownership (uid, state, match_id) VALUES (?, 'active_match', ?)").run(actor.id, broken.id);
    }
    const profilesBefore = db.prepare('SELECT * FROM profiles ORDER BY uid').all();
    if (corruption.startsWith('state')) {
      db.prepare('UPDATE matches SET state_json = ? WHERE id = ?')
        .run(corruption === 'state-json' ? '{broken secret' : '{"board":[]}', broken.id);
    } else {
      db.prepare("INSERT INTO pending_actions (match_id, round, player, action_json, locked_at) VALUES (?, 1, 'A', ?, 101000)")
        .run(broken.id, corruption === 'action-json' ? '{secret move' : JSON.stringify({ type: 'surge', target: 2 }));
    }

    expect(dueMatches(db, 105_000)).toEqual([broken.id, healthy.id]);
    expect(getMatch(db, broken.id)).toMatchObject({ status: 'voided', result_type: 'server-error', deadline: null });
    expect(getMatch(db, healthy.id)?.status).toBe('transition');
    const snapshot = matchForSession(db, broken.id, { ...broken.host, uid: broken.host.id });
    expect(snapshot.state).toMatchObject({ status: 'finished', winner: null, endingReason: null });
    expect(snapshot.lastResult).toBeNull();
    expect(settlePendingRankedMatches(db, 105_000)).toEqual([]);
    expect(db.prepare('SELECT * FROM profiles ORDER BY uid').all()).toEqual(profilesBefore);
    expect(db.prepare('SELECT * FROM rating_settlements').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM disconnect_incidents').all()).toEqual([]);
    expect(db.prepare('SELECT status FROM rooms WHERE id = ?').get(broken.roomId)).toEqual({ status: 'finished' });
    expect(dueMatches(db, 105_000)).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');
  });

  it('retries repeated database failures without voiding and resolves other due matches', () => {
    const broken = match('blocked');
    const healthy = match('healthy');
    db.prepare('UPDATE matches SET deadline = 104000 WHERE id = ?').run(broken.id);
    db.exec(`CREATE TRIGGER fail_one_result BEFORE INSERT ON round_results WHEN NEW.match_id = '${broken.id}'
      BEGIN SELECT RAISE(FAIL, 'temporary write failure'); END`);
    expect(dueMatches(db, 105_000)).toEqual([healthy.id]);
    expect(dueMatches(db, 105_100)).toEqual([]);
    expect(dueMatches(db, 105_200)).toEqual([]);
    expect(getMatch(db, broken.id)?.status).toBe('decision');
    expect(getMatch(db, healthy.id)?.status).toBe('transition');
    expect(console.error).toHaveBeenCalledTimes(1);
    db.exec('DROP TRIGGER fail_one_result');
    expect(dueMatches(db, 105_300)).toEqual([broken.id]);
    expect(dueMatches(db, 105_300)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(broken.id)).toEqual({ count: 1 });
    expect(getMatch(db, broken.id)?.status).toBe('transition');
  });

  it('retries a failed void transaction while letting healthy matches resolve', () => {
    const broken = match('broken');
    const healthy = match('healthy');
    db.prepare('UPDATE matches SET state_json = ?, deadline = 104000 WHERE id = ?').run('null', broken.id);
    db.exec(`CREATE TRIGGER fail_void BEFORE UPDATE OF status ON matches WHEN NEW.id = '${broken.id}' AND NEW.status = 'voided'
      BEGIN SELECT RAISE(FAIL, 'temporary write failure'); END`);
    expect(dueMatches(db, 105_000)).toEqual([healthy.id]);
    expect(getMatch(db, broken.id)?.status).toBe('decision');
    db.exec('DROP TRIGGER fail_void');
    expect(dueMatches(db, 105_100)).toEqual([broken.id]);
    expect(getMatch(db, broken.id)?.status).toBe('voided');
  });
});
