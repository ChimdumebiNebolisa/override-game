import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assessCompetitiveCredit,
  kFactor,
  officialRanks,
  roundHalfAwayFromZero,
  settleRatedMatch,
  type PairMatchHistoryEntry,
  type RatingProfile,
  type RatedPlayer,
} from "./rating.js";

const profile = (overrides: Partial<RatingProfile> = {}): RatingProfile => ({
  rating: 1000,
  peakRating: 1000,
  placementProgress: 2,
  ratedMatchCount: 5,
  wins: 0,
  losses: 0,
  draws: 0,
  streak: 0,
  ...overrides,
});

const player = (id: string, overrides: Partial<RatingProfile> = {}): RatedPlayer => ({ id, profile: profile(overrides) });
const at = "2026-10-04T12:00:00.000Z";
const hour = 60 * 60 * 1000;
const matches = (count: number, ageHours = 1): PairMatchHistoryEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    startedAt: Date.parse(at) - (ageHours + i) * hour,
    status: "bound",
  }));

test("rolling 24-hour pair credit has exact established-player boundaries", () => {
  const a = player("a");
  const b = player("b");
  const multiplier = (history: PairMatchHistoryEntry[]) =>
    assessCompetitiveCredit({ assessedAt: at, playerA: a, playerB: b, pairHistory: history }).multiplier;

  assert.equal(multiplier(matches(0)), 1);
  assert.equal(multiplier(matches(2)), 1); // current match is #3
  assert.equal(multiplier(matches(3)), 0.75); // current match is #4
  assert.equal(multiplier(matches(4)), 0.5); // current match is #5
  assert.equal(multiplier(matches(5)), 0); // current match is #6
});

test("window excludes the exact 24-hour boundary, voids, cancellations, and future starts", () => {
  const history: PairMatchHistoryEntry[] = [
    { startedAt: Date.parse(at) - 24 * hour, status: "bound" },
    { startedAt: Date.parse(at) - hour, status: "voided" },
    { startedAt: Date.parse(at) - hour, status: "cancelled" },
    { startedAt: Date.parse(at) + hour, status: "bound" },
    { startedAt: Date.parse(at) - 2 * hour, status: "bound" },
  ];
  const assessment = assessCompetitiveCredit({ assessedAt: at, playerA: player("a"), playerB: player("b"), pairHistory: history });
  assert.equal(assessment.priorMatchesInWindow, 1);
  assert.equal(assessment.multiplier, 1);
});

test("an exhausted placement repeat gives both players zero credit, including established opponent", () => {
  const assessment = assessCompetitiveCredit({
    assessedAt: at,
    playerA: player("placing", { placementProgress: 1 }),
    playerB: player("established"),
    pairHistory: matches(2),
  });
  assert.equal(assessment.reason, "placement-repeat-limit");
  assert.equal(assessment.multiplier, 0);

  const settled = settleRatedMatch({
    playerA: player("placing", { placementProgress: 1 }),
    playerB: player("established"),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: assessment.multiplier,
  });
  assert.deepEqual(settled.playerA.updatedProfile, profile({ placementProgress: 1 }));
  assert.deepEqual(settled.playerB.updatedProfile, profile());
});

test("K stages use placement status and the next rated-match number", () => {
  assert.equal(kFactor(profile({ placementProgress: 1, ratedMatchCount: 99 })), 64);
  assert.equal(kFactor(profile({ placementProgress: 2, ratedMatchCount: 19 })), 32);
  assert.equal(kFactor(profile({ placementProgress: 2, ratedMatchCount: 20 })), 24);
});

test("signed exact halves round away from zero", () => {
  assert.equal(roundHalfAwayFromZero(0.5), 1);
  assert.equal(roundHalfAwayFromZero(-0.5), -1);
  assert.equal(roundHalfAwayFromZero(1.49), 1);
  assert.equal(roundHalfAwayFromZero(-1.5), -2);
});

