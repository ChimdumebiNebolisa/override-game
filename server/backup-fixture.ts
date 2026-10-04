import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { settleRankedMatch } from './ranked.js';
import { createInitialState, resolveRound } from '../src/shared/rules.js';

const db = openDatabase();
const matchId = `backup-${randomUUID()}`;
const now = Date.now();
try {
  const playerA = `${matchId}-a`;
  const playerB = `${matchId}-b`;
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run(playerA, 'BackupAlpha', `${playerA}-handle`, now);
  db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run(playerB, 'BackupBeta', `${playerB}-handle`, now);
  const result = resolveRound(createInitialState({ standardRounds: 1, suddenDeathRounds: 0 }), {
    A: { type: 'expand', target: 2 },
    B: { type: 'pass' },
  });
  if (result.state.status !== 'finished' || result.state.winner !== 'A') {
    throw new Error('Backup fixture did not produce its expected finished result');
  }
  db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
    state_json, status, started_at, ended_at, last_result_json, credit_assessed_at,
    competitive_multiplier, result_type)
    VALUES (?, 'ranked', ?, ?, 'BackupAlpha', 'BackupBeta', ?, 'finished', ?, ?, ?, ?, 1, 'standard')`)
    .run(matchId, playerA, playerB, JSON.stringify(result.state), now - 1_000, now,
      JSON.stringify(result), now - 1_000);
  db.prepare('INSERT INTO round_results (match_id, round, result_json, resolved_at) VALUES (?, ?, ?, ?)')
    .run(matchId, result.state.round, JSON.stringify(result), now);
  settleRankedMatch(db, matchId, now);
  process.stdout.write(`${matchId}\n`);
} finally {
  db.close();
}
