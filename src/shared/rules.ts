export type Player = "A" | "B";
type Cell = Player | "neutral";
export type Board = readonly Cell[];
export type TargetedActionType = "expand" | "ambush" | "surge" | "override";
export type Action = { type: Exclude<TargetedActionType, "surge">; target: number }
  | { type: "surge"; target: number; secondTarget?: number }
  | { type: "pass" };
type EndingReason = "standard" | "sudden-death" | "board-exhaustion" | "forfeit" | "resignation";

export interface GameConfig {
  standardRounds: number;
  suddenDeathRounds: number;
  energyCap: number;
}

export interface MatchState {
  board: Board;
  energy: Readonly<Record<Player, number>>;
  round: number;
  phase: "standard" | "sudden-death";
  status: "active" | "finished";
  winner: Player | null;
  endingReason: EndingReason | null;
  config: Readonly<GameConfig>;
}

type ActionReason =
  | "claimed"
  | "stolen"
  | "ambush-hit"
  | "ambush-missed"
  | "collision"
  | "intercepted"
  | "passed"
  | "automatic-pass";

export interface ActionOutcome {
  action: Action;
  success: boolean;
  reason: ActionReason;
  energySpent: number;
  energyEarned: number;
  energyDrained?: number;
  cells?: ReadonlyArray<{ target: number; success: boolean; reason: ActionReason }>;
}

export interface RoundResult {
  round?: number;
  beforeScore?: Readonly<Record<Player, number>>;
  beforeEnergy?: Readonly<Record<Player, number>>;
  state: MatchState;
  outcomes: Readonly<Record<Player, ActionOutcome>>;
  score: Readonly<Record<Player, number>>;
}

type ValidationReason =
  | "match-finished"
  | "invalid-action"
  | "invalid-target"
  | "occupied-target"
  | "not-adjacent"
  | "out-of-range"
  | "insufficient-energy";

export type Validation = { ok: true } | { ok: false; reason: ValidationReason };

export const BOARD_SIZE = 5;
const DEFAULT_CONFIG: Readonly<GameConfig> = Object.freeze({
  standardRounds: 12,
  suddenDeathRounds: 3,
  energyCap: 5,
});

const OPENING: Board = [
  "A", "A", "neutral", "neutral", "neutral",
  "A", "A", "neutral", "neutral", "neutral",
  "neutral", "neutral", "neutral", "neutral", "neutral",
  "neutral", "neutral", "neutral", "B", "B",
  "neutral", "neutral", "neutral", "B", "B",
];

const opponent = (player: Player): Player => player === "A" ? "B" : "A";
const distance = (left: number, right: number): number =>
  Math.abs(Math.floor(left / BOARD_SIZE) - Math.floor(right / BOARD_SIZE)) +
  Math.abs(left % BOARD_SIZE - right % BOARD_SIZE);

const cost = (type: Action["type"]): number =>
  type === "surge" ? 3 : type === "override" ? 2 : 0;

export const minimumEnergy = (type: Action["type"]): number =>
  type === "ambush" ? 1 : cost(type);

export function createInitialState(config: Partial<GameConfig> = {}): MatchState {
  const selected = { ...DEFAULT_CONFIG, ...config };
  if (!Number.isInteger(selected.standardRounds) || selected.standardRounds < 1 ||
      !Number.isInteger(selected.suddenDeathRounds) || selected.suddenDeathRounds < 0 ||
      !Number.isInteger(selected.energyCap) || selected.energyCap < 1) {
    throw new Error("Invalid game configuration");
  }
  return {
    board: [...OPENING], energy: { A: selected.energyCap, B: selected.energyCap }, round: 1,
    phase: "standard", status: "active", winner: null, endingReason: null,
    config: selected,
  };
}

export function score(board: Board): Readonly<Record<Player, number>> {
  return {
    A: board.filter((cell) => cell === "A").length,
    B: board.filter((cell) => cell === "B").length,
  };
}

export function actionTargets(action: Action): number[] {
  if (action.type === "pass") return [];
  return action.type === "surge" && action.secondTarget !== undefined
    ? [action.target, action.secondTarget] : [action.target];
}

export function legalTargets(state: MatchState, player: Player, type: TargetedActionType): number[] {
  if (state.status !== "active" || state.energy[player] < minimumEnergy(type)) return [];
  const owner = type === "ambush" ? opponent(player) : player;
  const targetOwner = type === "override" ? opponent(player) : "neutral";
  const reach = type === "surge" ? 2 : 1;
  const targets: number[] = [];
  for (let target = 0; target < state.board.length; target++) {
    if (type === "surge" ? state.board[target] === player : state.board[target] !== targetOwner) continue;
    if (state.board.some((cell, source) => cell === owner &&
        distance(source, target) > 0 && distance(source, target) <= reach)) {
      targets.push(target);
    }
  }
  return targets;
}

export function legalActions(state: MatchState, player: Player): Action[] {
  if (state.status !== "active") return [];
  const actions: Action[] = [];
  for (const type of ["expand", "ambush", "surge", "override"] as const) {
    const targets = legalTargets(state, player, type);
    for (const target of targets) actions.push({ type, target });
    if (type === "surge") {
      for (let first = 0; first < targets.length; first++) {
        for (let second = first + 1; second < targets.length; second++) {
          actions.push({ type, target: targets[first], secondTarget: targets[second] });
        }
      }
    }
  }
  actions.push({ type: "pass" });
  return actions;
}

