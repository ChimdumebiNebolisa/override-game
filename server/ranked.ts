import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assessCompetitiveCredit, settleRatedMatch, type RatingProfile, type RatingSettlement } from '../src/shared/rating.js';
import { createInitialState, type MatchState, type Player } from '../src/shared/rules.js';
import { HttpError } from './http.js';
import { initializeHumanPresence } from './matches.js';

const READY_WINDOW_MS = 15_000;
const QUEUE_LEASE_MS = 60_000;
const SEARCH_WINDOW_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MUTUAL_INCIDENT_THRESHOLD = 3;
const MUTUAL_INCIDENT_WINDOW_MS = DAY_MS;
const MUTUAL_INCIDENT_COOLDOWN_MS = 15 * 60 * 1000;

interface RankedProfileRow extends RatingProfile {
  uid: string;
  handle: string | null;
}

interface OwnershipRow {
  uid: string;
  state: 'searching' | 'match_shell' | 'active_match';
  match_id: string | null;
  lease_expires_at: number | null;
}

interface QueueRow {
  uid: string;
  joined_at: number;
  rating: number;
}

interface MatchShellRow {
  id: string;
  mode: string;
  player_a_key: string;
  player_b_key: string;
  status: string;
  ready_deadline: number | null;
  ready_a: number;
  ready_b: number;
  ready_connected_a: number;
  ready_connected_b: number;
  started_at: number | null;
  competitive_multiplier: number | null;
  credit_assessed_at: number | null;
  state_json: string;
  result_type: string | null;
  disconnected_a_at: number | null;
  disconnected_b_at: number | null;
}

export interface RankedQueueResult {
  state: 'searching' | 'readying' | 'active' | 'cooldown';
  matchId: string | null;
  /** Safe to show before ready; contains no opponent identity or rating. */
  competitiveMultiplier: number | null;
  readyDeadline: number | null;
  cooldownUntil?: number;
}

export interface RankedShell {
  matchId: string;
  competitiveMultiplier: number;
  creditAssessedAt: number;
  readyDeadline: number;
}

export interface PublicRankedSettlement {
  multiplier: number;
  player: {
    outcome: 'win' | 'loss' | 'draw';
    placementProgress: number;
    delta?: number;
    ratingBefore?: number;
    ratingAfter?: number;
  };
}

function profile(db: Database.Database, uid: string): RankedProfileRow {
  const row = db.prepare(`SELECT uid, handle, rating, peak_rating AS peakRating,
      placement_progress AS placementProgress, rated_match_count AS ratedMatchCount,
      wins, losses, draws, streak FROM profiles WHERE uid = ?`)
    .get(uid) as RankedProfileRow | undefined;
  if (!row) throw new HttpError(401, 'Sign in with Google first');
  if (!row.handle) throw new HttpError(409, 'Choose a handle before Ranked');
  return row;
}

function ownership(db: Database.Database, uid: string): OwnershipRow | undefined {
  return db.prepare('SELECT uid, state, match_id, lease_expires_at FROM ranked_ownership WHERE uid = ?')
    .get(uid) as OwnershipRow | undefined;
}

function rankedMatch(db: Database.Database, id: string): MatchShellRow | undefined {
  return db.prepare(`SELECT id, mode, player_a_key, player_b_key, status, ready_deadline, ready_a, ready_b,
      ready_connected_a, ready_connected_b,
      started_at, competitive_multiplier, credit_assessed_at, state_json, result_type,
      disconnected_a_at, disconnected_b_at
    FROM matches WHERE id = ?`).get(id) as MatchShellRow | undefined;
}

function queueResultFor(db: Database.Database, uid: string): RankedQueueResult | null {
  const owned = ownership(db, uid);
  if (!owned) return null;
  if (owned.state === 'searching') return { state: 'searching', matchId: null, competitiveMultiplier: null, readyDeadline: null };
  if (!owned.match_id) return null;
  const match = rankedMatch(db, owned.match_id);
  if (!match) return null;
  return {
    state: match.started_at === null ? 'readying' : match.status === 'finished' ? 'active' : 'active',
    matchId: match.id,
    competitiveMultiplier: match.competitive_multiplier,
    readyDeadline: match.ready_deadline,
  };
}

