import { createInitialState, resolveRound, type Action, type MatchState, type Player, type RoundResult } from "../shared/rules";
import { DEMO_HISTORY } from "./hero-demo";

export const GUIDE_LESSONS = [
  { id: "expand", title: "Claim a space", action: "expand" },
  { id: "collision", title: "Reveal together", action: "expand" },
  { id: "ambush", title: "Predict an Expand", action: "ambush" },
  { id: "surge", title: "Surge", action: "surge" },
  { id: "override", title: "Override", action: "override" },
  { id: "finish", title: "Finish a match", action: "pass" },
] as const;

export type GuideLessonId = typeof GUIDE_LESSONS[number]["id"];
export type SurgeExampleId = "single" | "mixed" | "collision" | "steal";
export type FinishExampleId = "standard-win" | "sudden-lead" | "draw";

export const SURGE_EXAMPLES: ReadonlyArray<{ id: SurgeExampleId; title: string }> = [
  { id: "single", title: "Take one" },
  { id: "mixed", title: "Open + rival" },
  { id: "collision", title: "Partial collision" },
  { id: "steal", title: "Steal two" },
];

export interface GuideScenario {
  start: MatchState;
  rivalMove: Action;
  allowedTargets?: readonly number[];
  targetCount?: number;
  note: string;
}

function board(rows: string[]): MatchState["board"] {
  return rows.join("").split("").map((cell) => cell === "." ? "neutral" : cell as Player);
}

function position(rows: string[], energyA = 0, energyB = 0): MatchState {
  return { ...createInitialState(), board: board(rows), energy: { A: energyA, B: energyB } };
}

const facing = [".....", ".....", ".A.B.", ".....", "....."];

function tiedAfterRound12(): MatchState {
  const round11 = DEMO_HISTORY.slice(0, 11).reduce(
    (match, moves) => resolveRound(match, moves).state, createInitialState(),
  );
  return resolveRound(round11, { A: { type: "pass" }, B: { type: "pass" } }).state;
}

export function guideScenario(
  lesson: GuideLessonId,
  surgeExample: SurgeExampleId = "single",
  finishExample: FinishExampleId = "standard-win",
): GuideScenario {
  if (lesson === "expand") {
    return { start: createInitialState(), rivalMove: { type: "expand", target: 22 }, note: "Staged opening · 0 starting Energy" };
  }
  if (lesson === "collision") {
    const cells = Array<string>(25).fill("A");
    cells[7] = "B"; cells[12] = ".";
    return { start: position([0, 1, 2, 3, 4].map((row) => cells.slice(row * 5, row * 5 + 5).join(""))),
      rivalMove: { type: "expand", target: 12 }, allowedTargets: [12], note: "Staged example · C3 is the only open space" };
  }
  if (lesson === "ambush") {
    return { start: position(facing), rivalMove: { type: "expand", target: 12 }, note: "Staged example · Rival’s move stays hidden until reveal" };
  }
  if (lesson === "surge") {
    const start = surgeExample === "steal"
      ? position([".....", ".....", ".ABB.", ".....", "....."], 3)
      : position(facing, 3);
    if (surgeExample === "single") return { start, rivalMove: { type: "pass" }, allowedTargets: [12], targetCount: 1, note: "Staged example · You start with 3 Energy" };
    if (surgeExample === "mixed") return { start, rivalMove: { type: "pass" }, allowedTargets: [10, 13], targetCount: 2, note: "Staged example · You start with 3 Energy" };
    if (surgeExample === "collision") return { start, rivalMove: { type: "expand", target: 12 }, allowedTargets: [10, 12], targetCount: 2, note: "Staged example · You start with 3 Energy" };
    return { start, rivalMove: { type: "pass" }, allowedTargets: [12, 13], targetCount: 2, note: "Staged example · You start with 3 Energy" };
  }
  if (lesson === "override") {
    return { start: position([".....", "..B..", ".AB..", ".....", "....."], 2), rivalMove: { type: "pass" },
      allowedTargets: [12], targetCount: 1, note: "Staged example · You start with 2 Energy" };
  }
  const tiedAfter12State = tiedAfterRound12();
  if (finishExample === "standard-win") {
    const start = DEMO_HISTORY.slice(0, 11).reduce((match, moves) => resolveRound(match, moves).state, createInitialState());
    return { start, rivalMove: { type: "pass" }, note: "Staged position · Round 12 decides the territory winner" };
  }
  if (finishExample === "sudden-lead") {
    return { start: tiedAfter12State, rivalMove: { type: "pass" }, note: "Staged tie · Reached after 12 rounds of legal play" };
  }
  const start = resolveRound(tiedAfter12State, { A: { type: "pass" }, B: { type: "pass" } }).state;
  const beforeFinalExtraRound = resolveRound(start, { A: { type: "pass" }, B: { type: "pass" } }).state;
  return { start: beforeFinalExtraRound, rivalMove: { type: "pass" }, allowedTargets: [], targetCount: 0,
    note: "Staged tie · Round 15 of legal play" };
}

export function resolveGuideScenario(scenario: GuideScenario, move: Action): RoundResult {
  return resolveRound(scenario.start, { A: move, B: scenario.rivalMove });
}
