import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, resolveRound, type Action } from '../shared/rules';
import type { PublicMatch } from './api';
import { acknowledgeLearning, beginLearning, COMPLETION_KEY, loadLearning, observeLearning, readFlag, saveLearning, WELCOME_KEY, writeFlag } from './learning';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
});
afterEach(() => vi.unstubAllGlobals());
const pass: Action = { type: 'pass' };
function view(id: string, round: number, action: Action | null, terminal = false): PublicMatch {
  const result = resolveRound({ ...createInitialState(), round, config: { standardRounds: terminal ? round : 12, suddenDeathRounds: 0, energyCap: 3 } }, { A: action, B: pass });
  return { id, mode: 'practice', botDifficulty: 'easy', timed: false, roomId: null, player: 'A', playerNames: { A: 'You', B: 'Bot' },
    state: result.state, score: { ...result.score }, status: terminal ? 'finished' : 'review', deadline: null, serverNow: 1,
    revision: round + 1, locked: false, lastResult: result, resultType: terminal ? 'standard' : null, competitiveMultiplier: null };
}
describe('learning completion evidence', () => {
  it('an initial decision with no result or pending acknowledgement never completes learning', () => {
    const run = beginLearning('opening');
    const opening = { ...view('opening', 1, pass), state: createInitialState(), status: 'decision' as const, lastResult: null };
    expect(observeLearning(run, opening)).toEqual(run);
    expect(acknowledgeLearning(run, null as unknown as number)).toEqual(run);
    expect(readFlag(COMPLETION_KEY)).toBeNull();
  });
  it('requires legal Expand resolution, its Next, independent manual lock and explicit second acknowledgement', () => {
    let run = beginLearning('core');
    const first = view('core', 1, { type: 'expand', target: 2 });
    run = observeLearning(run, first);
    expect(run).toMatchObject({ expandRound: 1, expandAcknowledged: false, completed: false });
    expect(observeLearning(run, first)).toEqual(run);
    run = acknowledgeLearning(run, 1);
    expect(run.expandAcknowledged).toBe(true);
    run = observeLearning(run, view('core', 2, pass));
    expect(run).toMatchObject({ independentRound: 2, completed: false });
    saveLearning(run);
    expect(readFlag(COMPLETION_KEY)).toBeNull();
    run = acknowledgeLearning(loadLearning('core')!, 2);
    saveLearning(run);
    expect(run.completed).toBe(true);
    expect(readFlag(COMPLETION_KEY)).toBe('completed');
  });
  it('does not treat welcome dismissal, other matches, selection, alternative initial moves or timeouts as completion', () => {
    const run = beginLearning('intro');
    writeFlag(WELCOME_KEY, 'handled');
    expect(observeLearning(run, view('other', 1, { type: 'expand', target: 2 }))).toEqual(run);
    expect(observeLearning(run, view('intro', 1, pass))).toEqual(run);
    expect(observeLearning(run, view('intro', 1, null))).toEqual(run);
    const first = acknowledgeLearning(observeLearning(run, view('intro', 1, { type: 'expand', target: 2 })), 1);
    expect(observeLearning(first, view('intro', 2, null)).independentRound).toBeNull();
    expect(first.completed).toBe(false);
  });
  it('counts intercepted and collided legal Expand introductions without manufacturing captures', () => {
    for (const opponent of [{ type: 'ambush', target: 2 }, { type: 'expand', target: 2 }] as Action[]) {
      const state = { ...createInitialState(), board: createInitialState().board.map((cell, index) => index === 3 ? 'B' as const : cell) };
      const result = resolveRound(state, { A: { type: 'expand', target: 2 }, B: opponent });
      const snapshot = { ...view('blocked', 1, pass), lastResult: result, state: result.state };
      expect(result.state.board[2]).toBe('neutral');
      expect(observeLearning(beginLearning('blocked'), snapshot).expandRound).toBe(1);
    }
  });
  it('skip freezes unfinished progress, replay resets only its run and preserves earned completion', () => {
    const initial = beginLearning('skip');
    const skipped = { ...initial, skipped: true };
    expect(observeLearning(skipped, view('skip', 1, { type: 'expand', target: 2 }))).toEqual(skipped);
    expect(acknowledgeLearning(skipped, 1)).toEqual(skipped);
    saveLearning({ ...initial, completed: true });
    const replay = beginLearning('replay');
    expect(replay.completed).toBe(false);
    expect(readFlag(COMPLETION_KEY)).toBe('completed');
  });
  it('a lost Next response reconciles the same acknowledged result only once', () => {
    let run = observeLearning(beginLearning('lost'), view('lost', 1, { type: 'expand', target: 2 }));
    run = { ...run, pendingAcknowledgement: 1 };
    saveLearning(run);
    expect(observeLearning(loadLearning('lost')!, view('lost', 1, { type: 'expand', target: 2 })).expandAcknowledged).toBe(false);
    const opened = { ...view('lost', 1, { type: 'expand', target: 2 }), status: 'decision' as const };
    run = observeLearning(run, opened);
    expect(run.expandAcknowledged).toBe(true);
    expect(observeLearning(run, opened)).toEqual(run);
    expect(acknowledgeLearning(run, 99).completed).toBe(false);
  });
  it('terminal second results are acknowledged by exit/start-duel without another round', () => {
    let run = acknowledgeLearning(observeLearning(beginLearning('terminal'), view('terminal', 1, { type: 'expand', target: 2 })), 1);
    const final = view('terminal', 2, { type: 'expand', target: 2 }, true);
    run = observeLearning(run, final);
    expect(run.independentRound).toBe(2);
    expect(acknowledgeLearning(run, 2).completed).toBe(true);
    expect(final.status).toBe('finished');
  });
  it('uses an in-tab fallback when storage throws and rejects malformed stored runs', () => {
    vi.stubGlobal('window', { localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
    const run = beginLearning('no-storage');
    expect(loadLearning('no-storage')).toEqual(run);
    writeFlag('override:learning:v1:bad', '{"version":1,"matchId":"bad"}');
    expect(loadLearning('bad')).toBeNull();
  });
});