function mutualIncidentCooldownUntil(db: Database.Database, uid: string, now: number): number | null {
  const incidents = db.prepare(`SELECT created_at FROM disconnect_incidents
    WHERE uid = ? AND created_at > ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`)
    .all(uid, now - MUTUAL_INCIDENT_WINDOW_MS, now, MUTUAL_INCIDENT_THRESHOLD) as { created_at: number }[];
  if (incidents.length < MUTUAL_INCIDENT_THRESHOLD) return null;
  const until = incidents[0].created_at + MUTUAL_INCIDENT_COOLDOWN_MS;
  return now < until ? until : null;
}

/** Current queue/match state, or null when this account has no lease and no active cooldown. */
export function rankedQueueStatus(db: Database.Database, uid: string, now = Date.now()): RankedQueueResult | null {
  return db.transaction((): RankedQueueResult | null => {
    expireStaleSearchingInTransaction(db, now);
    expireDueReadyShellsInTransaction(db, now);
    const result = queueResultFor(db, uid);
    if (result) {
      if (result.state === 'searching') {
        db.prepare("UPDATE ranked_ownership SET lease_expires_at = ? WHERE uid = ? AND state = 'searching'")
          .run(now + QUEUE_LEASE_MS, uid);
        return pairSearchingInTransaction(db, uid, profile(db, uid), now);
      }
      return result;
    }
    const cooldownUntil = mutualIncidentCooldownUntil(db, uid, now);
    return cooldownUntil === null
      ? null
      : { state: 'cooldown', matchId: null, competitiveMultiplier: null, readyDeadline: null, cooldownUntil };
  }).immediate();
}

function pairHistory(db: Database.Database, uidA: string, uidB: string) {
  const rows = db.prepare(`SELECT started_at, status, result_type FROM matches
    WHERE mode = 'ranked' AND started_at IS NOT NULL AND
      ((player_a_key = ? AND player_b_key = ?) OR (player_a_key = ? AND player_b_key = ?))`)
    .all(uidA, uidB, uidB, uidA) as { started_at: number; status: string; result_type: string | null }[];
  return rows.map((row) => ({
    startedAt: row.started_at,
    status: row.status === 'voided' || row.result_type === 'no-contest' ? 'voided' as const : 'bound' as const,
  }));
}

function createShellInTransaction(db: Database.Database, uidA: string, uidB: string, now: number): RankedShell {
  if (!uidA || !uidB || uidA === uidB) throw new HttpError(400, 'Ranked requires two different players');
  const a = profile(db, uidA);
  const b = profile(db, uidB);
  const ownedA = ownership(db, uidA);
  const ownedB = ownership(db, uidB);
  for (const owned of [ownedA, ownedB]) {
    if (owned && owned.state !== 'searching') throw new HttpError(409, 'A player already has an active Ranked match');
  }

  const matchId = randomUUID();
  const readyDeadline = now + READY_WINDOW_MS;
  const assessment = assessCompetitiveCredit({
    assessedAt: now,
    playerA: { id: a.uid, profile: a },
    playerB: { id: b.uid, profile: b },
    pairHistory: pairHistory(db, uidA, uidB),
  });
  const firstIsA = randomInt(2) === 0;
  const playerA = firstIsA ? a : b;
  const playerB = firstIsA ? b : a;

  db.prepare(`INSERT INTO matches (id, room_id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, deadline, transition_at, ready_deadline, ready_a, ready_b, started_at, credit_assessed_at,
      competitive_multiplier, revision)
    VALUES (?, NULL, 'ranked', ?, ?, 'Ranked Player', 'Ranked Player', ?, 'readying', NULL, NULL, ?, 0, 0, NULL, ?, ?, 0)`)
    .run(matchId, playerA.uid, playerB.uid, JSON.stringify(createInitialState()), readyDeadline, now, assessment.multiplier);

  for (const participant of [playerA, playerB]) {
    db.prepare(`INSERT INTO ranked_ownership (uid, state, match_id, lease_expires_at) VALUES (?, 'match_shell', ?, ?)
      ON CONFLICT(uid) DO UPDATE SET state = 'match_shell', match_id = excluded.match_id,
        lease_expires_at = excluded.lease_expires_at`)
      .run(participant.uid, matchId, readyDeadline);
    db.prepare('DELETE FROM ranked_queue WHERE uid = ?').run(participant.uid);
  }
  return { matchId, competitiveMultiplier: assessment.multiplier, creditAssessedAt: now, readyDeadline };
}

