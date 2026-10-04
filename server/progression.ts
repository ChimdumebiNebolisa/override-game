import type Database from 'better-sqlite3';
import { getPublicProfile } from './auth';
import { HttpError } from './http';

interface PlacedRow {
  uid: string;
  handle: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
}

export function tierFor(rating: number): string {
  if (rating >= 1700) return 'Master';
  if (rating >= 1500) return 'Diamond';
  if (rating >= 1300) return 'Platinum';
  if (rating >= 1100) return 'Gold';
  if (rating >= 900) return 'Silver';
  return 'Bronze';
}

function placedPlayers(db: Database.Database): PlacedRow[] {
  return db.prepare(`SELECT uid, handle, rating, wins, losses, draws, streak FROM profiles
    WHERE placement_progress >= 5 AND handle IS NOT NULL
    ORDER BY rating DESC, normalized_handle ASC`)
    .all() as PlacedRow[];
}

function withRanks(rows: PlacedRow[]) {
  let rank = 0;
  let previousRating: number | null = null;
  return rows.map((row, index) => {
    if (row.rating !== previousRating) rank = index + 1;
    previousRating = row.rating;
    return { ...row, rank, tier: tierFor(row.rating) };
  });
}

export function profileView(db: Database.Database, uid: string) {
  const profile = getPublicProfile(db, uid);
  if (!profile) throw new HttpError(404, 'Profile not found');
  if (profile.placementProgress < 5 || profile.rating === undefined) return profile;
  const ranked = withRanks(placedPlayers(db));
  return {
    ...profile,
    tier: tierFor(profile.rating),
    rank: ranked.find((player) => player.uid === uid)?.rank ?? null,
  };
}

export function leaderboard(db: Database.Database, uid: string | null) {
  const ranked = withRanks(placedPlayers(db));
  const position = uid ? ranked.findIndex((player) => player.uid === uid) : -1;
  const publicRow = ({ handle, rating, rank, tier, wins, losses, draws, streak }: (typeof ranked)[number]) => (
    { handle, rating, rank, tier, wins, losses, draws, streak }
  );
  return {
    top: ranked.slice(0, 20).map(publicRow),
    around: position < 0 ? [] : ranked.slice(Math.max(0, position - 2), position + 3).map(publicRow),
    selfRank: position < 0 ? null : ranked[position].rank,
  };
}
