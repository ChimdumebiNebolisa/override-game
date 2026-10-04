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

  it('gives placed humans competition ranks and excludes unfinished placements', () => {
    db = openDatabase(':memory:');
    const insert = db.prepare(`INSERT INTO profiles
      (uid, handle, normalized_handle, rating, placement_progress, created_at)
      VALUES (?, ?, ?, ?, ?, 1)`);
    insert.run('a', 'Alpha', 'alpha', 1400, 5);
    insert.run('b', 'Bravo', 'bravo', 1400, 5);
    insert.run('c', 'Charlie', 'charlie', 1380, 5);
    insert.run('unplaced', 'Newbie', 'newbie', 2000, 4);

    const board = leaderboard(db, 'c');
    expect(board.top.map((row) => [row.handle, row.rank])).toEqual([
      ['Alpha', 1], ['Bravo', 1], ['Charlie', 3],
    ]);
    expect(board.selfRank).toBe(3);
    expect(board.around.map((row) => row.handle)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(profileView(db, 'unplaced').rank).toBeNull();
  });
});
