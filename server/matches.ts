import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createInitialState, resolveRound, score, validateAction,
  type Action, type MatchState, type Player, type RoundResult,
} from '../src/shared/rules';
import { chooseBotAction, type BotDifficulty } from '../src/shared/bots';
import { HttpError, type Session } from './http';

export interface MatchRow {
  id: string;
  room_id: string | null;
  creation_key: string | null;
  parent_match_id: string | null;
  mode: 'quick' | 'ranked' | 'practice';
  bot_difficulty: BotDifficulty | null;
  player_a_key: string;
  player_b_key: string;
  player_a_name: string;
  player_b_name: string;
  state_json: string;
  decision_duration_ms: number;
  status: 'readying' | 'decision' | 'transition' | 'grace' | 'finished' | 'voided';
  deadline: number | null;
  transition_at: number | null;
  ready_deadline: number | null;
  ready_a: number;
  ready_b: number;
  started_at: number | null;
  ended_at: number | null;
  revision: number;
  last_result_json: string | null;
  afk_a: number;
  afk_b: number;
  disconnect_a: number;
  disconnect_b: number;
  disconnected_a_at: number | null;
  disconnected_b_at: number | null;
  grace_until: number | null;
  competitive_multiplier: number | null;
  result_type: string | null;
}

function stateOf(row: MatchRow): MatchState {
  return JSON.parse(row.state_json) as MatchState;
}

export function getMatch(db: Database.Database, id: string): MatchRow | null {
  return (db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined) ?? null;
}

function playerFor(row: MatchRow, session: Session): Player | null {
  const key = row.mode === 'ranked' ? session.uid : session.id;
  if (key && key === row.player_a_key) return 'A';
  if (key && key === row.player_b_key) return 'B';
  return null;
}

export function matchForSession(db: Database.Database, id: string, session: Session) {
  const row = getMatch(db, id);
  if (!row) throw new HttpError(404, 'Match not found');
  const player = playerFor(row, session);
  if (!player) throw new HttpError(404, 'Match not found');
  if (row.mode === 'ranked' && row.started_at === null) {
    return {
      id: row.id, roomId: row.room_id, mode: row.mode, status: row.status,
      player: null, playerNames: null, state: null, score: null,
      deadline: row.ready_deadline, serverNow: Date.now(), revision: row.revision,
      locked: false, lastResult: null, resultType: null,
      competitiveMultiplier: row.competitive_multiplier,
      afkMisses: 0, afkWarning: false,
    };
  }
  const state = stateOf(row);
  const locked = Boolean(db.prepare('SELECT 1 FROM pending_actions WHERE match_id = ? AND round = ? AND player = ?')
    .get(row.id, state.round, player));
  return {
    id: row.id,
    roomId: row.room_id,
    mode: row.mode,
    player,
    playerNames: { A: row.player_a_name, B: row.player_b_name },
    state,
    score: score(state.board),
    status: row.status,
    deadline: row.deadline,
    serverNow: Date.now(),
    revision: row.revision,
    locked,
    lastResult: row.last_result_json ? JSON.parse(row.last_result_json) as RoundResult : null,
    resultType: row.result_type,
    competitiveMultiplier: row.competitive_multiplier,
    afkMisses: player === 'A' ? row.afk_a : row.afk_b,
    afkWarning: (player === 'A' ? row.afk_a : row.afk_b) >= 2 && row.status !== 'finished',
  };
}

