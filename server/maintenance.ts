import type Database from 'better-sqlite3';

const GUEST_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Remove expired guest data and old invite tokens while keeping Ranked match and settlement records. */
export function pruneExpiredGuestData(db: Database.Database, now = Date.now()) {
  const cutoff = now - GUEST_RETENTION_MS;
  return db.transaction(() => {
    const telemetry = db.prepare('DELETE FROM telemetry_events WHERE created_at < ?').run(cutoff).changes;
    db.prepare('DELETE FROM join_attempts WHERE window_started_at < ?').run(now - 5 * 60_000);
    const invitations = db.prepare('DELETE FROM quick_rematch_invitations WHERE expires_at < ?').run(cutoff).changes
      + db.prepare('DELETE FROM ranked_invitations WHERE expires_at < ?').run(cutoff).changes;
    let matches = 0;
    for (;;) {
      const leaves = db.prepare(`SELECT m.id FROM matches m WHERE m.mode <> 'ranked'
        AND m.status IN ('finished', 'voided') AND m.ended_at < ?
        AND NOT EXISTS (SELECT 1 FROM matches child WHERE child.parent_match_id = m.id)
        LIMIT 100`).all(cutoff) as { id: string }[];
      if (!leaves.length) break;
      for (const { id } of leaves) {
        db.prepare('DELETE FROM pending_actions WHERE match_id = ?').run(id);
        db.prepare('DELETE FROM round_results WHERE match_id = ?').run(id);
        db.prepare('DELETE FROM presence_events WHERE match_id = ?').run(id);
        matches += db.prepare('DELETE FROM matches WHERE id = ?').run(id).changes;
      }
    }
    const rooms = db.prepare(`DELETE FROM rooms WHERE status IN ('finished', 'expired') AND expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.room_id = rooms.id)`).run(cutoff).changes;
    const sessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM quick_rematch_invitations i
        WHERE i.creator_session_id = sessions.id OR i.invitee_session_id = sessions.id)`).run(now).changes;
    return { telemetry, invitations, matches, rooms, sessions };
  }).immediate();
}
