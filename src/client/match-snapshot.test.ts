import { describe, expect, it } from 'vitest';
import { snapshotIsCurrent } from './api';

describe('match snapshot revisions', () => {
  it('rejects a delayed older response after a newer snapshot has arrived', () => {
    const latest = { revision: 12, status: 'finished' };
    const delayedActionResponse = { revision: 11, status: 'decision' };

    expect(snapshotIsCurrent(latest, 10)).toBe(true);
    expect(snapshotIsCurrent(delayedActionResponse, latest.revision)).toBe(false);
  });

  it('allows an idempotent response at the current revision', () => {
    expect(snapshotIsCurrent({ revision: 12 }, 12)).toBe(true);
  });
});