/** Create a Ranked shell for a challenge or a queue pairing, assessing repeat credit at shell creation. */
export function createRankedShell(db: Database.Database, uidA: string, uidB: string, now = Date.now()): RankedShell {
  return db.transaction(() => createShellInTransaction(db, uidA, uidB, now)).immediate();
}

function expireStaleSearchingInTransaction(db: Database.Database, now: number): void {
  const expired = db.prepare(`SELECT o.uid FROM ranked_ownership o
    LEFT JOIN ranked_queue q ON q.uid = o.uid
    WHERE o.state = 'searching' AND (o.lease_expires_at <= ? OR q.joined_at <= ? OR q.uid IS NULL)`)
    .all(now, now - SEARCH_WINDOW_MS) as { uid: string }[];
  for (const { uid } of expired) {
    db.prepare('DELETE FROM ranked_queue WHERE uid = ?').run(uid);
    db.prepare("DELETE FROM ranked_ownership WHERE uid = ? AND state = 'searching'").run(uid);
  }
}

function expireDueReadyShellsInTransaction(db: Database.Database, now: number): string[] {
  const due = db.prepare(`SELECT id FROM matches WHERE mode = 'ranked' AND status = 'readying'
    AND started_at IS NULL AND ready_deadline <= ?`).all(now) as { id: string }[];
  const expired: string[] = [];
  for (const { id } of due) if (expireRankedReadyInTransaction(db, id, now)) expired.push(id);
  return expired;
}

/** Remove timed-out searches and readying shells; bound-match ownership is never lease-expired. */
export function expireRankedLeases(db: Database.Database, now = Date.now()): string[] {
  return db.transaction(() => {
    expireStaleSearchingInTransaction(db, now);
    return expireDueReadyShellsInTransaction(db, now);
  }).immediate();
}

function currentResult(db: Database.Database, uid: string): RankedQueueResult | null {
  const result = queueResultFor(db, uid);
  if (!result) return null;
  return result;
}

function pairSearchingInTransaction(db: Database.Database, uid: string, ownProfile: RankedProfileRow, now: number): RankedQueueResult {
  const ownQueue = db.prepare('SELECT uid, joined_at, rating FROM ranked_queue WHERE uid = ?').get(uid) as QueueRow | undefined;
  if (!ownQueue) throw new HttpError(409, 'Ranked queue lease expired');
  const waited = Math.max(0, now - ownQueue.joined_at);
  const radius = waited < 5_000 ? 150 : waited < 10_000 ? 300 : null;
  const candidates = db.prepare(`SELECT q.uid, q.joined_at, q.rating FROM ranked_queue q
    JOIN ranked_ownership o ON o.uid = q.uid AND o.state = 'searching'
    WHERE q.uid <> ? AND (? IS NULL OR ABS(q.rating - ?) <= ?)
    ORDER BY q.joined_at ASC, q.uid ASC`)
    .all(uid, radius, ownQueue.rating, radius) as QueueRow[];

  const rankedCandidates = candidates.map((candidate) => {
    const candidateProfile = profile(db, candidate.uid);
    const assessment = assessCompetitiveCredit({
      assessedAt: now,
      playerA: { id: ownProfile.uid, profile: ownProfile },
      playerB: { id: candidate.uid, profile: candidateProfile },
      pairHistory: pairHistory(db, uid, candidate.uid),
    });
    return { candidate, multiplier: assessment.multiplier };
  }).sort((left, right) => right.multiplier - left.multiplier || left.candidate.joined_at - right.candidate.joined_at);

  if (rankedCandidates.length) {
    const selected = rankedCandidates[0].candidate;
    const shell = createShellInTransaction(db, uid, selected.uid, now);
    return { state: 'readying', matchId: shell.matchId, competitiveMultiplier: shell.competitiveMultiplier, readyDeadline: shell.readyDeadline };
  }
  return { state: 'searching', matchId: null, competitiveMultiplier: null, readyDeadline: null };
}

