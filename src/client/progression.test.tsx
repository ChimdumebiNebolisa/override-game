import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeaderboardList, ProfileStats, RankedSettlementDetails, RivalsPanel } from './App';

describe('Ranked progression displays', () => {
  it('shows only placement progress before the fifth qualifying match', () => {
    const profile = renderToStaticMarkup(<ProfileStats profile={{ handle: 'Placing', placementProgress: 4 }} />);
    expect(profile).toContain('4/5');
    expect(profile).not.toContain('Peak RP');
    expect(profile).not.toContain('Global rank');
    expect(profile).not.toContain('W-L-D');

    const result = renderToStaticMarkup(<RankedSettlementDetails
      settlement={{ multiplier: 1, player: { outcome: 'win', placementProgress: 4 } }}
      profile={{ handle: 'Placing', placementProgress: 4 }}
    />);
    expect(result).toContain('Placement');
    expect(result).toContain('4/5');
    expect(result).toContain('Full competitive credit');
    expect(result).not.toContain('RP change');
    expect(result).not.toContain('Rating');
    expect(result).not.toContain('Tier');
    expect(result).not.toContain('Next Rival');
  });

  it('reveals the new rating on placement completion without exposing the prior provisional value', () => {
    const result = renderToStaticMarkup(<RankedSettlementDetails
      settlement={{ multiplier: 1, player: { outcome: 'win', placementProgress: 5, ratingAfter: 1032 } }}
      profile={{ handle: 'Placed', placementProgress: 5, rating: 1032, peakRating: 1032, ratedMatchCount: 5,
        wins: 5, losses: 0, draws: 0, streak: 5, tier: 'Silver', rank: 12 }}
    />);
    expect(result).toContain('Rating');
    expect(result).toContain('1032');
    expect(result).toContain('Silver');
    expect(result).toContain('#12');
    expect(result).toContain('Next Rival');
    expect(result).not.toContain('RP change');
    expect(result).not.toContain('→');
  });

  it('shows complete human leaderboard records and does not invent personalized Rival progress', () => {
    const board = renderToStaticMarkup(<LeaderboardList entries={[{
      handle: 'Alpha', rating: 1400, rank: 1, tier: 'Platinum', wins: 7, losses: 2, draws: 1, streak: 3,
    }]} />);
    expect(board).toContain('W-L-D 7-2-1');
    expect(board).toContain('Streak 3');

    const anonymous = renderToStaticMarkup(<RivalsPanel />);
    expect(anonymous).toContain('Complete placement to unlock personalized Rival progress.');
    expect(anonymous).not.toContain('RP away');
    expect(renderToStaticMarkup(<RivalsPanel rating={1300} />)).toContain('100 RP away');
  });
});
