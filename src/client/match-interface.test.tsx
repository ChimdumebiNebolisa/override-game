import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState, resolveRound, type RoundResult } from '../shared/rules';
import { energyEffect, finalResultExplanation, RevealPanel, roundActionsDisabled, snapshotKeepsRoundLocked } from './App';

const result: RoundResult = {
  state: createInitialState(),
  score: { A: 4, B: 4 },
  outcomes: {
    A: { action: { type: 'surge', target: 12 }, success: false, reason: 'collision', energySpent: 3, energyEarned: 0 },
    B: { action: { type: 'expand', target: 12 }, success: false, reason: 'collision', energySpent: 0, energyEarned: 0 },
  },
};

describe('in-match round feedback', () => {
  it.each([1, 6, 12, 13, 15])('labels the actual resolved round %i from the rules result', (round) => {
    const before = { ...createInitialState(), round, phase: round > 12 ? 'sudden-death' as const : 'standard' as const };
    const resolved = resolveRound(before, {
      A: round === 12 || round === 13 ? { type: 'expand', target: 10 } : { type: 'pass' }, B: { type: 'pass' },
    });
    const html = renderToStaticMarkup(<RevealPanel result={resolved} player="A"
      finalRound={resolved.state.status === 'finished'} activeRoundOpen={false} onContinue={() => undefined} />);
    expect(html).toContain(`Round ${round} resolved.`);
  });
  it('keeps a round summary non-modal while a decision is open', () => {
    const html = renderToStaticMarkup(<RevealPanel result={result} player="A" finalRound={false}
      activeRoundOpen onContinue={() => undefined} />);
    expect(html).toContain('role="region"');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('aria-modal');
    expect(html).toContain('Hide result');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="reveal-actions is-compact"');
    expect(html).toContain('Spent 3 Energy');
  });
  it('starts with a short summary and keeps detailed accounting optional', () => {
    const html = renderToStaticMarkup(<RevealPanel result={result} player="A" finalRound={false}
      activeRoundOpen={false} onContinue={() => undefined} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Spent 3 Energy');
    expect(html).toContain('Collided; the node stayed neutral');
  });

  it('keeps the last-round reveal focused on moves without repeating the match winner or score', () => {
    const completed: RoundResult = {
      ...result,
      state: { ...result.state, status: 'finished', winner: 'B' },
      score: { A: 11, B: 13 },
    };
    const html = renderToStaticMarkup(<RevealPanel result={completed} player="A" finalRound
      activeRoundOpen={false} onContinue={() => undefined} />);
    expect(html).toContain('YOU');
    expect(html).toContain('RIVAL');
    expect(html).not.toContain('Rival wins');
    expect(html).not.toContain('reveal-score');
    expect(html).not.toContain('Next round');
    expect(html).not.toContain('See result');
  });

  it('explains a successful Ambush defeat using final territory, not the move outcome', () => {
    const board = Array.from({ length: 25 }, (_, index) => index < 11 ? 'A' as const : index < 23 ? 'B' as const : 'neutral' as const);
    const match = { ...createInitialState(), board, status: 'finished' as const, winner: 'B' as const };
    const last = { ...result, state: match, outcomes: { ...result.outcomes, A: { ...result.outcomes.A, action: { type: 'ambush' as const, target: 3 }, reason: 'ambush-hit' as const } } };
    expect(finalResultExplanation(match, 'A', 'standard', last)).toBe('Your Ambush stopped their Expand, but they finished ahead, 12–11. Ambush doesn’t capture territory.');
    const captured = { ...last, outcomes: { ...last.outcomes, A: { ...last.outcomes.A, cells: [{ target: 3, success: true, reason: 'ambush-hit' as const }] } } };
    expect(finalResultExplanation(match, 'A', 'standard', captured)).toBe('Your Ambush captured a space, but they finished ahead, 12–11. The final territory score decides the winner.');
    const html = renderToStaticMarkup(<RevealPanel result={captured} player="A" finalRound activeRoundOpen={false} onContinue={() => undefined} />);
    expect(html).toContain('Blocked the Expand and captured the space');
    const historical = renderToStaticMarkup(<RevealPanel result={last} player="A" finalRound activeRoundOpen={false} onContinue={() => undefined} />);
    expect(historical).toContain('Blocked the Expand; the space stayed empty');
    expect(finalResultExplanation(match, 'A', 'forfeit', last)).toBe('The match ended by forfeit.');
    expect(finalResultExplanation(match, 'A', 'resignation', last)).toBe('The match ended by resignation.');
    expect(finalResultExplanation({ ...match, winner: 'A' }, 'A', 'standard', last)).toContain('You finished with more territory');
    expect(finalResultExplanation({ ...match, winner: null }, 'A', 'sudden-death', null)).toContain('means a draw');
    expect(finalResultExplanation(match, 'A', 'server-error', last)).toContain('Match voided');
    expect(finalResultExplanation(match, 'A', 'no-contest', last)).toContain('Neither player');
  });

  it('reports actual rewards, miss penalties and rival drains, including historical results', () => {
    const hit = { ...result.outcomes.A, action: { type: 'ambush' as const, target: 12 }, reason: 'ambush-hit' as const, energySpent: 0, energyEarned: 0, energyDrained: 2 };
    expect(energyEffect(hit)).toBe('Rival lost 2 Energy · Energy was full; none earned');
    expect(energyEffect(result.outcomes.B, 0.5)).toBe('Lost 0.5 Energy to Ambush');
    expect(energyEffect({ ...hit, reason: 'ambush-missed', energySpent: 1, energyDrained: 0 })).toBe('Miss penalty: −1 Energy');
    expect(energyEffect(result.outcomes.B)).toBe('No Energy change');
    const legacyExpand = { ...result.outcomes.B, success: true, reason: 'claimed' as const };
    expect(energyEffect(legacyExpand)).toBe('No Energy change');
    expect(energyEffect(legacyExpand, 0, true)).toBe('Energy was full; none earned');
  });

  it('does not call a previous round or a no-contest a terminal draw', () => {
    for (const state of [result.state, { ...result.state, status: 'finished' as const, winner: null, endingReason: null }]) {
      const html = renderToStaticMarkup(<RevealPanel result={{ ...result, state }} player="A" finalRound
        activeRoundOpen={false} onContinue={() => undefined} />);
      expect(html).not.toContain('The match is tied');
    }
  });

  it('keeps board actions available as soon as the authoritative next decision opens', () => {
    expect(roundActionsDisabled('decision', false)).toBe(false);
    expect(roundActionsDisabled('decision', true)).toBe(true);
    expect(roundActionsDisabled('transition', false)).toBe(true);
  });

  it('does not let an equal-revision unlocked poll undo this player’s confirmed lock', () => {
    expect(snapshotKeepsRoundLocked({ status: 'decision', snapshotLocked: false, locking: false, lockedRound: 7, round: 7 })).toBe(true);
    expect(snapshotKeepsRoundLocked({ status: 'decision', snapshotLocked: false, locking: false, lockedRound: 7, round: 8 })).toBe(false);
  });

  it('keeps the action locked while a lock request is still pending', () => {
    expect(snapshotKeepsRoundLocked({ status: 'decision', snapshotLocked: false, locking: true, lockedRound: null, round: 7 })).toBe(true);
  });
});