/** Join (or resume) the single Ranked queue lease for this UID and pair atomically when eligible. */
export function joinRankedQueue(db: Database.Database, uid: string, now = Date.now(), admitNewWork?: () => void): RankedQueueResult {
  return db.transaction((): RankedQueueResult => {
    expireStaleSearchingInTransaction(db, now);
    expireDueReadyShellsInTransaction(db, now);
    const current = ownership(db, uid);
    if (current && current.state !== 'searching') return currentResult(db, uid)!;
    const ownProfile = profile(db, uid);
    const cooldownUntil = mutualIncidentCooldownUntil(db, uid, now);
    if (cooldownUntil !== null) {
      throw new HttpError(429, `Ranked queue cooldown active until ${cooldownUntil}`);
    }
    if (!current) {
      admitNewWork?.();
      db.prepare(`INSERT INTO ranked_ownership (uid, state, match_id, lease_expires_at)
        VALUES (?, 'searching', NULL, ?)`)
        .run(uid, now + QUEUE_LEASE_MS);
      db.prepare('INSERT INTO ranked_queue (uid, joined_at, rating) VALUES (?, ?, ?)')
        .run(uid, now, ownProfile.rating);
    } else {
      db.prepare("UPDATE ranked_ownership SET lease_expires_at = ? WHERE uid = ? AND state = 'searching'")
        .run(now + QUEUE_LEASE_MS, uid);
    }

    return pairSearchingInTransaction(db, uid, ownProfile, now);
  }).immediate();
}

/** Leave only a searching queue; once a shell exists, use its ready timeout or active match flow. */
export function leaveRankedQueue(db: Database.Database, uid: string): boolean {
  return db.transaction(() => {
    const current = ownership(db, uid);
    if (!current || current.state !== 'searching') return false;
    db.prepare('DELETE FROM ranked_queue WHERE uid = ?').run(uid);
    db.prepare("DELETE FROM ranked_ownership WHERE uid = ? AND state = 'searching'").run(uid);
    return true;
  }).immediate();
}

function expireRankedReadyInTransaction(db: Database.Database, matchId: string, now: number): boolean {
  const match = rankedMatch(db, matchId);
  if (!match || match.mode !== 'ranked' || match.status !== 'readying' || match.started_at !== null ||
      match.ready_deadline === null || now < match.ready_deadline) return false;
  const changed = db.prepare(`UPDATE matches SET status = 'voided', result_type = 'ready-timeout', ended_at = ?,
      ready_deadline = NULL, revision = revision + 1
    WHERE id = ? AND status = 'readying' AND started_at IS NULL AND ready_deadline <= ?`).run(now, matchId, now);
  if (changed.changes !== 1) return false;
  db.prepare('DELETE FROM ranked_ownership WHERE match_id = ? AND state = \'match_shell\'').run(matchId);
  return true;
}

/** Cancel a shell when its fixed 15-second ready deadline has elapsed. */
export function expireRankedReady(db: Database.Database, matchId: string, now = Date.now()): boolean {
  return db.transaction(() => expireRankedReadyInTransaction(db, matchId, now)).immediate();
}

