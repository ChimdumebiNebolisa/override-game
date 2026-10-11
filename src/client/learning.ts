import type { PublicMatch } from './api';

export const WELCOME_KEY = 'override:welcome:v1';
export const COMPLETION_KEY = 'override:core-loop:v1';
const RUN_PREFIX = 'override:learning:v1:';
const memory = new Map<string, string>();

export function readFlag(key: string): string | null {
  try { return window.localStorage.getItem(key) ?? memory.get(key) ?? null; }
  catch { return memory.get(key) ?? null; }
}
export function writeFlag(key: string, value: string): void {
  memory.set(key, value);
  try { window.localStorage.setItem(key, value); } catch { /* Coaching still works in this tab. */ }
}

export interface LearningRun {
  version: 1;
  matchId: string;
  skipped: boolean;
  expandRound: number | null;
  expandAcknowledged: boolean;
  independentRound: number | null;
  completed: boolean;
  seenTips: string[];
  pendingAcknowledgement: number | null;
}
export function beginLearning(matchId: string): LearningRun {
  const run: LearningRun = { version: 1, matchId, skipped: false, expandRound: null,
    expandAcknowledged: false, independentRound: null, completed: false, seenTips: [], pendingAcknowledgement: null };
  saveLearning(run);
  return run;
}
export function saveLearning(run: LearningRun): void {
  writeFlag(RUN_PREFIX + run.matchId, JSON.stringify(run));
  if (run.completed) writeFlag(COMPLETION_KEY, 'completed');
}
export function loadLearning(matchId: string): LearningRun | null {
  try {
    const run = JSON.parse(readFlag(RUN_PREFIX + matchId) ?? 'null') as LearningRun | null;
    return run?.version === 1 && run.matchId === matchId && Array.isArray(run.seenTips) &&
      typeof run.skipped === 'boolean' && typeof run.completed === 'boolean' &&
      typeof run.expandAcknowledged === 'boolean' &&
      [run.expandRound, run.independentRound, run.pendingAcknowledgement].every((round) => round === null || Number.isInteger(round) && round > 0)
      ? run : null;
  } catch { return null; }
}
export function resolvedRound(match: Pick<PublicMatch, 'lastResult'>): number | null {
  const result = match.lastResult;
  return result ? result.round ?? (result.state.status === 'finished' ? result.state.round : result.state.round - 1) : null;
}
/** Only authoritative revealed outcomes establish a manual, legal commitment. */
export function observeLearning(run: LearningRun, match: PublicMatch): LearningRun {
  if (run.matchId !== match.id || run.skipped || run.completed || match.mode !== 'practice' || match.timed) return run;
  const round = resolvedRound(match);
  const outcome = match.lastResult?.outcomes[match.player];
  let next = run;
  if (round !== null && outcome && outcome.reason !== 'automatic-pass') {
    if (run.expandRound === null && outcome.action.type === 'expand') next = { ...next, expandRound: round };
    else if (run.expandAcknowledged && round > (run.expandRound ?? Infinity) && run.independentRound === null) {
      next = { ...next, independentRound: round };
    }
  }
  // A lost Next response is reconciled only against the same acknowledged result's opened decision.
  if (round !== null && next.pendingAcknowledgement !== null && next.pendingAcknowledgement === round && match.status === 'decision') {
    next = acknowledgeLearning(next, round!);
  }
  return next;
}
export function acknowledgeLearning(run: LearningRun, round: number): LearningRun {
  if (run.skipped || run.completed || !Number.isInteger(round) || round < 1) return run;
  if (run.independentRound === round) return { ...run, completed: true, pendingAcknowledgement: null };
  if (run.expandRound === round) return { ...run, expandAcknowledged: true, pendingAcknowledgement: null };
  return { ...run, pendingAcknowledgement: null };
}
