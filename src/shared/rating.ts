const PLACEMENT_MATCHES = 5;

type MatchOutcome = "win" | "loss" | "draw";
type SettlementKind = "result" | "resignation" | "forfeit" | "no-contest";

export interface RatingProfile {
  rating: number;
  peakRating: number;
  placementProgress: number;
  ratedMatchCount: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
}

export interface RatedPlayer {
  id: string;
  profile: RatingProfile;
}

/** A same-pair Ranked match, recorded once it binds. */
export interface PairMatchHistoryEntry {
  startedAt: string | number;
  status: "bound" | "voided" | "cancelled";
}

export interface CreditAssessmentInput {
  assessedAt: string | number;
  playerA: RatedPlayer;
  playerB: RatedPlayer;
  /** Prior matches between this exact pair; pre-binding cancellations and voids are ignored. */
  pairHistory: readonly PairMatchHistoryEntry[];
}

export interface CreditAssessment {
  multiplier: number;
  reason: "placement" | "placement-repeat-limit" | "established-repeat";
  priorMatchesInWindow: number;
  assessedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value: string | number): number {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new RangeError(`Invalid timestamp: ${value}`);
  return time;
}

function inPlacement(profile: RatingProfile): boolean {
  return profile.placementProgress < PLACEMENT_MATCHES;
}

/**
 * Freeze a pair's credit when the shell is created. The rolling window is the
 * 24 hours strictly before assessedAt; a match exactly 24 hours old is out.
 */
export function assessCompetitiveCredit(input: CreditAssessmentInput): CreditAssessment {
  const assessedAt = timestamp(input.assessedAt);
  const cutoff = assessedAt - DAY_MS;
  const priorMatchesInWindow = input.pairHistory.filter((match) => {
    if (match.status !== "bound") return false;
    const startedAt = timestamp(match.startedAt);
    return startedAt > cutoff && startedAt <= assessedAt;
  }).length;

  if (inPlacement(input.playerA.profile) || inPlacement(input.playerB.profile)) {
    return priorMatchesInWindow >= 2
      ? { multiplier: 0, reason: "placement-repeat-limit", priorMatchesInWindow, assessedAt }
      : { multiplier: 1, reason: "placement", priorMatchesInWindow, assessedAt };
  }

  const multiplier =
    priorMatchesInWindow < 3 ? 1 : priorMatchesInWindow === 3 ? 0.75 : priorMatchesInWindow === 4 ? 0.5 : 0;
  return { multiplier, reason: "established-repeat", priorMatchesInWindow, assessedAt };
}

export function kFactor(profile: RatingProfile): 64 | 32 | 24 {
  if (inPlacement(profile)) return 64;
  return profile.ratedMatchCount < 20 ? 32 : 24;
}

export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Cannot round a non-finite value");
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

function expectedScore(ownRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - ownRating) / 400));
}

function actualScore(outcome: MatchOutcome): number {
  if (outcome === "win") return 1;
  if (outcome === "draw") return 0.5;
  return 0;
}

interface SettlementPlayerResult {
  id: string;
  profile: RatingProfile;
  outcome: MatchOutcome;
  kFactor: 64 | 32 | 24;
  expectedScore: number;
  rawDelta: number;
  adjustedDelta: number;
  delta: number;
  updatedProfile: RatingProfile;
}

export interface RatingSettlement {
  multiplier: number;
  playerA: SettlementPlayerResult;
  playerB: SettlementPlayerResult;
}

export interface SettleRatedMatchInput {
  playerA: RatedPlayer;
  playerB: RatedPlayer;
  outcomeA: MatchOutcome;
  outcomeB: MatchOutcome;
  multiplier: number;
  kind?: SettlementKind;
}

function settlePlayer(
  player: RatedPlayer,
  opponent: RatedPlayer,
  outcome: MatchOutcome,
  multiplier: number,
  kind: SettlementKind,
): SettlementPlayerResult {
  const profile = player.profile;
  const k = kFactor(profile);
  const expected = expectedScore(profile.rating, opponent.profile.rating);
  const rawDelta = k * (actualScore(outcome) - expected);
  const adjustedDelta = rawDelta * multiplier;
  const delta = roundHalfAwayFromZero(adjustedDelta);
  const credited = multiplier > 0 && kind !== "no-contest";
  const updatedRating = credited ? Math.max(0, profile.rating + delta) : profile.rating;
  const updatedProfile: RatingProfile = {
    ...profile,
    rating: updatedRating,
    peakRating: Math.max(profile.peakRating, updatedRating),
    placementProgress:
      credited && inPlacement(profile) ? Math.min(PLACEMENT_MATCHES, profile.placementProgress + 1) : profile.placementProgress,
    ratedMatchCount: credited ? profile.ratedMatchCount + 1 : profile.ratedMatchCount,
    wins: profile.wins + (credited && multiplier === 1 && outcome === "win" ? 1 : 0),
    losses: profile.losses + (credited && multiplier === 1 && outcome === "loss" ? 1 : 0),
    draws: profile.draws + (credited && multiplier === 1 && outcome === "draw" ? 1 : 0),
    streak: !credited || multiplier !== 1
      ? profile.streak
      : outcome === "win"
        ? profile.streak + 1
        : 0,
  };

  return { id: player.id, profile, outcome, kFactor: k, expectedScore: expected, rawDelta, adjustedDelta, delta, updatedProfile };
}

/** Calculate both sides independently from the same pre-match ratings. */
export function settleRatedMatch(input: SettleRatedMatchInput): RatingSettlement {
  if (!Number.isFinite(input.multiplier) || input.multiplier < 0 || input.multiplier > 1) {
    throw new RangeError("Competitive multiplier must be between 0 and 1");
  }
  if (input.outcomeA === "win" && input.outcomeB !== "loss" || input.outcomeA === "loss" && input.outcomeB !== "win" ||
      input.outcomeA === "draw" && input.outcomeB !== "draw") {
    throw new RangeError("Player outcomes must be complementary");
  }
  const kind = input.kind ?? "result";
  const multiplier = kind === "no-contest" ? 0 : input.multiplier;
  return {
    multiplier,
    playerA: settlePlayer(input.playerA, input.playerB, input.outcomeA, multiplier, kind),
    playerB: settlePlayer(input.playerB, input.playerA, input.outcomeB, multiplier, kind),
  };
}

export interface LeaderboardPlayer {
  id: string;
  rating: number;
  placementProgress: number;
}

export interface OfficialRank {
  id: string;
  rank: number | null;
}

/** Placed players share a competition rank; unplaced players have no official rank. */
export function officialRanks(players: readonly LeaderboardPlayer[]): OfficialRank[] {
  const eligible = players.filter((player) => player.placementProgress >= PLACEMENT_MATCHES);
  return players.map((player) => ({
    id: player.id,
    rank:
      player.placementProgress < PLACEMENT_MATCHES
        ? null
        : 1 + eligible.filter((other) => other.rating > player.rating).length,
  }));
}
