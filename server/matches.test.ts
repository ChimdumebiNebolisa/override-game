import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db';
import { createQuickRoom, joinQuickRoom, openRoomForSession } from './rooms';
import {
  activeMatchForSession, createBotMatch, dueMatches, expireGrace, getMatch, lockAction as serviceLockAction, markConnected, markDisconnected, reconcilePresenceOnStartup,
  matchForSession, resignMatch, resolveMatch, startNextRound,
} from './matches';
import { createInitialState, validateAction, type Action, type MatchState, type RoundResult } from '../src/shared/rules';
import type { Session } from './http';

const session = (id: string): Session => ({ id, uid: null, createdAt: 0, expiresAt: 1_000_000 });
const move = (type: 'expand' | 'ambush' | 'surge' | 'override', target: number): Action => ({ type, target });
const pass: Action = { type: 'pass' };

function expectStatus(run: () => unknown, status: number): void {
  try {
    run();
    throw new Error('Expected an HTTP error');
  } catch (error) {
    expect(error).toMatchObject({ status });
  }
}

function lockAction(db: ReturnType<typeof openDatabase>, id: string, actor: Session, action: Action): void {
  const snapshot = matchForSession(db, id, actor);
  serviceLockAction(db, id, actor, action, snapshot.state!.round, snapshot.revision);
}