function bindReadyMatchInTransaction(db: Database.Database, match: MatchShellRow, now: number): boolean {
  if (!match.ready_a || !match.ready_b || !match.ready_connected_a || !match.ready_connected_b) return false;
  const a = profile(db, match.player_a_key);
  const b = profile(db, match.player_b_key);
  const bound = db.prepare(`UPDATE matches SET status = 'decision', started_at = ?, deadline = ?, ready_deadline = NULL,
      player_a_name = ?, player_b_name = ?, revision = revision + 1
    WHERE id = ? AND status = 'readying' AND started_at IS NULL AND ready_a = 1 AND ready_b = 1
      AND ready_connected_a = 1 AND ready_connected_b = 1 AND ready_deadline > ?`)
    .run(now, now + 5_000, a.handle, b.handle, match.id, now);
  if (bound.changes !== 1) return false;
  initializeHumanPresence(db, match.id, now);
  db.prepare(`UPDATE ranked_ownership SET state = 'active_match', lease_expires_at = NULL
    WHERE match_id = ? AND state = 'match_shell'`).run(match.id);
  return true;
}

/** Record a participant's arena connection while its Ranked shell is awaiting ready acknowledgements. */
export function markRankedReadyPresence(db: Database.Database, matchId: string, uid: string, connected: boolean, now = Date.now()): boolean {
  return db.transaction(() => {
    const match = rankedMatch(db, matchId);
    if (!match || match.mode !== 'ranked') return false;
    const column = match.player_a_key === uid ? 'ready_connected_a' : match.player_b_key === uid ? 'ready_connected_b' : null;
    if (!column || match.status !== 'readying' || match.started_at !== null) return false;
    db.prepare(`UPDATE matches SET ${column} = ?, revision = revision + 1
      WHERE id = ? AND status = 'readying' AND started_at IS NULL`).run(connected ? 1 : 0, matchId);
    const updated = rankedMatch(db, matchId)!;
    return connected && bindReadyMatchInTransaction(db, updated, now);
  }).immediate();
}

/** Socket presence is process-local, so a restart must not reuse it to bind an existing shell. */
export function clearRankedReadyPresenceOnStartup(db: Database.Database): void {
  db.prepare(`UPDATE matches SET ready_connected_a = 0, ready_connected_b = 0, revision = revision + 1
    WHERE mode = 'ranked' AND status = 'readying' AND started_at IS NULL
      AND (ready_connected_a <> 0 OR ready_connected_b <> 0)`).run();
}

/** Acknowledge ready; only two connected participants atomically bind the match and open Round 1. */
export function acknowledgeRankedReady(db: Database.Database, matchId: string, uid: string, now = Date.now()): RankedQueueResult {
  let expired = false;
  const result = db.transaction((): RankedQueueResult | null => {
    const match = rankedMatch(db, matchId);
    if (!match || match.mode !== 'ranked') throw new HttpError(404, 'Ranked match not found');
    const side: Player | null = match.player_a_key === uid ? 'A' : match.player_b_key === uid ? 'B' : null;
    if (!side) throw new HttpError(404, 'Ranked match not found');
    if (match.status !== 'readying' || match.started_at !== null || match.ready_deadline === null) {
      if (match.started_at !== null) return { state: 'active', matchId, competitiveMultiplier: match.competitive_multiplier, readyDeadline: null };
      throw new HttpError(409, 'Ranked match is no longer accepting ready confirmations');
    }
    if (now >= match.ready_deadline) {
      expireRankedReadyInTransaction(db, matchId, now);
      expired = true;
      return null;
    }
    const readyColumn = side === 'A' ? 'ready_a' : 'ready_b';
    db.prepare(`UPDATE matches SET ${readyColumn} = 1, revision = revision + 1 WHERE id = ? AND status = 'readying'`)
      .run(matchId);
    const updated = rankedMatch(db, matchId)!;
    if (!bindReadyMatchInTransaction(db, updated, now)) {
      return { state: 'readying', matchId, competitiveMultiplier: updated.competitive_multiplier, readyDeadline: updated.ready_deadline } as RankedQueueResult;
    }
    return { state: 'active', matchId, competitiveMultiplier: updated.competitive_multiplier, readyDeadline: null } as RankedQueueResult;
  }).immediate();
  if (expired) throw new HttpError(409, 'Ranked ready window expired');
  if (!result) throw new HttpError(409, 'Ranked ready window expired');
  return result;
}

