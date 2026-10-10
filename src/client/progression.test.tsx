import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeaderboardList, ProfileStats, RankedSettlementDetails } from './App';

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

  it('shows players and BOT-tagged practice entries in the same RP standings table', () => {
    const board = renderToStaticMarkup(<LeaderboardList entries={[
      { handle: 'Alpha', rating: 1400, rank: 1, tier: 'Platinum', wins: 7, losses: 2, draws: 1, streak: 3 },
      { handle: 'ava_chen', rating: 1390, rank: 2, tier: 'Platinum', wins: 42, losses: 8, draws: 0, streak: 0, bot: true },
    ]} />);
    expect(board).toContain('<th scope="col">Rank</th>');
    expect(board).toContain('<th scope="col">Username</th>');
    expect(board).toContain('<th scope="col">Tier</th>');
    expect(board).toContain('<th scope="col">W–L–D</th>');
    expect(board).toContain('<th scope="col">RP</th>');
    expect(board).toContain('aria-label="7 wins, 2 losses, 1 draw"');
    expect(board).toContain('7–2–1');
    expect(board).toContain('<td class="leaderboard-rating">1400</td>');
    expect(board).toContain('<td class="leaderboard-rating">1390</td>');
    expect(board).toContain('<small class="bot-tag">BOT</small>');
    expect([...board.matchAll(/<th scope="row" class="leaderboard-rank">#(\d+)<\/th>/g)].map(([, rank]) => Number(rank)))
      .toEqual([1, 2]);
    expect(board).not.toContain('streak');
  });
});
