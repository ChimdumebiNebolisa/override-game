import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import { leaderboard, profileView, tierFor } from './progression';

let db: Database.Database | null = null;
afterEach(() => { db?.close(); db = null; });

describe('Ranked progression', () => {
  it('derives every tier from the current rating', () => {
    expect([899, 900, 1099, 1100, 1299, 1300, 1499, 1500, 1699, 1700].map(tierFor))
      .toEqual(['Bronze', 'Silver', 'Silver', 'Gold', 'Gold', 'Platinum', 'Platinum', 'Diamond', 'Diamond', 'Master']);
  });

  it('ranks placed humans and practice bots together and excludes unfinished placements', () => {
    db = openDatabase(':memory:');
    const insert = db.prepare(`INSERT INTO profiles
      (uid, handle, normalized_handle, rating, placement_progress, wins, losses, draws, streak, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    insert.run('a', 'Alpha', 'alpha', 2400, 2, 7, 2, 1, 3);
    insert.run('b', 'Bravo', 'bravo', 2000, 2, 5, 4, 0, 1);
    insert.run('c', 'Charlie', 'charlie', 1800, 2, 3, 3, 2, 0);
    insert.run('unplaced', 'Newbie', 'newbie', 3000, 1, 1, 0, 0, 1);

    const board = leaderboard(db);
    expect(board.entries.slice(0, 9).map((row) => [row.handle, row.rank])).toEqual([
      ['Alpha', 1], ['ava_chen', 2], ['mateo_rivera', 3], ['kai_turner', 4], ['Bravo', 5],
      ['harper_brooks', 6], ['ezra_patel', 7], ['nora_williams', 8], ['Charlie', 9],
    ]);
    expect(board.entries).toHaveLength(23);
    expect(board.entries[0]).toEqual({
      handle: 'Alpha', rating: 2400, rank: 1, tier: 'Master', wins: 7, losses: 2, draws: 1, streak: 3,
    });
    expect(board.entries[1]).toMatchObject({ handle: 'ava_chen', rating: 2196, rank: 2, tier: 'Master', bot: true });
    expect(profileView(db, 'c')).toMatchObject({ rank: 9, tier: 'Master' });
    expect(profileView(db, 'unplaced')).toEqual({
      handle: 'Newbie', placementProgress: 1,
    });
  });

  it('shows the shared bot entries even before any human has completed placement', () => {
    db = openDatabase(':memory:');
    const board = leaderboard(db);
    expect(board.entries).toHaveLength(20);
    expect(board.entries.every((entry) => entry.bot)).toBe(true);
    expect(board.entries.map((entry) => entry.rank)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });
});
