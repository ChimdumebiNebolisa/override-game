import type Database from 'better-sqlite3';
import { score, type MatchState, type RoundResult } from '../src/shared/rules';
import { HttpError } from './http';

const CLIENT_EVENTS = new Set(['homepage_opened', 'mode_selected', 'opponent_selected', 'ranked_auth_started']);
const EVENT_MODES = new Set(['practice', 'quick', 'ranked', 'practice-bot', 'quick-bot', 'quick-human', 'ranked-queue', 'ranked-friend']);

export function recordTelemetryEvent(db: Database.Database, sessionId: string, name: string, mode: string | null = null, now = Date.now()): void {
  db.prepare('INSERT INTO telemetry_events (session_id, name, mode, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, name, mode, now);
}

export function recordClientTelemetry(db: Database.Database, sessionId: string, name: unknown, mode: unknown, now = Date.now()): void {
  if (typeof name !== 'string' || !CLIENT_EVENTS.has(name) ||
      (mode !== null && mode !== undefined && (typeof mode !== 'string' || !EVENT_MODES.has(mode)))) {
    throw new HttpError(400, 'Unknown telemetry event');
  }
  const recent = db.prepare('SELECT COUNT(*) AS count FROM telemetry_events WHERE session_id = ? AND created_at > ?')
    .get(sessionId, now - 24 * 60 * 60_000) as { count: number };
  if (recent.count >= 200) throw new HttpError(429, 'Telemetry limit reached');
  recordTelemetryEvent(db, sessionId, name, (mode as string | null | undefined) ?? null, now);
}

type MatchRow = {
  id: string;
  mode: 'practice' | 'quick' | 'ranked';
  bot_difficulty: 'easy' | 'normal' | 'hard' | null;
  player_b_key: string;
  status: string;
  ready_a: number;
  ready_b: number;
  started_at: number | null;
  ended_at: number | null;
  state_json: string;
  result_type: string | null;
  disconnect_a: number;
  disconnect_b: number;
};

const ratio = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
const average = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const actionTypes = ['expand', 'ambush', 'surge', 'override', 'pass'] as const;
type ActionType = (typeof actionTypes)[number];
const actionCounts = (): Record<ActionType, number> => ({ expand: 0, ambush: 0, surge: 0, override: 0, pass: 0 });
const sideCounts = () => ({ aWins: 0, bWins: 0, draws: 0, aWinRate: null as number | null });

/** Aggregate only persisted, revealed rounds and terminal states; no pending action is read. */
export function metricsReport(db: Database.Database, now = Date.now()) {
  const matches = db.prepare(`SELECT id, mode, bot_difficulty, player_b_key, status, ready_a, ready_b, started_at, ended_at,
    state_json, result_type, disconnect_a, disconnect_b FROM matches`).all() as MatchRow[];
  const byId = new Map(matches.map((match) => [match.id, match]));
  const started = matches.filter((match) => match.started_at !== null);
  const completed = started.filter((match) => match.status === 'finished');
  const completedContests = completed.filter((match) => match.result_type !== 'no-contest');
  const humanActions = actionCounts();
  const botActions = actionCounts();
  let humanActionTotal = 0;
  let ambushHits = 0;
  let voluntaryPasses = 0;
  let timeoutPasses = 0;
  const matchesWithTimeouts = new Set<string>();
  const reachedRound3 = new Set<string>();
  const rounds = db.prepare('SELECT match_id, round, result_json FROM round_results')
    .all() as { match_id: string; round: number; result_json: string }[];
  for (const round of rounds) {
    const match = byId.get(round.match_id);
    if (!match) continue;
    if (round.round >= 3) reachedRound3.add(round.match_id);
    const result = JSON.parse(round.result_json) as RoundResult;
    for (const player of ['A', 'B'] as const) {
      const outcome = result.outcomes[player];
      const bot = player === 'B' && match.player_b_key.startsWith('bot:');
      const counts = bot ? botActions : humanActions;
      counts[outcome.action.type]++;
      if (bot) continue;
      humanActionTotal++;
      if (outcome.reason === 'ambush-hit') ambushHits++;
      if (outcome.reason === 'passed') voluntaryPasses++;
      if (outcome.reason === 'automatic-pass') {
        timeoutPasses++;
        matchesWithTimeouts.add(round.match_id);
      }
    }
  }

  const sides = {
    rankedHuman: sideCounts(), quickHuman: sideCounts(),
    easyBot: sideCounts(), normalBot: sideCounts(), hardBot: sideCounts(),
  };
  for (const match of completed) {
    if (match.result_type === 'no-contest') continue;
    const bot = match.player_b_key.startsWith('bot:');
    const key = bot ? match.bot_difficulty === 'easy' ? 'easyBot' : match.bot_difficulty === 'hard' ? 'hardBot' : 'normalBot'
      : match.mode === 'ranked' ? 'rankedHuman' : 'quickHuman';
    const winner = (JSON.parse(match.state_json) as MatchState).winner;
    if (winner === 'A') sides[key].aWins++;
    else if (winner === 'B') sides[key].bWins++;
    else sides[key].draws++;
  }
  for (const side of Object.values(sides)) side.aWinRate = ratio(side.aWins, side.aWins + side.bWins);

  const eventRows = db.prepare('SELECT name, mode, COUNT(*) AS count FROM telemetry_events GROUP BY name, mode')
    .all() as { name: string; mode: string | null; count: number }[];
  const events = Object.fromEntries(eventRows.map((row) => [`${row.name}${row.mode ? `:${row.mode}` : ''}`, row.count]));
  const eventTotal = (name: string) => eventRows.filter((row) => row.name === name).reduce((sum, row) => sum + row.count, 0);
  const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  const completedBy = (mode: string, bot: boolean) => completed.filter((match) => match.mode === mode && match.player_b_key.startsWith('bot:') === bot).length;
  const botRematches = (mode: string) => count(`SELECT COUNT(DISTINCT parent_match_id) AS count FROM matches
    WHERE mode = '${mode}' AND parent_match_id IS NOT NULL`);
  const rematch = {
    practiceBot: { selected: botRematches('practice'), eligible: completedBy('practice', true) },
    quickBot: { selected: botRematches('quick'), eligible: completedBy('quick', true) },
    quickHuman: { selected: count('SELECT COUNT(DISTINCT parent_match_id) AS count FROM quick_rematch_invitations'), eligible: completedBy('quick', false) },
    ranked: { selected: count("SELECT COUNT(DISTINCT parent_match_id) AS count FROM ranked_invitations WHERE kind = 'rematch'"), eligible: completedBy('ranked', false) },
  };
  return {
    generatedAt: now,
    funnel: {
      homepageOpened: eventTotal('homepage_opened'),
      modeSelected: eventTotal('mode_selected'),
      opponentSelected: eventTotal('opponent_selected'),
      roomCreated: count('SELECT COUNT(*) AS count FROM rooms'),
      roomJoined: count('SELECT COUNT(*) AS count FROM rooms WHERE guest_key IS NOT NULL'),
      rankedAuthenticationStarted: eventTotal('ranked_auth_started'),
      rankedAuthenticationCompleted: eventTotal('ranked_auth_completed'),
      matchmakingStarted: eventTotal('matchmaking_started'),
      matchShellCreated: matches.filter((match) => match.mode === 'ranked').length,
      bothPlayersReady: matches.filter((match) => match.mode === 'ranked' && match.ready_a === 1 && match.ready_b === 1).length,
      bindingMatchStarted: started.filter((match) => match.mode === 'ranked').length,
      round3Reached: reachedRound3.size,
      matchCompleted: completed.length,
      rematchSelected: Object.values(rematch).reduce((sum, item) => sum + item.selected, 0),
      eventsByNameAndMode: events,
    },
    gameplay: {
      startedMatches: started.length,
      completedMatches: completed.length,
      averageMatchLengthMs: average(completed.filter((match) => match.ended_at !== null)
        .map((match) => match.ended_at! - match.started_at!)),
      matchCompletionRate: ratio(completed.length, started.length),
      actionDistribution: { human: humanActions, bot: botActions },
      voluntaryPassRate: ratio(voluntaryPasses, humanActionTotal),
      automaticTimeoutPassRate: ratio(timeoutPasses, humanActionTotal),
      ambushAttemptRate: ratio(humanActions.ambush, humanActionTotal),
      ambushSuccessRate: ratio(ambushHits, humanActions.ambush),
      surgeUsage: humanActions.surge,
      overrideUsage: humanActions.override,
      boardExhaustionEndingRate: ratio(completed.filter((match) => (JSON.parse(match.state_json) as MatchState).endingReason === 'board-exhaustion').length, completed.length),
      averageFinalScoreDifferential: average(completed.map((match) => {
        const final = score((JSON.parse(match.state_json) as MatchState).board);
        return Math.abs(final.A - final.B);
      })),
      disconnectRate: ratio(started.filter((match) => match.disconnect_a > 0 || match.disconnect_b > 0).length, started.length),
      timeoutRate: ratio(matchesWithTimeouts.size, started.length),
      resignationRate: ratio(completed.filter((match) => match.result_type === 'resignation').length, completed.length),
      drawRate: ratio(completedContests.filter((match) => (JSON.parse(match.state_json) as MatchState).winner === null).length, completedContests.length),
    },
    rematchRates: Object.fromEntries(Object.entries(rematch).map(([key, value]) => [key, { ...value, rate: ratio(value.selected, value.eligible) }])),
    sideBalance: sides,
  };
}
