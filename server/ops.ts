import { existsSync } from 'node:fs';
import { databasePath, openDatabase } from './db';

if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
const db = openDatabase();
try {
  const now = Date.now();
  const ids = (sql: string, cutoff: number) => (db.prepare(sql).all(cutoff) as { id: string }[]).map((row) => row.id);
  const report = {
    checkedAt: now,
    overdueDecision: ids("SELECT id FROM matches WHERE status = 'decision' AND deadline < ?", now - 5_000),
    overdueTransition: ids("SELECT id FROM matches WHERE status = 'transition' AND transition_at < ?", now - 5_000),
    overdueGrace: ids("SELECT id FROM matches WHERE status = 'grace' AND grace_until < ?", now - 5_000),
    stuckReadyShells: ids("SELECT id FROM matches WHERE status = 'readying' AND ready_deadline < ?", now - 5_000),
    expiredQueueLeases: (db.prepare("SELECT uid FROM ranked_ownership WHERE state = 'searching' AND lease_expires_at < ?")
      .all(now - 5_000) as { uid: string }[]).map((row) => row.uid),
    timedOutSearches: (db.prepare(`SELECT uid FROM ranked_queue WHERE joined_at < ?`)
      .all(now - 20_000) as { uid: string }[]).map((row) => row.uid),
    unsettledRanked: (db.prepare(`SELECT m.id FROM matches m LEFT JOIN rating_settlements s ON s.match_id = m.id
      WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL AND s.match_id IS NULL`)
      .all() as { id: string }[]).map((row) => row.id),
    settlementRetryFailures: db.prepare(`SELECT f.match_id AS matchId, f.attempts,
      f.first_failed_at AS firstFailedAt, f.last_failed_at AS lastFailedAt, m.status
      FROM settlement_failures f JOIN matches m ON m.id = f.match_id
      ORDER BY f.last_failed_at DESC`).all(),
    duplicateSettlementAttempts: db.prepare(`SELECT d.match_id AS matchId, d.attempts,
      d.first_attempt_at AS firstAttemptAt, d.last_attempt_at AS lastAttemptAt
      FROM settlement_duplicate_attempts d ORDER BY d.last_attempt_at DESC`).all(),
    rankedVoids: (db.prepare("SELECT COUNT(*) AS count FROM matches WHERE mode = 'ranked' AND status = 'voided'")
      .get() as { count: number }).count,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
