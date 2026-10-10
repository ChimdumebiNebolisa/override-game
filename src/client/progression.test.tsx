import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeaderboardList, ProfileStats, RankedSettlementDetails, RivalsPanel } from './App';

describe('Ranked progression displays', () => {
  it('shows only placement progress before the second qualifying match', () => {
    const profile = renderToStaticMarkup(<ProfileStats profile={{ handle: 'Placing', placementProgress: 1 }} />);
    expect(profile).toContain('1/2');
    expect(profile).not.toContain('Peak RP');
    expect(profile).not.toContain('Global rank');
    expect(profile).not.toContain('W-L-D');

    const result = renderToStaticMarkup(<RankedSettlementDetails
      settlement={{ multiplier: 1, player: { outcome: 'win', placementProgress: 1 } }}
      profile={{ handle: 'Placing', placementProgress: 1 }}
    />);
    expect(result).toContain('Placement');
    expect(result).toContain('1/2');
    expect(result).toContain('Full competitive credit');
    expect(result).not.toContain('RP change');
    expect(result).not.toContain('Rating');
    expect(result).not.toContain('Tier');
    expect(result).not.toContain('Next Rival');
  });

  it('reveals the new rating on placement completion without exposing the prior provisional value', () => {
    const result = renderToStaticMarkup(<RankedSettlementDetails
      settlement={{ multiplier: 1, player: { outcome: 'win', placementProgress: 2, ratingAfter: 1032 } }}
      profile={{ handle: 'Placed', placementProgress: 2, rating: 1032, peakRating: 1032, ratedMatchCount: 2,
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

  it('shows complete human records and the same clearly labeled, descending bot standings', () => {
    const board = renderToStaticMarkup(<LeaderboardList entries={[{
      handle: 'Alpha', rating: 1400, rank: 1, tier: 'Platinum', wins: 7, losses: 2, draws: 1, streak: 3,
    }]} />);
    expect(board).toContain('7 wins · 2 losses · 1 draw');
    expect(board).toContain('3 wins in a row');

    const withoutStreak = renderToStaticMarkup(<LeaderboardList entries={[{
      handle: 'Rookie', rating: 900, rank: 2, tier: 'Bronze', wins: 1, losses: 0, draws: 0, streak: 0,
    }]} />);
    expect(withoutStreak).toContain('1 win · 0 losses · 0 draws');
    expect(withoutStreak).toContain('No current win streak');

    const anonymous = renderToStaticMarkup(<RivalsPanel />);
    expect(anonymous).toContain('Shared practice standings');
    expect(anonymous).toContain('Bot leaderboard');
    expect(anonymous).toContain('aria-label="Practice bot leaderboard"');
    expect(anonymous).toContain('ava_chen');
    expect(anonymous).toContain('mila_stone');
    expect([...anonymous.matchAll(/<b>#(\d+)<\/b>/g)].map(([, rank]) => Number(rank)))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect([...anonymous.matchAll(/class="bot-tag"/g)]).toHaveLength(20);
    expect(anonymous).not.toContain('RP away');
    expect(anonymous).not.toContain('Complete placement');
  });
});