function profileFromRow(row: Record<string, unknown>): RatingProfile {
  return {
    rating: Number(row.rating), peakRating: Number(row.peak_rating),
    placementProgress: Number(row.placement_progress), ratedMatchCount: Number(row.rated_match_count),
    wins: Number(row.wins), losses: Number(row.losses), draws: Number(row.draws), streak: Number(row.streak),
  };
}

function writeProfile(db: Database.Database, uid: string, value: RatingProfile): void {
  db.prepare(`UPDATE profiles SET rating = ?, peak_rating = ?, placement_progress = ?, rated_match_count = ?,
      wins = ?, losses = ?, draws = ?, streak = ? WHERE uid = ?`)
    .run(value.rating, value.peakRating, value.placementProgress, value.ratedMatchCount,
      value.wins, value.losses, value.draws, value.streak, uid);
}

/** Settle a bound terminal match exactly once, returning the saved settlement on retries. */
export function settleRankedMatch(db: Database.Database, matchId: string, now = Date.now()): RatingSettlement {
  return db.transaction(() => {
    const existing = db.prepare('SELECT settlement_json FROM rating_settlements WHERE match_id = ?')
      .get(matchId) as { settlement_json: string } | undefined;
    if (existing) {
      db.prepare(`INSERT INTO settlement_duplicate_attempts (match_id, attempts, first_attempt_at, last_attempt_at)
        VALUES (?, 1, ?, ?) ON CONFLICT(match_id) DO UPDATE SET
        attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at`).run(matchId, now, now);
      return JSON.parse(existing.settlement_json) as RatingSettlement;
    }

    const match = rankedMatch(db, matchId);
    if (!match || match.mode !== 'ranked') throw new HttpError(404, 'Ranked match not found');
    if (match.status !== 'finished' || match.started_at === null) throw new HttpError(409, 'Ranked match is not a bound terminal result');
    if (match.competitive_multiplier === null || match.credit_assessed_at === null) {
      throw new HttpError(500, 'Ranked credit assessment is missing');
    }
    const state = JSON.parse(match.state_json) as MatchState;
    const kind = match.result_type === 'no-contest' ? 'no-contest'
      : match.result_type === 'forfeit' ? 'forfeit'
        : match.result_type === 'resignation' ? 'resignation' : 'result';
    const winner = state.winner;
    const outcomeA = kind === 'no-contest' || winner === null ? 'draw' : winner === 'A' ? 'win' : 'loss';
    const outcomeB = kind === 'no-contest' || winner === null ? 'draw' : winner === 'B' ? 'win' : 'loss';
    const aRow = db.prepare('SELECT * FROM profiles WHERE uid = ?').get(match.player_a_key) as Record<string, unknown> | undefined;
    const bRow = db.prepare('SELECT * FROM profiles WHERE uid = ?').get(match.player_b_key) as Record<string, unknown> | undefined;
    if (!aRow || !bRow) throw new HttpError(500, 'Ranked profiles are missing');
    const settlement = settleRatedMatch({
      playerA: { id: match.player_a_key, profile: profileFromRow(aRow) },
      playerB: { id: match.player_b_key, profile: profileFromRow(bRow) },
      outcomeA,
      outcomeB,
      multiplier: match.competitive_multiplier,
      kind,
    });

    if (kind !== 'no-contest') {
      writeProfile(db, match.player_a_key, settlement.playerA.updatedProfile);
      writeProfile(db, match.player_b_key, settlement.playerB.updatedProfile);
    } else if (match.disconnected_a_at !== null && match.disconnected_b_at !== null) {
      for (const uid of [match.player_a_key, match.player_b_key]) {
        db.prepare('INSERT INTO disconnect_incidents (uid, match_id, created_at) VALUES (?, ?, ?)').run(uid, matchId, now);
      }
    }
    db.prepare('INSERT INTO rating_settlements (match_id, settlement_json, settled_at) VALUES (?, ?, ?)')
      .run(matchId, JSON.stringify(settlement), now);
    db.prepare('DELETE FROM settlement_failures WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM ranked_ownership WHERE match_id = ?').run(matchId);
    return settlement;
  }).immediate();
}

