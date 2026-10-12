import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db';
import { initializeDatabase } from './schema-initializer';
import { createQuickRoom, joinQuickRoom } from './rooms';
import { acknowledgeRankedReady, createRankedShell, markRankedReadyPresence, settlePendingRankedMatches } from './ranked';
import { acknowledgeBotRound, activeMatchForSession, createBotMatch, dueMatches, getMatch, lockAction,
  markConnected, markDisconnected, matchForSession, reconcilePresenceOnStartup, resignMatch, resolveMatch, startNextRound } from './matches';
import { createInitialState, legalActions, type Action } from '../src/shared/rules';
import type { Session } from './http';
import { chooseBotAction } from '../src/shared/bots';

const session = (id: string): Session => ({ id, uid: null, createdAt: 0, expiresAt: 1_000_000 });
const pass: Action = { type: 'pass' };
describe('persisted match pacing', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); vi.useRealTimers(); });
  function lock(id: string, actor: Session, action: Action = pass) {
    const view = matchForSession(db, id, actor);
    lockAction(db, id, actor, action, view.state!.round, view.revision);
  }
  function next(id: string, actor: Session, round: number, key = randomUUID()) {
    acknowledgeBotRound(db, id, actor, round, key, getMatch(db, id)!.revision);
    return key;
  }
  function human() {
    const a = session('host'), b = session('guest');
    const room = createQuickRoom(db, a, 'Host');
    const id = joinQuickRoom(db, b, { code: room.code }, 'Guest').matchId!;
    markConnected(db, id, 'A'); markConnected(db, id, 'B');
    return { id, a, b };
  }

  it.each([['practice', false], ['practice', true], ['quick', true]] as const)('creates %s timed=%s with the new policy and server review', (mode, timed) => {
    const actor = session('human');
    const id = createBotMatch(db, actor, 'Human', mode, 'easy', undefined, undefined, undefined, undefined, timed);
    expect(getMatch(db, id)).toMatchObject({ policy_version: 2, decision_duration_ms: 10_000, reveal_duration_ms: 3_000,
      progression: 'review', deadline: timed ? 110_000 : null });
    const before = matchForSession(db, id, actor);
    expect(before.state).toEqual(createInitialState());
    expect(before.state?.energy).toEqual({ A: 5, B: 5 });
    expect(before.state?.config.energyCap).toBe(5);
    const action = legalActions(before.state!, before.player!)[0];
    lock(id, actor, action);
    expect(getMatch(db, id)).toMatchObject({ status: 'review', deadline: null, transition_at: null });
    expect(activeMatchForSession(db, actor)?.id).toBe(id);
    expect(resolveMatch(db, id, 1_000_000)).toBe(false);
    const side = before.player!;
    vi.setSystemTime(600_000);
    markDisconnected(db, id, side);
    reconcilePresenceOnStartup(db, 700_000);
    expect(dueMatches(db, 900_000)).toEqual([]);
    markConnected(db, id, side, 900_001);
    expect(getMatch(db, id)).toMatchObject({ status: 'review', afk_a: 0, afk_b: 0, disconnect_a: 0, disconnect_b: 0 });
    next(id, actor, 1);
    expect(getMatch(db, id)).toMatchObject({ status: 'decision', deadline: timed ? 610_000 : null });
  });

  it('binds Next to a participant, round and retry identity across later reviews and presence revisions', () => {
    const actor = session('human'); const id = createBotMatch(db, actor, 'Human', 'practice');
    lock(id, actor);
    const revision = getMatch(db, id)!.revision;
    markDisconnected(db, id, matchForSession(db, id, actor).player!);
    const key = randomUUID();
    expect(() => acknowledgeBotRound(db, id, session('outsider'), 1, key, revision)).toThrow('Match not found');
    acknowledgeBotRound(db, id, actor, 1, key, revision);
    const advanced = getMatch(db, id)!;
    acknowledgeBotRound(db, id, actor, 1, key, revision);
    expect(getMatch(db, id)).toEqual(advanced);
    lock(id, actor); // Round two result, no second Next yet.
    const review2 = getMatch(db, id)!;
    acknowledgeBotRound(db, id, actor, 1, key, revision);
    expect(getMatch(db, id)).toEqual(review2);
    expect(() => next(id, actor, 1)).toThrow('no longer');
    expect(() => next(id, actor, 2, key)).toThrow('no longer');
    next(id, actor, 2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM round_acknowledgements WHERE match_id = ?').get(id)).toEqual({ count: 2 });
    resignMatch(db, id, actor);
    expect(() => next(id, actor, 3)).toThrow('no longer');
  });

  it('one human lock stays private; two locks resolve once with a full shared reveal and later decision', () => {
    const { id, a, b } = human();
    const original = matchForSession(db, id, b);
    lock(id, a);
    const hidden = matchForSession(db, id, b);
    expect(hidden).toEqual(original);
    expect(hidden.locked).toBe(false);
    expect(hidden.lastResult).toBeNull();
    expect(JSON.stringify(hidden)).not.toMatch(/locked_at|action_json|pending|ready_a|ready_b/);
    expect(() => lock(id, a, legalActions(matchForSession(db, id, a).state!, matchForSession(db, id, a).player!)[0])).toThrow('already locked');
    vi.setSystemTime(101_000); lock(id, b);
    expect(getMatch(db, id)).toMatchObject({ status: 'transition', transition_at: 104_000, deadline: null, afk_a: 0, afk_b: 0 });
    expect(resolveMatch(db, id, 110_000)).toBe(false);
    expect(startNextRound(db, id, 103_999)).toBe(false);
    expect(startNextRound(db, id, 120_000)).toBe(true); // Late alarm starts a full window at actual processing time.
    expect(matchForSession(db, id, a).deadline).toBe(130_000);
    expect(matchForSession(db, id, b).deadline).toBe(130_000);
    expect(() => next(id, a, 1)).toThrow('automatically');
    expect(db.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(id)).toEqual({ count: 1 });
  });

  it.each([false, true])('linearizes a second-lock/deadline race, deadline-first=%s', (deadlineFirst) => {
    const { id, a, b } = human(); lock(id, a);
    if (deadlineFirst) {
      vi.setSystemTime(110_000);
      expect(() => lock(id, b)).toThrow('no longer');
      expect(matchForSession(db, id, b).lastResult?.outcomes[matchForSession(db, id, b).player!].reason).toBe('automatic-pass');
    } else { vi.setSystemTime(109_999); lock(id, b); }
    expect(resolveMatch(db, id, 110_000)).toBe(false);
    expect(() => lockAction(db, id, b, pass, 1, 1)).toThrow('no longer');
    expect(db.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(id)).toEqual({ count: 1 });
  });

  it('early accepted commitments do not use a future/null deadline for disconnect forfeits', () => {
    const actor = session('human'); const id = createBotMatch(db, actor, 'Human', 'practice');
    db.prepare('UPDATE matches SET disconnect_a = 3, disconnect_b = 3 WHERE id = ?').run(id);
    lock(id, actor);
    expect(getMatch(db, id)).toMatchObject({ status: 'review', result_type: null, afk_a: 0, afk_b: 0 });
  });

  it('bot decisions depend only on the identical public opening, revealed history, difficulty and seed', () => {
    const decisions: Action[] = [];
    for (const choice of [{ type: 'expand', target: 2 }, { type: 'expand', target: 10 }, pass] as Action[]) {
      const actor = session(`human-${decisions.length}`);
      const id = createBotMatch(db, actor, 'Human', 'practice', 'hard');
      db.prepare('UPDATE matches SET player_a_key = ?, player_b_key = ? WHERE id = ?').run(actor.id, `bot:${id}`, id);
      lock(id, actor, choice);
      decisions.push(matchForSession(db, id, actor).lastResult!.outcomes.B.action);
    }
    const expected = chooseBotAction(createInitialState(), 'B', 'hard', [], 1);
    expect(decisions).toEqual([expected, expected, expected]);
  });

  it('new restarts and rematches opt in even when their parent is legacy; legacy bot Next is rejected', () => {
    const actor = session('human'); const old = createBotMatch(db, actor, 'Human', 'practice');
    db.prepare("UPDATE matches SET policy_version = 1, progression = 'automatic', decision_duration_ms = 5000, reveal_duration_ms = 1000 WHERE id = ?").run(old);
    lock(old, actor);
    expect(getMatch(db, old)).toMatchObject({ status: 'transition', transition_at: 101_000 });
    expect(() => next(old, actor, 1)).toThrow('automatically');
    const restarted = createBotMatch(db, actor, 'Human', 'practice', 'easy', undefined, randomUUID(), old);
    expect(getMatch(db, old)?.status).toBe('voided');
    expect(getMatch(db, restarted)).toMatchObject({ policy_version: 2, progression: 'review' });
    resignMatch(db, restarted, actor);
    const rematch = createBotMatch(db, actor, 'Human', 'practice', 'easy', restarted);
    expect(getMatch(db, rematch)).toMatchObject({ policy_version: 2, progression: 'review' });
    expect(getMatch(db, rematch)?.player_a_key === actor.id).toBe(getMatch(db, restarted)?.player_b_key === actor.id);
  });

  it.each(['decision', 'transition', 'grace', 'readying'])('migration/reinitialization keeps a legacy %s record and pending moves untouched', (status) => {
    const { id } = human();
    db.prepare("UPDATE matches SET policy_version = 1, decision_duration_ms = 5000, reveal_duration_ms = 1000, status = ?, transition_at = 101000, grace_until = 120000 WHERE id = ?").run(status, id);
    const before = getMatch(db, id);
    db.prepare("INSERT INTO pending_actions VALUES (?, 1, 'A', ?, 100001)").run(id, JSON.stringify(pass));
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    initializeDatabase(db);
    expect(getMatch(db, id)).toEqual(before);
    expect(db.prepare('SELECT action_json, locked_at FROM pending_actions WHERE match_id = ?').get(id)).toEqual({ action_json: JSON.stringify(pass), locked_at: 100001 });
  });

  it.each([1, 2])('Ranked readiness retains shell policy version %s at activation', (version) => {
    for (const uid of ['rank-a', 'rank-b']) db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, 1)').run(uid, uid, uid);
    const shell = createRankedShell(db, 'rank-a', 'rank-b');
    if (version === 1) db.prepare('UPDATE matches SET policy_version = 1, decision_duration_ms = 5000, reveal_duration_ms = 1000 WHERE id = ?').run(shell.matchId);
    markRankedReadyPresence(db, shell.matchId, 'rank-a', true); markRankedReadyPresence(db, shell.matchId, 'rank-b', true);
    expect(acknowledgeRankedReady(db, shell.matchId, 'rank-a').state).toBe('readying');
    expect(acknowledgeRankedReady(db, shell.matchId, 'rank-b').state).toBe('active');
    expect(getMatch(db, shell.matchId)).toMatchObject({ policy_version: version, deadline: version === 1 ? 105_000 : 110_000 });
  });

  it.each([12, 13, 15])('terminal round %s settles once and cannot open another round', (round) => {
    const { id, a, b } = human();
    const state = { ...createInitialState(), round, phase: round > 12 ? 'sudden-death' as const : 'standard' as const };
    if (round !== 15) state.board = state.board.map((cell, index) => index === 2 ? 'A' : cell);
    db.prepare('UPDATE matches SET state_json = ? WHERE id = ?').run(JSON.stringify(state), id);
    lock(id, a); lock(id, b);
    expect(getMatch(db, id)?.status).toBe('finished');
    expect(startNextRound(db, id, 1_000_000)).toBe(false);
    expect(dueMatches(db, 1_000_000)).toEqual([]);
    expect(settlePendingRankedMatches(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(id)).toEqual({ count: 1 });
  });
});
