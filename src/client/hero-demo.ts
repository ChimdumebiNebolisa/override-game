import { createInitialState, resolveRound, type Action, type MatchState } from "../shared/rules";

// Replay from the normal opening, with the default 12 + 3 round limit.
// Six paired claims, three paired Passes, then five tied collisions.
export const DEMO_HISTORY: ReadonlyArray<Readonly<Record<"A" | "B", Action>>> = [
  { A: { type: "expand", target: 2 }, B: { type: "expand", target: 22 } },
  { A: { type: "expand", target: 7 }, B: { type: "expand", target: 17 } },
  { A: { type: "expand", target: 10 }, B: { type: "expand", target: 14 } },
  { A: { type: "expand", target: 11 }, B: { type: "expand", target: 13 } },
  { A: { type: "expand", target: 15 }, B: { type: "expand", target: 9 } },
  { A: { type: "expand", target: 16 }, B: { type: "expand", target: 4 } },
  ...Array.from({ length: 3 }, (): Record<"A" | "B", Action> => ({
    A: { type: "pass" }, B: { type: "pass" },
  })),
  ...Array.from({ length: 5 }, (): Record<"A" | "B", Action> => ({
    A: { type: "expand", target: 12 }, B: { type: "expand", target: 12 },
  })),
];

export const DEMO_RIVAL_MOVE: Action = { type: "expand", target: 12 };

export function createDemoMatch(): MatchState {
  return DEMO_HISTORY.reduce((match, moves) => resolveRound(match, moves).state, createInitialState());
}