test("Elo applies each player's K and floors RP at zero", () => {
  const settled = settleRatedMatch({
    playerA: player("a", { rating: 1000, placementProgress: 1, ratedMatchCount: 1 }),
    playerB: player("b", { rating: 1000, placementProgress: 2, ratedMatchCount: 20 }),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: 1,
  });
  assert.equal(settled.playerA.kFactor, 64);
  assert.equal(settled.playerB.kFactor, 24);
  assert.equal(settled.playerA.delta, 32);
  assert.equal(settled.playerB.delta, -12);
  assert.equal(settled.playerA.updatedProfile.rating, 1032);
  assert.equal(settled.playerB.updatedProfile.rating, 988);

  const floor = settleRatedMatch({
    playerA: player("low", { rating: 0, peakRating: 50, ratedMatchCount: 20 }),
    playerB: player("high", { rating: 400, ratedMatchCount: 20 }),
    outcomeA: "loss",
    outcomeB: "win",
    multiplier: 1,
  });
  assert.equal(floor.playerA.delta, -2);
  assert.equal(floor.playerA.updatedProfile.rating, 0);
  assert.equal(floor.playerA.updatedProfile.peakRating, 50);
});

test("full-credit stats and placement update; reduced credit changes RP only", () => {
  const placement = settleRatedMatch({
    playerA: player("a", { placementProgress: 1, ratedMatchCount: 1, streak: 2 }),
    playerB: player("b"),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: 1,
  });
  assert.equal(placement.playerA.updatedProfile.placementProgress, 2);
  assert.equal(placement.playerA.updatedProfile.ratedMatchCount, 2);
  assert.equal(placement.playerA.updatedProfile.wins, 1);
  assert.equal(placement.playerA.updatedProfile.streak, 3);
  assert.equal(placement.playerB.updatedProfile.losses, 1);
  assert.equal(placement.playerB.updatedProfile.streak, 0);

  const reduced = settleRatedMatch({
    playerA: player("a", { streak: 3 }),
    playerB: player("b", { streak: 2 }),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: 0.75,
  });
  assert.equal(reduced.playerA.delta, 12);
  assert.equal(reduced.playerA.updatedProfile.ratedMatchCount, 6);
  assert.equal(reduced.playerA.updatedProfile.wins, 0);
  assert.equal(reduced.playerA.updatedProfile.streak, 3);
  assert.equal(reduced.playerB.updatedProfile.losses, 0);
  assert.equal(reduced.playerB.updatedProfile.streak, 2);
});

test("a qualifying draw resets streak and no-contest changes no competitive fields", () => {
  const draw = settleRatedMatch({
    playerA: player("a", { streak: 4 }),
    playerB: player("b", { streak: 1 }),
    outcomeA: "draw",
    outcomeB: "draw",
    multiplier: 1,
  });
  assert.equal(draw.playerA.updatedProfile.draws, 1);
  assert.equal(draw.playerA.updatedProfile.streak, 0);
  assert.equal(draw.playerB.updatedProfile.streak, 0);

  const forfeit = settleRatedMatch({
    playerA: player("winner", { streak: 4 }),
    playerB: player("forfeiter", { streak: 3 }),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: 1,
    kind: "forfeit",
  });
  assert.equal(forfeit.playerA.updatedProfile.streak, 5);
  assert.equal(forfeit.playerB.updatedProfile.streak, 0);

  const noContest = settleRatedMatch({
    playerA: player("a", { streak: 4 }),
    playerB: player("b", { streak: 1 }),
    outcomeA: "win",
    outcomeB: "loss",
    multiplier: 1,
    kind: "no-contest",
  });
  assert.deepEqual(noContest.playerA.updatedProfile, profile({ streak: 4 }));
  assert.deepEqual(noContest.playerB.updatedProfile, profile({ streak: 1 }));
});

test("official ranks hide unplaced players and share rank on ties", () => {
  assert.deepEqual(
    officialRanks([
      { id: "a", rating: 1400, placementProgress: 2 },
      { id: "b", rating: 1400, placementProgress: 2 },
      { id: "c", rating: 1380, placementProgress: 2 },
      { id: "d", rating: 2000, placementProgress: 1 },
    ]),
    [
      { id: "a", rank: 1 },
      { id: "b", rank: 1 },
      { id: "c", rank: 3 },
      { id: "d", rank: null },
    ],
  );
});