describe('guest matches', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function humanMatch() {
    const host = session('host');
    const guest = session('guest');
    const room = createQuickRoom(db, host, 'Host');
    const joined = joinQuickRoom(db, guest, { code: room.code }, 'Guest');
    const id = joined.matchId!;
    const row = getMatch(db, id)!;
    return {
      id,
      roomId: room.id,
      A: row.player_a_key === host.id ? host : guest,
      B: row.player_b_key === host.id ? host : guest,
    };
  }

  it('resumes a guest room and active match only for its participant', () => {
    const host = session('host');
    const guest = session('guest');
    const stranger = session('stranger');
    const room = createQuickRoom(db, host, 'Host');
    expect(openRoomForSession(db, host)?.id).toBe(room.id);
    expect(openRoomForSession(db, stranger)).toBeNull();
    const joined = joinQuickRoom(db, guest, { code: room.code }, 'Guest');
    expect(activeMatchForSession(db, host)?.id).toBe(joined.matchId);
    expect(activeMatchForSession(db, guest)?.id).toBe(joined.matchId);
    expect(activeMatchForSession(db, stranger)).toBeNull();
  });

  it('marks lost sockets offline before resolving an overdue round after restart', () => {
    const match = humanMatch();
    reconcilePresenceOnStartup(db, 106_000);
    expect(dueMatches(db, 106_000)).toEqual([match.id]);
    const after = getMatch(db, match.id)!;
    expect(after.status).toBe('grace');
    expect([after.afk_a, after.afk_b]).toEqual([0, 0]);
    expect([after.disconnect_a, after.disconnect_b]).toEqual([0, 0]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM presence_events WHERE match_id = ? AND offline = 1')
      .get(match.id)).toMatchObject({ count: 2 });
  });

  it('caps concurrent bot matches for one guest session', () => {
    const guest = session('guest');
    for (let index = 0; index < 3; index++) createBotMatch(db, guest, 'Guest', 'quick', 'easy');
    expectStatus(() => createBotMatch(db, guest, 'Guest', 'quick', 'easy'), 429);
  });

  function facingState(energyA = 0, energyB = 0): MatchState {
    return {
      ...createInitialState(),
      board: '...........A.B...........'.split('').map((cell) => cell === '.' ? 'neutral' : cell as 'A' | 'B'),
      energy: { A: energyA, B: energyB },
    };
  }

  it('keeps pending moves private and resolves at the fixed human deadline once', () => {
    const match = humanMatch();
    const deadline = getMatch(db, match.id)!.deadline!;
    lockAction(db, match.id, match.A, move('expand', 2));
    const beforeOpponentLock = matchForSession(db, match.id, match.B);
    expect(beforeOpponentLock.locked).toBe(false);
    expect(beforeOpponentLock.lastResult).toBeNull();
    expect(JSON.stringify(beforeOpponentLock)).not.toContain('"type":"expand"');
    lockAction(db, match.id, match.B, move('expand', 22));
    const aView = matchForSession(db, match.id, match.A);
    const bView = matchForSession(db, match.id, match.B);
    expect(aView.locked).toBe(true);
    expect(bView.locked).toBe(true);
    expect(aView.lastResult).toBeNull();
    expect(bView.lastResult).toBeNull();
    expect(JSON.stringify(aView)).not.toContain('pending_actions');
    expect(JSON.stringify(aView)).not.toContain('"target":22');
    expect(resolveMatch(db, match.id, deadline - 1)).toBe(false);
    expect(getMatch(db, match.id)?.status).toBe('decision');
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    expect(resolveMatch(db, match.id, deadline)).toBe(false);
    expect(db.prepare('SELECT count(*) AS count FROM round_results WHERE match_id = ?').get(match.id))
      .toEqual({ count: 1 });
    const result = matchForSession(db, match.id, match.A).lastResult!;
    expect(result.state.board[2]).toBe('A');
    expect(result.state.board[22]).toBe('B');
  });

  it('rejects illegal and duplicate locks without consuming the first valid lock', () => {
    const match = humanMatch();
    expectStatus(() => lockAction(db, match.id, match.A, move('surge', 2)), 400);
    expect(db.prepare('SELECT count(*) AS count FROM pending_actions WHERE match_id = ?').get(match.id))
      .toEqual({ count: 0 });
    lockAction(db, match.id, match.A, move('expand', 2));
    expectStatus(() => lockAction(db, match.id, match.A, pass), 409);
    expectStatus(() => lockAction(db, match.id, session('outsider'), pass), 404);
    expect(db.prepare('SELECT action_json FROM pending_actions WHERE match_id = ? AND player = ?')
      .get(match.id, 'A')).toMatchObject({ action_json: JSON.stringify(move('expand', 2)) });
    vi.setSystemTime(new Date(getMatch(db, match.id)!.deadline!));
    expectStatus(() => lockAction(db, match.id, match.B, pass), 409);
  });

  it('rejects a delayed Round 1 action after Round 2 opens, even when its target stays legal', () => {
    const match = humanMatch();
    const oldSnapshot = matchForSession(db, match.id, match.A);
    lockAction(db, match.id, match.A, pass);
    lockAction(db, match.id, match.B, pass);
    resolveMatch(db, match.id, getMatch(db, match.id)!.deadline!);
    const transition = getMatch(db, match.id)!.transition_at!;
    startNextRound(db, match.id, transition);
    vi.setSystemTime(new Date(transition));
    expectStatus(() => serviceLockAction(db, match.id, match.A, move('expand', 2),
      oldSnapshot.state!.round, oldSnapshot.revision), 409);
    expect(db.prepare('SELECT count(*) AS count FROM pending_actions WHERE match_id = ? AND round = 2')
      .get(match.id)).toEqual({ count: 0 });
  });

  it('publishes same-node collision and correct Ambush outcomes', () => {
    const collision = humanMatch();
    db.prepare('UPDATE matches SET state_json = ? WHERE id = ?')
      .run(JSON.stringify(facingState()), collision.id);
    lockAction(db, collision.id, collision.A, move('expand', 12));
    lockAction(db, collision.id, collision.B, move('expand', 12));
    expect(resolveMatch(db, collision.id, getMatch(db, collision.id)!.deadline!)).toBe(true);
    const first = matchForSession(db, collision.id, collision.A).lastResult!;
    expect(first.outcomes.A.reason).toBe('collision');
    expect(first.outcomes.B.reason).toBe('collision');
    expect(first.state.board[12]).toBe('neutral');

    const ambush = humanMatch();
    db.prepare('UPDATE matches SET state_json = ? WHERE id = ?')
      .run(JSON.stringify(facingState()), ambush.id);
    lockAction(db, ambush.id, ambush.A, move('ambush', 12));
    lockAction(db, ambush.id, ambush.B, move('expand', 12));
    expect(resolveMatch(db, ambush.id, getMatch(db, ambush.id)!.deadline!)).toBe(true);
    const second = matchForSession(db, ambush.id, ambush.A).lastResult!;
    expect(second.outcomes.A.reason).toBe('ambush-hit');
    expect(second.outcomes.B.reason).toBe('intercepted');
    expect(second.state.energy.A).toBe(1);
  });

  it('chooses a legal bot action and resolves immediately after the human lock', () => {
    const human = session('human');
    const id = createBotMatch(db, human, 'Human', 'quick', 'hard');
    const opening = JSON.parse(getMatch(db, id)!.state_json) as MatchState;
    lockAction(db, id, human, move('expand', 2));
    const row = getMatch(db, id)!;
    expect(row.status).toBe('transition');
    expect(row.last_result_json).toBeTruthy();
    const result = JSON.parse(row.last_result_json!) as RoundResult;
    expect(validateAction(opening, 'B', result.outcomes.B.action)).toEqual({ ok: true });
    expect(result.outcomes.A.action).toEqual(move('expand', 2));
    expect(resolveMatch(db, id, row.deadline ?? 105_000)).toBe(false);
  });

  it('chooses a bot action at the deadline when the human never locks', () => {
    const id = createBotMatch(db, session('human'), 'Human', 'quick', 'hard');
    const before = getMatch(db, id)!;
    const opening = JSON.parse(before.state_json) as MatchState;
    expect(resolveMatch(db, id, before.deadline! - 1)).toBe(false);
    expect(resolveMatch(db, id, before.deadline!)).toBe(true);
    const row = getMatch(db, id)!;
    const result = JSON.parse(row.last_result_json!) as RoundResult;
    expect(result.outcomes.A.reason).toBe('automatic-pass');
    expect(result.outcomes.B.action.type).not.toBe('pass');
    expect(validateAction(opening, 'B', result.outcomes.B.action)).toEqual({ ok: true });
    expect(row.afk_a).toBe(1);
    expect(row.afk_b).toBe(0);
    expect(row.status).toBe('transition');
    expect(resolveMatch(db, id, before.deadline!)).toBe(false);
  });

  it('resolves a third connected miss as Pass then forfeit, without opening another round', () => {
    const match = humanMatch();
    for (let round = 1; round <= 3; round++) {
      lockAction(db, match.id, match.B, pass);
      const deadline = getMatch(db, match.id)!.deadline!;
      expect(resolveMatch(db, match.id, deadline)).toBe(true);
      const row = getMatch(db, match.id)!;
      const result = JSON.parse(row.last_result_json!) as RoundResult;
      expect(result.outcomes.A.reason).toBe('automatic-pass');
      expect(row.afk_a).toBe(round);
      if (round < 3) {
        expect(row.status).toBe('transition');
        expect(startNextRound(db, match.id, row.transition_at!)).toBe(true);
        vi.setSystemTime(new Date(row.transition_at!));
      } else {
        expect(row.status).toBe('finished');
        expect(row.result_type).toBe('forfeit');
        expect(result.state.winner).toBe('B');
        expect(startNextRound(db, match.id, deadline + 1_000)).toBe(false);
      }
    }
    expect(db.prepare('SELECT count(*) AS count FROM round_results WHERE match_id = ?').get(match.id))
      .toEqual({ count: 3 });
  });

  it('resets a connected miss streak after a valid voluntary Pass', () => {
    const match = humanMatch();
    resolveMatch(db, match.id, getMatch(db, match.id)!.deadline!);
    const afterMiss = getMatch(db, match.id)!;
    expect(afterMiss.afk_a).toBe(1);
    startNextRound(db, match.id, afterMiss.transition_at!);
    vi.setSystemTime(new Date(afterMiss.transition_at!));
    lockAction(db, match.id, match.A, pass);
    lockAction(db, match.id, match.B, pass);
    resolveMatch(db, match.id, getMatch(db, match.id)!.deadline!);
    expect(getMatch(db, match.id)?.afk_a).toBe(0);
  });

  it('ends the match when both connected players reach their third missed deadline', () => {
    const match = humanMatch();
    db.prepare('UPDATE matches SET afk_a = 2, afk_b = 2 WHERE id = ?').run(match.id);
    const deadline = getMatch(db, match.id)!.deadline!;
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    const row = getMatch(db, match.id)!;
    expect((JSON.parse(row.last_result_json!) as RoundResult).outcomes.A.reason).toBe('automatic-pass');
    expect((JSON.parse(row.last_result_json!) as RoundResult).outcomes.B.reason).toBe('automatic-pass');
    expect(row.status).toBe('finished');
    expect(row.result_type).toBe('no-contest');
    expect((JSON.parse(row.state_json) as MatchState).winner).toBeNull();
  });

  it('records disconnected Pass without an AFK strike, then resumes after reconnect', () => {
    const match = humanMatch();
    markDisconnected(db, match.id, 'A', 100_100);
    lockAction(db, match.id, match.B, pass);
    const deadline = getMatch(db, match.id)!.deadline!;
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    const waiting = getMatch(db, match.id)!;
    expect(waiting.status).toBe('grace');
    expect(waiting.afk_a).toBe(0);
    expect(waiting.grace_until).toBe(deadline + 20_000);
    expect((JSON.parse(waiting.last_result_json!) as RoundResult).outcomes.A.reason).toBe('automatic-pass');
    markConnected(db, match.id, 'A', deadline + 1_000);
    const resumed = getMatch(db, match.id)!;
    expect(resumed.status).toBe('decision');
    expect(resumed.deadline).toBe(deadline + 6_000);
    expect((JSON.parse(resumed.state_json) as MatchState).round).toBe(2);
  });

  it('counts a connected missed deadline even if disconnection arrives before the worker resolves', () => {
    const match = humanMatch();
    const deadline = getMatch(db, match.id)!.deadline!;
    markDisconnected(db, match.id, 'A', deadline + 100);
    expect(resolveMatch(db, match.id, deadline + 200)).toBe(true);
    expect(getMatch(db, match.id)?.afk_a).toBe(1);
  });

  it('does not count a disconnected missed deadline after reconnecting before worker resolution', () => {
    const match = humanMatch();
    const deadline = getMatch(db, match.id)!.deadline!;
    markDisconnected(db, match.id, 'A', deadline - 100);
    markConnected(db, match.id, 'A', deadline + 100);
    expect(resolveMatch(db, match.id, deadline + 200)).toBe(true);
    expect(getMatch(db, match.id)?.afk_a).toBe(0);
  });

  it('forfeits a third disconnect after resolving the active round even when score would end it', () => {
    const match = humanMatch();
    const leading: MatchState = {
      ...facingState(),
      board: '..........AA.B..A........'.split('').map((cell) => cell === '.' ? 'neutral' : cell as 'A' | 'B'),
      round: 12,
    };
    db.prepare('UPDATE matches SET state_json = ?, disconnect_a = 2 WHERE id = ?')
      .run(JSON.stringify(leading), match.id);
    markDisconnected(db, match.id, 'A', 100_100);
    lockAction(db, match.id, match.B, pass);
    const deadline = getMatch(db, match.id)!.deadline!;
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    const row = getMatch(db, match.id)!;
    expect(row.status).toBe('finished');
    expect(row.result_type).toBe('forfeit');
    expect((JSON.parse(row.state_json) as MatchState).winner).toBe('B');
  });

  it('allows only a participant to resign and records the opponent as winner once', () => {
    const match = humanMatch();
    expectStatus(() => resignMatch(db, match.id, session('outsider')), 404);
    expect(getMatch(db, match.id)?.status).toBe('decision');
    resignMatch(db, match.id, match.A, 101_000);
    const row = getMatch(db, match.id)!;
    expect(row.status).toBe('finished');
    expect(row.deadline).toBeNull();
    expect(row.result_type).toBe('resignation');
    expect((JSON.parse(row.state_json) as MatchState)).toMatchObject({
      status: 'finished', winner: 'B', endingReason: 'resignation',
    });
    expectStatus(() => resignMatch(db, match.id, match.A), 409);
    expect(resolveMatch(db, match.id, 105_000)).toBe(false);
  });

  it('ends mutual disconnect grace as an idempotent no-contest', () => {
    const match = humanMatch();
    markDisconnected(db, match.id, 'A', 100_100);
    markDisconnected(db, match.id, 'B', 100_200);
    const deadline = getMatch(db, match.id)!.deadline!;
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    const grace = getMatch(db, match.id)!;
    expect(grace.status).toBe('grace');
    expect(expireGrace(db, match.id, grace.grace_until! - 1)).toBe(false);
    expect(expireGrace(db, match.id, grace.grace_until!)).toBe(true);
    expect(expireGrace(db, match.id, grace.grace_until!)).toBe(false);
    const final = getMatch(db, match.id)!;
    expect(final.status).toBe('finished');
    expect(final.result_type).toBe('no-contest');
    expect((JSON.parse(final.state_json) as MatchState).winner).toBeNull();
  });

  it('does not reopen a match when reconnection arrives after grace expiry', () => {
    const match = humanMatch();
    markDisconnected(db, match.id, 'A', 100_100);
    const deadline = getMatch(db, match.id)!.deadline!;
    expect(resolveMatch(db, match.id, deadline)).toBe(true);
    const graceUntil = getMatch(db, match.id)!.grace_until!;
    markConnected(db, match.id, 'A', graceUntil + 1);
    expect(getMatch(db, match.id)?.status).toBe('grace');
    expect(expireGrace(db, match.id, graceUntil + 1)).toBe(true);
    expect(getMatch(db, match.id)?.result_type).toBe('forfeit');
  });
});
