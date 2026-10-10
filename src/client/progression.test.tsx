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

  it('shows labeled standings in Rank, Username, Tier, W–L–D, XP columns without streak overhead', () => {
    const board = renderToStaticMarkup(<LeaderboardList entries={[{
      handle: 'Alpha', rating: 1400, rank: 1, tier: 'Platinum', wins: 7, losses: 2, draws: 1, streak: 3,
    }]} />);
    expect(board).toContain('<th scope="col">Rank</th>');
    expect(board).toContain('<th scope="col">Username</th>');
    expect(board).toContain('<th scope="col">Tier</th>');
    expect(board).toContain('<th scope="col">W–L–D</th>');
    expect(board).toContain('<th scope="col">XP</th>');
    expect(board).toContain('aria-label="7 wins, 2 losses, 1 draw"');
    expect(board).toContain('7–2–1');
    expect(board).toContain('<td class="leaderboard-rating">1400</td>');
    expect(board).not.toContain('streak');

    const anonymous = renderToStaticMarkup(<RivalsPanel />);
    expect(anonymous).toContain('Shared practice standings');
    expect(anonymous).toContain('Bot leaderboard');
    expect(anonymous).toContain('aria-label="Practice bot leaderboard"');
    expect(anonymous).toContain('ava_chen');
    expect(anonymous).toContain('mila_stone');
    expect([...anonymous.matchAll(/<th scope="row" class="leaderboard-rank">#(\d+)<\/th>/g)].map(([, rank]) => Number(rank)))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect([...anonymous.matchAll(/class="bot-tag"/g)]).toHaveLength(20);
    expect(anonymous).not.toContain('RP away');
    expect(anonymous).not.toContain('Complete placement');
  });
});
