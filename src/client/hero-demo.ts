import { createInitialState, resolveRound, validateAction, type Action, type MatchState, type RoundResult } from "../shared/rules";
import { toggleSurgeTarget } from "./move-selection";

// Replay from the normal opening, with the default 12 + 3 round limit.
// Six paired claims, three successful Ambushes, then five tied collisions.
export const DEMO_HISTORY: ReadonlyArray<Readonly<Record<"A" | "B", Action>>> = [
  { A: { type: "expand", target: 2 }, B: { type: "expand", target: 22 } },
  { A: { type: "expand", target: 7 }, B: { type: "expand", target: 17 } },
  { A: { type: "expand", target: 10 }, B: { type: "expand", target: 14 } },
  { A: { type: "expand", target: 11 }, B: { type: "expand", target: 13 } },
  { A: { type: "expand", target: 15 }, B: { type: "expand", target: 9 } },
  { A: { type: "expand", target: 16 }, B: { type: "expand", target: 4 } },
  ...Array.from({ length: 3 }, (): Record<"A" | "B", Action> => ({
    A: { type: "ambush", target: 12 }, B: { type: "expand", target: 12 },
  })),
  ...Array.from({ length: 5 }, (): Record<"A" | "B", Action> => ({
    A: { type: "expand", target: 12 }, B: { type: "expand", target: 12 },
  })),
];

export const DEMO_RIVAL_MOVE: Action = { type: "expand", target: 12 };

export function createDemoMatch(): MatchState {
  return DEMO_HISTORY.reduce((match, moves) => resolveRound(match, moves).state, createInitialState());
}

export interface DemoState {
  match: MatchState;
  actionType: Action["type"];
  target: number | null;
  secondTarget: number | null;
  phase: "choosing" | "committed" | "revealed" | "finished";
  result: RoundResult | null;
  attempt: number;
}

export type DemoEvent =
  | { type: "action"; actionType: Action["type"] }
  | { type: "target"; target: number }
  | { type: "commit" }
  | { type: "reveal" | "finish"; attempt: number }
  | { type: "reset" };

export function createDemoState(): DemoState {
  return { match: createDemoMatch(), actionType: "expand", target: null, secondTarget: null, phase: "choosing", result: null, attempt: 0 };
}

export function selectedDemoMove(state: DemoState): Action | null {
  if (state.actionType === "pass") return { type: "pass" };
  return state.target === null ? null : state.actionType === "surge" && state.secondTarget !== null
    ? { type: "surge", target: state.target, secondTarget: state.secondTarget } : { type: state.actionType, target: state.target };
}

export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  if (event.type === "reset") return { ...createDemoState(), attempt: state.attempt + 1 };
  if (event.type === "reveal" || event.type === "finish") {
    if (event.attempt !== state.attempt) return state;
    if (event.type === "reveal" && state.phase === "committed") {
      const move = selectedDemoMove(state)!;
      return { ...state, phase: "revealed", result: resolveRound(state.match, { A: move, B: DEMO_RIVAL_MOVE }) };
    }
    if (event.type === "finish" && state.phase === "revealed") {
      return { ...state, phase: "finished", match: state.result!.state };
    }
    return state;
  }
  if (state.phase !== "choosing") return state;
  if (event.type === "action") return { ...state, actionType: event.actionType, target: null, secondTarget: null };
  if (event.type === "target") {
    if (state.actionType === "pass" || !validateAction(state.match, "A", { type: state.actionType, target: event.target }).ok) return state;
    if (state.actionType === "surge") {
      const targets = toggleSurgeTarget([state.target, state.secondTarget].filter((cell): cell is number => cell !== null), event.target);
      return { ...state, target: targets[0] ?? null, secondTarget: targets[1] ?? null };
    }
    return { ...state, target: event.target };
  }
  const move = selectedDemoMove(state);
  return move && validateAction(state.match, "A", move).ok ? { ...state, phase: "committed" } : state;
}

export function demoExplanation(result: RoundResult): string {
  if (result.outcomes.A.action.type === "surge" && result.outcomes.A.cells) {
    const captured = result.outcomes.A.cells.filter((cell) => cell.success).length;
    const stolen = result.outcomes.A.cells.filter((cell) => cell.reason === "stolen").length;
    const collided = result.outcomes.A.cells.filter((cell) => cell.reason === "collision").length;
    return `Your Surge captured ${captured} ${captured === 1 ? "space" : "spaces"}${stolen ? `, stealing ${stolen} from the rival` : ""}${collided ? `; ${collided} ${collided === 1 ? "target" : "targets"} collided` : ""}.`;
  }
  switch (result.outcomes.A.reason) {
    case "stolen": return "Your steal swung the lead, even as your rival claimed a space.";
    case "claimed": return "You both claimed a space; territory stayed level.";
    case "collision": return "You chose the same space; neither could claim it.";
    case "ambush-hit": return "Your Ambush blocked the rival’s claim, keeping the score level.";
    case "ambush-missed": return "Your Ambush missed; the rival’s claim broke the tie.";
    default: return "You passed; the rival’s claim broke the tie.";
  }
}
