import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { settleRankedMatch } from './ranked.js';

const matchId = process.argv[2];
if (!matchId) throw new Error('Pass the Ranked match ID created for the backup fixture');
const db = openDatabase();
try {
  const match = db.prepare(`SELECT mode, status, result_type, state_json, last_result_json,
    player_a_key, player_b_key FROM matches WHERE id = ?`).get(matchId) as {
      mode: string; status: string; result_type: string; state_json: string; last_result_json: string;
      player_a_key: string; player_b_key: string;
    } | undefined;
  assert.ok(match, 'restored Ranked match exists');
  assert.deepEqual({ mode: match.mode, status: match.status, resultType: match.result_type }, {
    mode: 'ranked', status: 'finished', resultType: 'standard',
  });
  const resultRow = db.prepare('SELECT result_json FROM round_results WHERE match_id = ? AND round = 1')
    .get(matchId) as { result_json: string } | undefined;
  assert.ok(resultRow, 'resolved round result exists');
  const replay = JSON.parse(resultRow.result_json);
  assert.deepEqual(replay, JSON.parse(match.last_result_json));
  assert.deepEqual(replay.state, JSON.parse(match.state_json));

  const ratingsBefore = db.prepare(`SELECT uid, rating, rated_match_count, wins, losses, draws, streak
    FROM profiles WHERE uid IN (?, ?) ORDER BY uid`).all(match.player_a_key, match.player_b_key);
  settleRankedMatch(db, matchId);
  const ratingsAfter = db.prepare(`SELECT uid, rating, rated_match_count, wins, losses, draws, streak
    FROM profiles WHERE uid IN (?, ?) ORDER BY uid`).all(match.player_a_key, match.player_b_key);
  assert.deepEqual(ratingsAfter, ratingsBefore, 'replaying settlement does not change ratings or records');
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(matchId),
    { count: 1 });
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM round_results WHERE match_id = ?').get(matchId),
    { count: 1 });
  process.stdout.write(`Restored and replayed ${matchId} without changing settlement results\n`);
} finally {
  db.close();
}