/** Find the most recent match this browser can safely resume. */
export function activeMatchForSession(db: Database.Database, session: Session) {
  const row = db.prepare(`SELECT id FROM matches WHERE status IN ('decision', 'transition', 'grace')
    AND ((mode = 'ranked' AND ? IS NOT NULL AND (player_a_key = ? OR player_b_key = ?))
      OR (mode <> 'ranked' AND (player_a_key = ? OR player_b_key = ?)))
    ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(session.uid, session.uid, session.uid, session.id, session.id) as { id: string } | undefined;
  return row ? matchForSession(db, row.id, session) : null;
}

export function parseAction(value: unknown): Action {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Choose an action');
  const data = value as Record<string, unknown>;
  if (data.type === 'pass') return { type: 'pass' };
  if (data.type === 'expand' || data.type === 'ambush' || data.type === 'surge' || data.type === 'override') {
    if (!Number.isInteger(data.target)) throw new HttpError(400, 'Choose a target');
    return { type: data.type, target: data.target as number };
  }
  throw new HttpError(400, 'Unknown action');
}

export function createBotMatch(db: Database.Database, session: Session, name: string, mode: 'quick' | 'practice' = 'quick', difficulty: BotDifficulty = 'easy', parentMatchId?: string, creationKey?: string) {
  return db.transaction(() => {
    if (creationKey) {
      const existing = db.prepare(`SELECT * FROM matches WHERE player_a_key = ? AND creation_key = ?
        AND bot_difficulty IS NOT NULL`).get(session.id, creationKey) as MatchRow | undefined;
      if (existing) {
        if (existing.mode !== mode || existing.bot_difficulty !== difficulty || existing.player_a_name !== name ||
            existing.parent_match_id !== (parentMatchId ?? null)) {
          throw new HttpError(409, 'Creation key was used for another bot match');
        }
        return existing.id;
      }
    }
    if (parentMatchId) {
      const parent = getMatch(db, parentMatchId);
      if (!parent || parent.mode !== mode || parent.player_a_key !== session.id ||
          !parent.player_b_key.startsWith('bot:') || parent.status !== 'finished') {
        throw new HttpError(404, 'Completed bot match not found');
      }
    }
    const now = Date.now();
    const recent = db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE player_a_key = ?
      AND player_b_key LIKE 'bot:%' AND started_at > ?`).get(session.id, now - 5 * 60_000) as { count: number };
    const active = db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE player_a_key = ?
      AND player_b_key LIKE 'bot:%' AND status IN ('decision', 'transition', 'grace')`).get(session.id) as { count: number };
    if (recent.count >= 10 || active.count >= 3) throw new HttpError(429, 'Finish an existing bot match before starting another');
    const id = randomUUID();
    db.prepare(`INSERT INTO matches
      (id, room_id, creation_key, parent_match_id, mode, bot_difficulty, player_a_key, player_b_key, player_a_name, player_b_name, state_json, status, deadline, started_at, revision)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'Bot', ?, 'decision', ?, ?, 1)`)
      .run(id, creationKey ?? null, parentMatchId ?? null, mode, difficulty, session.id, `bot:${id}`, name, JSON.stringify(createInitialState()), now + 5_000, now);
    return id;
  }).immediate();
}

function chooseCommittedBotAction(db: Database.Database, row: MatchRow, state: MatchState, now: number): Action {
  const revealed = db.prepare('SELECT result_json FROM round_results WHERE match_id = ? ORDER BY round DESC LIMIT 3')
    .all(row.id) as { result_json: string }[];
  const history = revealed.reverse().map((item) => (JSON.parse(item.result_json) as RoundResult).outcomes.A.action);
  const bot = chooseBotAction(state, 'B', row.bot_difficulty ?? 'easy', history, state.round);
  db.prepare('INSERT INTO pending_actions (match_id, round, player, action_json, locked_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, state.round, 'B', JSON.stringify(bot), now);
  return bot;
}

export function lockAction(db: Database.Database, id: string, session: Session, action: Action, expectedRound: number, expectedRevision: number): void {
  db.transaction(() => {
    const row = getMatch(db, id);
    if (!row) throw new HttpError(404, 'Match not found');
    const player = playerFor(row, session);
    if (!player) throw new HttpError(404, 'Match not found');
    const now = Date.now();
    if (row.status !== 'decision' || row.deadline === null || now >= row.deadline) {
      throw new HttpError(409, 'This round is no longer accepting moves');
    }
    const state = stateOf(row);
    if (!Number.isInteger(expectedRound) || !Number.isInteger(expectedRevision) ||
        expectedRound !== state.round || expectedRevision !== row.revision) {
      throw new HttpError(409, 'Match state changed. Refresh before locking a move');
    }
    const validation = validateAction(state, player, action);
    if (!validation.ok) throw new HttpError(400, `Illegal action: ${validation.reason}`);
    try {
      db.prepare('INSERT INTO pending_actions (match_id, round, player, action_json, locked_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, state.round, player, JSON.stringify(action), now);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint')) throw new HttpError(409, 'Move already locked');
      throw error;
    }
    if (row.player_b_key.startsWith('bot:') && player === 'A') {
      chooseCommittedBotAction(db, row, state, now);
      resolveMatch(db, id, now, true);
    }
  }).immediate();
}

function pendingAction(db: Database.Database, id: string, round: number, player: Player): Action | null {
  const found = db.prepare('SELECT action_json FROM pending_actions WHERE match_id = ? AND round = ? AND player = ?')
    .get(id, round, player) as { action_json: string } | undefined;
  return found ? JSON.parse(found.action_json) as Action : null;
}

function graceDuration(disconnects: number): number {
  return disconnects <= 1 ? 20_000 : disconnects === 2 ? 10_000 : 0;
}

function offlineAtDeadline(db: Database.Database, id: string, player: Player, deadline: number): boolean {
  const event = db.prepare(`SELECT offline FROM presence_events
    WHERE match_id = ? AND player = ? AND changed_at <= ?
    ORDER BY changed_at DESC, id DESC LIMIT 1`)
    .get(id, player, deadline) as { offline: number } | undefined;
  return event?.offline === 1;
}

function disconnectsAtDeadline(db: Database.Database, id: string, player: Player, total: number, deadline: number): number {
  const later = db.prepare(`SELECT COUNT(*) AS count FROM presence_events
    WHERE match_id = ? AND player = ? AND offline = 1 AND changed_at > ?`)
    .get(id, player, deadline) as { count: number };
  return Math.max(0, total - later.count);
}

export function resolveMatch(db: Database.Database, id: string, now = Date.now(), allowEarlyBot = false): boolean {
  return db.transaction(() => {
    const row = getMatch(db, id);
    if (!row || row.status !== 'decision') return false;
    if (!allowEarlyBot && (row.deadline === null || now < row.deadline)) return false;
    const state = stateOf(row);
    if (row.player_b_key.startsWith('bot:') && !pendingAction(db, id, state.round, 'B')) {
      chooseCommittedBotAction(db, row, state, now);
    }
    const actions = {
      A: pendingAction(db, id, state.round, 'A'),
      B: pendingAction(db, id, state.round, 'B'),
    };
    const offline = {
      A: offlineAtDeadline(db, id, 'A', row.deadline!),
      B: offlineAtDeadline(db, id, 'B', row.deadline!),
    };
    const misses = {
      A: actions.A || offline.A ? 0 : row.afk_a + 1,
      B: actions.B || offline.B || row.player_b_key.startsWith('bot:') ? 0 : row.afk_b + 1,
    };
    const aForfeit = misses.A >= 3 || disconnectsAtDeadline(db, id, 'A', row.disconnect_a, row.deadline!) >= 3;
    const bForfeit = misses.B >= 3 || disconnectsAtDeadline(db, id, 'B', row.disconnect_b, row.deadline!) >= 3;
    const noContest = aForfeit && bForfeit || offline.A && offline.B && (aForfeit || bForfeit);
    const forfeiting = noContest ? null : aForfeit ? 'A' : bForfeit ? 'B' : null;
    const result = resolveRound(state, actions, forfeiting);
    if (noContest) result.state = { ...result.state, status: 'finished', winner: null, endingReason: null };
    let status: MatchRow['status'] = result.state.status === 'finished' ? 'finished' : 'transition';
    let graceUntil: number | null = null;
    let transitionAt: number | null = status === 'transition' ? now + 1_000 : null;
    if (status !== 'finished' && (row.disconnected_a_at !== null || row.disconnected_b_at !== null)) {
      status = 'grace';
      transitionAt = null;
      const shortest = Math.min(...[
        row.disconnected_a_at !== null ? graceDuration(row.disconnect_a) : Infinity,
        row.disconnected_b_at !== null ? graceDuration(row.disconnect_b) : Infinity,
      ]);
      graceUntil = now + shortest;
    }
    db.prepare('INSERT INTO round_results (match_id, round, result_json, resolved_at) VALUES (?, ?, ?, ?)')
      .run(id, state.round, JSON.stringify(result), now);
    db.prepare(`UPDATE matches SET state_json = ?, status = ?, deadline = NULL, transition_at = ?, grace_until = ?,
      ended_at = ?, revision = revision + 1, last_result_json = ?, afk_a = ?, afk_b = ?, result_type = ?
      WHERE id = ? AND status = 'decision'`)
      .run(JSON.stringify(result.state), status, transitionAt, graceUntil,
        status === 'finished' ? now : null, JSON.stringify(result), misses.A, misses.B,
        status === 'finished' ? noContest ? 'no-contest' : result.state.endingReason : null, id);
    if (status === 'finished' && row.room_id) db.prepare("UPDATE rooms SET status = 'finished' WHERE id = ?").run(row.room_id);
    return true;
  })();
}

export function startNextRound(db: Database.Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const row = getMatch(db, id);
    if (!row || row.status !== 'transition' || row.transition_at === null || now < row.transition_at) return false;
    if (row.disconnected_a_at !== null || row.disconnected_b_at !== null) {
      const shortest = Math.min(
        row.disconnected_a_at !== null ? graceDuration(row.disconnect_a) : Infinity,
        row.disconnected_b_at !== null ? graceDuration(row.disconnect_b) : Infinity,
      );
      const changed = db.prepare("UPDATE matches SET status = 'grace', transition_at = NULL, grace_until = ?, revision = revision + 1 WHERE id = ? AND status = 'transition'")
        .run(now + shortest, id);
      return changed.changes === 1;
    }
    const changed = db.prepare("UPDATE matches SET status = 'decision', deadline = ?, transition_at = NULL, revision = revision + 1 WHERE id = ? AND status = 'transition'")
      .run(now + row.decision_duration_ms, id);
    return changed.changes === 1;
  })();
}

export function markDisconnected(db: Database.Database, id: string, player: Player, now = Date.now()): void {
  db.transaction(() => {
    const column = player === 'A' ? 'a' : 'b';
    const changed = db.prepare(`UPDATE matches SET disconnected_${column}_at = ?, disconnect_${column} = disconnect_${column} + 1,
      revision = revision + 1 WHERE id = ? AND disconnected_${column}_at IS NULL AND status IN ('decision', 'transition', 'grace')`)
      .run(now, id);
    if (changed.changes === 1) db.prepare('INSERT INTO presence_events (match_id, player, changed_at, offline) VALUES (?, ?, ?, 1)')
      .run(id, player, now);
  }).immediate();
}

export function markConnected(db: Database.Database, id: string, player: Player, now = Date.now()): void {
  db.transaction(() => {
    const before = getMatch(db, id);
    if (before?.status === 'grace' && before.grace_until !== null && now >= before.grace_until) return;
    const column = player === 'A' ? 'a' : 'b';
    const changed = db.prepare(`UPDATE matches SET disconnected_${column}_at = NULL, revision = revision + 1 WHERE id = ? AND disconnected_${column}_at IS NOT NULL AND status IN ('decision', 'transition', 'grace')`)
      .run(id);
    if (changed.changes === 1) db.prepare('INSERT INTO presence_events (match_id, player, changed_at, offline) VALUES (?, ?, ?, 0)')
      .run(id, player, now);
    const row = getMatch(db, id);
    if (row?.status === 'grace' && row.disconnected_a_at === null && row.disconnected_b_at === null) {
      db.prepare("UPDATE matches SET status = 'decision', deadline = ?, grace_until = NULL, revision = revision + 1 WHERE id = ? AND status = 'grace'")
        .run(now + row.decision_duration_ms, id);
    }
  }).immediate();
}

/** Treat sockets lost with a server process as offline before replaying overdue deadlines. */
export function reconcilePresenceOnStartup(db: Database.Database, now = Date.now()): void {
  db.transaction(() => {
    const matches = db.prepare(`SELECT id, player_b_key, status, deadline, disconnected_a_at, disconnected_b_at
      FROM matches WHERE status IN ('decision', 'transition', 'grace') AND started_at IS NOT NULL`)
      .all() as Pick<MatchRow, 'id' | 'player_b_key' | 'status' | 'deadline' | 'disconnected_a_at' | 'disconnected_b_at'>[];
    for (const match of matches) {
      for (const player of (['A', 'B'] as const)) {
        if (player === 'B' && match.player_b_key.startsWith('bot:')) continue;
        if (player === 'A' ? match.disconnected_a_at !== null : match.disconnected_b_at !== null) continue;
        const column = player === 'A' ? 'a' : 'b';
        const offlineAt = match.status === 'decision' && match.deadline !== null
          ? Math.min(now, match.deadline) : now;
        db.prepare(`UPDATE matches SET disconnected_${column}_at = ?, revision = revision + 1 WHERE id = ?`)
          .run(offlineAt, match.id);
        db.prepare('INSERT INTO presence_events (match_id, player, changed_at, offline) VALUES (?, ?, ?, 1)')
          .run(match.id, player, offlineAt);
      }
    }
  }).immediate();
}

export function expireGrace(db: Database.Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const row = getMatch(db, id);
    if (!row || row.status !== 'grace' || row.grace_until === null || now < row.grace_until) return false;
    const aGone = row.disconnected_a_at !== null;
    const bGone = row.disconnected_b_at !== null;
    if (!aGone && !bGone) return false;
    const resultType = aGone && bGone ? 'no-contest' : 'forfeit';
    const state = stateOf(row);
    const winner = resultType === 'forfeit' ? (aGone ? 'B' : 'A') : null;
    const finalState = { ...state, status: 'finished', winner, endingReason: resultType === 'forfeit' ? 'forfeit' : null };
    db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, deadline = NULL,
      grace_until = NULL, result_type = ?, revision = revision + 1 WHERE id = ? AND status = 'grace'`)
      .run(JSON.stringify(finalState), now, resultType, id);
    if (row.room_id) db.prepare("UPDATE rooms SET status = 'finished' WHERE id = ?").run(row.room_id);
    return true;
  })();
}

