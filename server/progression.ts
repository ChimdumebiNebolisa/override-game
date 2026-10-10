import type Database from 'better-sqlite3';
import { PLACEMENT_MATCHES } from '../src/shared/rating.js';
import { PRACTICE_BOTS } from '../src/shared/leaderboard-bots.js';
import { getPublicProfile } from './auth';
import { HttpError } from './http';

interface PlacedRow {
  uid?: string;
  normalizedHandle: string;
  handle: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bot?: true;
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
  return db.prepare(`SELECT uid, normalized_handle AS normalizedHandle, handle, rating, wins, losses, draws, streak FROM profiles
    WHERE placement_progress >= ? AND handle IS NOT NULL
    ORDER BY rating DESC, normalized_handle ASC`)
    .all(PLACEMENT_MATCHES) as PlacedRow[];
}

function allStandings(db: Database.Database) {
  const bots: PlacedRow[] = PRACTICE_BOTS.map((bot) => ({
    ...bot,
    normalizedHandle: bot.handle.toLowerCase(),
    bot: true,
  }));
  const rows = [...placedPlayers(db), ...bots].sort((a, b) =>
    b.rating - a.rating || a.normalizedHandle.localeCompare(b.normalizedHandle) || Number(Boolean(a.bot)) - Number(Boolean(b.bot)));
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
  if (profile.placementProgress < PLACEMENT_MATCHES || profile.rating === undefined) return profile;
  const ranked = allStandings(db);
  return {
    ...profile,
    tier: tierFor(profile.rating),
    rank: ranked.find((player) => player.uid === uid)?.rank ?? null,
  };
}

export function leaderboard(db: Database.Database) {
  const ranked = allStandings(db);
  const publicRow = ({ handle, rating, rank, tier, wins, losses, draws, streak, bot }: (typeof ranked)[number]) => (
    { handle, rating, rank, tier, wins, losses, draws, streak, ...(bot ? { bot } : {}) }
  );
  return { entries: ranked.map(publicRow) };
}
