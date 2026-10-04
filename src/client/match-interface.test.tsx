import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState, type RoundResult } from '../shared/rules';
import { RevealPanel, roundActionsDisabled } from './App';

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

  it('keeps board actions available as soon as the authoritative next decision opens', () => {
    expect(roundActionsDisabled('decision', false)).toBe(false);
    expect(roundActionsDisabled('decision', true)).toBe(true);
    expect(roundActionsDisabled('transition', false)).toBe(true);
  });
});