export function resignMatch(db: Database.Database, id: string, session: Session, now = Date.now()): void {
  db.transaction(() => {
    const row = getMatch(db, id);
    if (!row) throw new HttpError(404, 'Match not found');
    const player = playerFor(row, session);
    if (!player) throw new HttpError(404, 'Match not found');
    if (row.status !== 'decision' && row.status !== 'transition' && row.status !== 'grace') {
      throw new HttpError(409, 'This match is not active');
    }
    const state = stateOf(row);
    const finalState: MatchState = {
      ...state,
      status: 'finished',
      winner: player === 'A' ? 'B' : 'A',
      endingReason: 'resignation',
    };
    db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', deadline = NULL,
      transition_at = NULL, grace_until = NULL, ended_at = ?, result_type = 'resignation',
      revision = revision + 1 WHERE id = ?`)
      .run(JSON.stringify(finalState), now, id);
    if (row.room_id) db.prepare("UPDATE rooms SET status = 'finished' WHERE id = ?").run(row.room_id);
  })();
}

export function dueMatches(db: Database.Database, now = Date.now()): string[] {
  const rows = db.prepare(`SELECT id FROM matches WHERE
    (status = 'decision' AND deadline <= ?) OR
    (status = 'transition' AND transition_at <= ?) OR
    (status = 'grace' AND grace_until <= ?)`)
    .all(now, now, now) as { id: string }[];
  const changed: string[] = [];
  for (const row of rows) {
    if (resolveMatch(db, row.id, now) || startNextRound(db, row.id, now) || expireGrace(db, row.id, now)) changed.push(row.id);
  }
  return changed;
}
