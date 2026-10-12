import type Database from 'better-sqlite3';
import { createInitialState } from '../src/shared/rules';

const GUEST_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Remove expired guest data and old invite tokens while keeping Ranked match and settlement records. */
export function pruneExpiredGuestData(db: Database.Database, now = Date.now()) {
  const cutoff = now - GUEST_RETENTION_MS;
  return db.transaction(() => {
    const abandoned = db.prepare(`SELECT m.id, m.state_json FROM matches m
      WHERE m.mode <> 'ranked' AND m.bot_difficulty IS NOT NULL
      AND m.status IN ('decision', 'transition', 'review', 'grace')
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.expires_at > ?
        AND (s.id = m.player_a_key OR s.id = m.player_b_key))`).all(now) as { id: string; state_json: string }[];
    for (const row of abandoned) {
      let state;
      try { state = JSON.parse(row.state_json); }
      catch { state = createInitialState(); }
      db.prepare(`UPDATE matches SET state_json = ?, status = 'voided', result_type = 'session-expired',
        deadline = NULL, transition_at = NULL, grace_until = NULL, ended_at = ?, revision = revision + 1
        WHERE id = ?`).run(JSON.stringify({ ...state, status: 'finished', winner: null, endingReason: null }), now, row.id);
      db.prepare('DELETE FROM pending_actions WHERE match_id = ?').run(row.id);
    }
    const telemetry = db.prepare('DELETE FROM telemetry_events WHERE created_at < ?').run(cutoff).changes;
    db.prepare('DELETE FROM join_attempts WHERE window_started_at < ?').run(now - 5 * 60_000);
    const challengeAttempts = db.prepare('DELETE FROM ranked_code_attempts WHERE window_started_at <= ?').run(now - 60_000).changes;
    const invitations = db.prepare('DELETE FROM quick_rematch_invitations WHERE expires_at < ?').run(cutoff).changes
      + db.prepare('DELETE FROM ranked_invitations WHERE expires_at < ?').run(cutoff).changes;
    let matches = 0;
    for (;;) {
      const leaves = db.prepare(`SELECT m.id FROM matches m WHERE m.mode <> 'ranked'
        AND m.status IN ('finished', 'voided') AND m.ended_at < ?
        AND NOT EXISTS (SELECT 1 FROM matches child WHERE child.parent_match_id = m.id OR child.restart_match_id = m.id)
        LIMIT 100`).all(cutoff) as { id: string }[];
      if (!leaves.length) break;
      for (const { id } of leaves) {
        db.prepare('DELETE FROM pending_actions WHERE match_id = ?').run(id);
        db.prepare('DELETE FROM round_results WHERE match_id = ?').run(id);
        db.prepare('DELETE FROM round_acknowledgements WHERE match_id = ?').run(id);
        db.prepare('DELETE FROM presence_events WHERE match_id = ?').run(id);
        matches += db.prepare('DELETE FROM matches WHERE id = ?').run(id).changes;
      }
    }
    const rooms = db.prepare(`DELETE FROM rooms WHERE status IN ('finished', 'expired') AND expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.room_id = rooms.id)`).run(cutoff).changes;
    const sessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM quick_rematch_invitations i
        WHERE i.creator_session_id = sessions.id OR i.invitee_session_id = sessions.id)`).run(now).changes;
    return { telemetry, invitations, challengeAttempts, matches, rooms, sessions, abandonedMatches: abandoned.length };
  }).immediate();
}