export function validateAction(state: MatchState, player: Player, action: Action): Validation {
  if (state.status !== "active") return { ok: false, reason: "match-finished" };
  if (action.type === "pass") return { ok: true };
  if (!["expand", "ambush", "surge", "override"].includes(action.type)) {
    return { ok: false, reason: "invalid-action" };
  }
  const targets = actionTargets(action);
  if (targets.some((target) => !Number.isInteger(target) || target < 0 || target >= state.board.length) || new Set(targets).size !== targets.length) {
    return { ok: false, reason: "invalid-target" };
  }
  if (state.energy[player] < minimumEnergy(action.type)) return { ok: false, reason: "insufficient-energy" };
  const owner = action.type === "ambush" ? opponent(player) : player;
  const targetOwner = action.type === "override" ? opponent(player) : "neutral";
  if (targets.some((target) => action.type === "surge" ? state.board[target] === player : state.board[target] !== targetOwner)) return { ok: false, reason: "occupied-target" };
  const reach = action.type === "surge" ? 2 : 1;
  const inReach = targets.every((target) => state.board.some((cell, source) => cell === owner &&
    distance(source, target) > 0 && distance(source, target) <= reach));
  return inReach ? { ok: true } : {
    ok: false, reason: action.type === "surge" ? "out-of-range" : "not-adjacent",
  };
}

function exhausted(state: MatchState): boolean {
  return !state.board.includes("neutral") &&
    legalTargets(state, "A", "override").length === 0 &&
    legalTargets(state, "B", "override").length === 0 &&
    legalTargets(state, "A", "surge").length === 0 &&
    legalTargets(state, "B", "surge").length === 0;
}

export function resolveRound(
  state: MatchState,
  submitted: Readonly<Record<Player, Action | null>>,
  forfeitPlayer: Player | null = null,
): RoundResult {
  if (forfeitPlayer && submitted[forfeitPlayer] !== null) {
    throw new Error("A connected-miss forfeit requires an automatic Pass");
  }
  const actions: Record<Player, Action> = {
    A: submitted.A ?? { type: "pass" },
    B: submitted.B ?? { type: "pass" },
  };
  for (const player of ["A", "B"] as const) {
    const validation = validateAction(state, player, actions[player]);
    if (validation.ok === false) throw new Error(`Invalid ${player} action: ${validation.reason}`);
  }

  const nextBoard = [...state.board];
  const nextEnergy = { A: state.energy.A - cost(actions.A.type), B: state.energy.B - cost(actions.B.type) };
  const outcomes = {} as Record<Player, ActionOutcome>;
  for (const player of ["A", "B"] as const) {
    const action = actions[player];
    const other = actions[opponent(player)];
    let reason: ActionReason;
    let cells: ActionOutcome["cells"];
    let energySpent = cost(action.type);
    let energyEarned = 0;
    let energyDrained = 0;
    if (action.type === "pass") {
      reason = submitted[player] === null ? "automatic-pass" : "passed";
    } else if (action.type === "ambush") {
      reason = other.type === "expand" && other.target === action.target
        ? "ambush-hit" : "ambush-missed";
      if (reason === "ambush-hit") {
        nextBoard[action.target] = player;
        cells = [{ target: action.target, success: true, reason }];
        energyEarned = Math.min(3, state.config.energyCap - nextEnergy[player]);
        energyDrained = Math.min(2, nextEnergy[opponent(player)]);
        nextEnergy[player] += energyEarned;
        nextEnergy[opponent(player)] -= energyDrained;
      } else {
        energySpent = 1;
        nextEnergy[player] -= energySpent;
      }
    } else {
      cells = actionTargets(action).map((target) => {
        const cellReason: ActionReason = action.type === "expand" && other.type === "ambush" && other.target === target
          ? "intercepted"
          : (other.type === "expand" || other.type === "surge") && actionTargets(other).includes(target)
            ? "collision" : state.board[target] === opponent(player) ? "stolen" : "claimed";
        const success = cellReason === "claimed" || cellReason === "stolen";
        if (success) nextBoard[target] = player;
        return { target, success, reason: cellReason };
      });
      reason = cells.find((cell) => cell.reason === "stolen")?.reason ?? cells.find((cell) => cell.success)?.reason ?? cells[0].reason;
      if (action.type === "expand" && reason === "claimed") {
        energyEarned = Math.min(0.5, state.config.energyCap - nextEnergy[player]);
        nextEnergy[player] += energyEarned;
      }
    }
    outcomes[player] = {
      action: { ...action }, success: reason === "claimed" || reason === "stolen" || reason === "ambush-hit",
      reason, energySpent, energyEarned,
      ...(action.type === "ambush" && reason === "ambush-hit" ? { energyDrained } : {}),
      ...(cells ? { cells } : {}),
    };
  }

  const totals = score(nextBoard);
  const leader = totals.A === totals.B ? null : totals.A > totals.B ? "A" : "B";
  let next: MatchState = {
    ...state, board: nextBoard, energy: nextEnergy, round: state.round + 1,
  };
  let endingReason: EndingReason | null = null;
  if (forfeitPlayer) endingReason = "forfeit";
  else if (exhausted(next)) endingReason = "board-exhaustion";
  else if (state.phase === "standard" && state.round >= state.config.standardRounds) {
    if (leader) endingReason = "standard";
    else if (state.config.suddenDeathRounds === 0) endingReason = "sudden-death";
    else next = { ...next, phase: "sudden-death" };
  } else if (state.phase === "sudden-death") {
    if (leader || state.round >= state.config.standardRounds + state.config.suddenDeathRounds) {
      endingReason = "sudden-death";
    }
  }
  if (endingReason) next = {
    ...next, round: state.round, status: "finished",
    winner: forfeitPlayer ? opponent(forfeitPlayer) : leader, endingReason,
  };
  return { state: next, outcomes, score: totals, round: state.round, beforeScore: score(state.board), beforeEnergy: { ...state.energy } };
}
