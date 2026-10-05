import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState, type RoundResult } from '../shared/rules';
import { RevealPanel, roundActionsDisabled, snapshotKeepsRoundLocked } from './App';

const result: RoundResult = {
  state: createInitialState(),
  score: { A: 4, B: 4 },
  outcomes: {
    A: { action: { type: 'surge', target: 12 }, success: false, reason: 'collision', energySpent: 1, energyEarned: 0 },
    B: { action: { type: 'expand', target: 12 }, success: false, reason: 'collision', energySpent: 0, energyEarned: 0 },
  },
};

describe('in-match round feedback', () => {
  it('keeps a round summary non-modal while a decision is open', () => {
    const html = renderToStaticMarkup(<RevealPanel result={result} player="A" finalRound={false}
      activeRoundOpen onContinue={() => undefined} />);
    expect(html).toContain('role="region"');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('aria-modal');
    expect(html).toContain('Hide result');
    expect(html).toContain('Spent 1 Energy');
  });

  it('shows who won and labels both scores in the last-round reveal', () => {
    const completed: RoundResult = {
      ...result,
      state: { ...result.state, status: 'finished', winner: 'B' },
      score: { A: 11, B: 13 },
    };
    const html = renderToStaticMarkup(<RevealPanel result={completed} player="A" finalRound
      activeRoundOpen={false} onContinue={() => undefined} />);
    expect(html).toContain('Rival wins');
    expect(html).toContain('Territory score: you 11, rival 13');
    expect(html).toContain('<small>You</small>');
    expect(html).toContain('<small>Rival</small>');
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