/** Retry terminal results left without a ledger by an interrupted server process. */
export function settlePendingRankedMatches(db: Database.Database, now = Date.now()): string[] {
  const pending = db.prepare(`SELECT m.id FROM matches m
    LEFT JOIN rating_settlements s ON s.match_id = m.id
    WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL
      AND s.match_id IS NULL
    ORDER BY m.ended_at, m.id LIMIT 100`).all() as { id: string }[];
  const resolved: string[] = [];
  for (const { id } of pending) {
    try {
      settleRankedMatch(db, id, now);
      resolved.push(id);
    } catch (error) {
      const invalidResult = error instanceof SyntaxError || error instanceof RangeError ||
        (error instanceof HttpError && error.status === 500);
      try {
        let attempts = 0;
        const voided = db.transaction(() => {
          db.prepare(`INSERT INTO settlement_failures (match_id, attempts, first_failed_at, last_failed_at)
            VALUES (?, 1, ?, ?) ON CONFLICT(match_id) DO UPDATE SET
            attempts = attempts + 1, last_failed_at = excluded.last_failed_at`).run(id, now, now);
          const failure = db.prepare('SELECT attempts, first_failed_at FROM settlement_failures WHERE match_id = ?')
            .get(id) as { attempts: number; first_failed_at: number };
          attempts = failure.attempts;
          if (!invalidResult || failure.attempts < 3 || now - failure.first_failed_at < 2_000) return false;
          const match = rankedMatch(db, id);
          if (!match || match.status !== 'finished') return false;
          let state: MatchState;
          try { state = JSON.parse(match.state_json) as MatchState; }
          catch { state = createInitialState(); }
          const voidState = { ...state, status: 'finished', winner: null, endingReason: null };
          db.prepare(`UPDATE matches SET state_json = ?, status = 'voided', result_type = 'server-error',
            revision = revision + 1 WHERE id = ? AND status = 'finished'`)
            .run(JSON.stringify(voidState), id);
          db.prepare('DELETE FROM ranked_ownership WHERE match_id = ?').run(id);
          return true;
        }).immediate();
        if (attempts === 1 || attempts % 60 === 0) {
          console.error(JSON.stringify({ at: new Date(now).toISOString(), event: 'ranked_settlement_retry',
            matchId: id, attempts, error: error instanceof Error ? error.message : 'Unknown error' }));
        }
        if (voided) resolved.push(id);
      } catch (recoveryError) {
        console.error(`Could not record settlement failure for Ranked match ${id}`, recoveryError);
      }
    }
  }
  return resolved;
}

/** Read a previously committed settlement; callers must authorize the match participant first. */
export function getRankedSettlement(db: Database.Database, matchId: string): RatingSettlement | null {
  const row = db.prepare('SELECT settlement_json FROM rating_settlements WHERE match_id = ?')
    .get(matchId) as { settlement_json: string } | undefined;
  return row ? JSON.parse(row.settlement_json) as RatingSettlement : null;
}

/** Return only the requesting player's settlement, withholding provisional rating values until placement completes. */
export function publicRankedSettlement(settlement: RatingSettlement, player: Player): PublicRankedSettlement {
  const own = player === 'A' ? settlement.playerA : settlement.playerB;
  const visible: PublicRankedSettlement = {
    multiplier: settlement.multiplier,
    player: {
      outcome: own.outcome,
      placementProgress: own.updatedProfile.placementProgress,
    },
  };
  if (own.updatedProfile.placementProgress >= 5) {
    visible.player.ratingAfter = own.updatedProfile.rating;
    if (own.profile.placementProgress >= 5) {
      visible.player.delta = own.delta;
      visible.player.ratingBefore = own.profile.rating;
    }
  }
  return visible;
}
