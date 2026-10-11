import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialState, legalActions, resolveRound, score, validateAction, type Action } from "../shared/rules";
import { HeroDemo } from "./HeroDemo";
import { createDemoMatch, createDemoState, DEMO_HISTORY, DEMO_RIVAL_MOVE, demoReducer } from "./hero-demo";

function commit(move: Action) {
  let demo = demoReducer(createDemoState(), { type: "action", actionType: move.type });
  if (move.type !== "pass") demo = demoReducer(demo, { type: "target", target: move.target });
  if (move.type === "surge" && move.secondTarget !== undefined) demo = demoReducer(demo, { type: "target", target: move.secondTarget });
  return demoReducer(demo, { type: "commit" });
}

describe("hero final-round scenario", () => {
  it("reaches the last sudden-death round from the default opening through legal play", () => {
    let match = createInitialState();
    for (const moves of DEMO_HISTORY) {
      expect(match.status).toBe("active");
      expect(validateAction(match, "A", moves.A).ok).toBe(true);
      expect(validateAction(match, "B", moves.B).ok).toBe(true);
      match = resolveRound(match, moves).state;
    }
    expect(match).toEqual(createDemoMatch());
    expect(match).toMatchObject({ round: 15, phase: "sudden-death", status: "active", energy: { A: 3, B: 0 } });
    expect(match.round).toBe(match.config.standardRounds + match.config.suddenDeathRounds);
    expect(score(match.board)).toEqual({ A: 10, B: 10 });
    expect(validateAction(match, "B", DEMO_RIVAL_MOVE).ok).toBe(true);
  });

  it.each([
    [{ type: "override", target: 17 }, "A", { A: 11, B: 10 }, "stolen"],
    [{ type: "surge", target: 13, secondTarget: 17 }, "A", { A: 12, B: 9 }, "stolen"],
    [{ type: "surge", target: 12, secondTarget: 17 }, "A", { A: 11, B: 9 }, "stolen"],
    [{ type: "expand", target: 3 }, null, { A: 11, B: 11 }, "claimed"],
    [{ type: "expand", target: 12 }, null, { A: 10, B: 10 }, "collision"],
    [{ type: "ambush", target: 12 }, null, { A: 10, B: 10 }, "ambush-hit"],
    [{ type: "ambush", target: 8 }, "B", { A: 10, B: 11 }, "ambush-missed"],
    [{ type: "pass" }, "B", { A: 10, B: 11 }, "passed"],
  ] as const)("resolves %j through the real engine", (move, winner, totals, reason) => {
    const result = resolveRound(createDemoMatch(), { A: move, B: DEMO_RIVAL_MOVE });
    expect(result.state).toMatchObject({ status: "finished", winner, endingReason: "sudden-death", round: 15 });
    expect(result.score).toEqual(totals);
    expect(result.outcomes.A.reason).toBe(reason);
  });

  it("finishes every legal choice and supports all three outcomes without mutating the start", () => {
    const match = createDemoMatch();
    const winners = new Set();
    for (const move of legalActions(match, "A")) {
      const result = resolveRound(match, { A: move, B: DEMO_RIVAL_MOVE });
      expect(result.state.status).toBe("finished");
      expect(result.score).toEqual(score(result.state.board));
      winners.add(result.state.winner);
    }
    expect(winners).toEqual(new Set(["A", "B", null]));
    expect(match).toEqual(createDemoMatch());
  });
});

describe("hero selection, commitment and replay", () => {
  it("starts without a selection or an exposed rival action", () => {
    const html = renderToStaticMarkup(<HeroDemo />);
    expect(html).toContain("Final round. Choose your move.");
    expect(html).toContain("Current territory score: you 10, rival 10");
    expect(html).toContain("Rival’s move is locked and hidden.");
    expect(html).not.toContain("Rival: Expand");
    expect(html).not.toContain("demo-marker");
    expect((html.match(/class="territory-label"/g) ?? [])).toHaveLength(20);
    expect(html).toContain('role="status"');
    expect(demoReducer(createDemoState(), { type: "commit" })).toEqual(createDemoState());
  });

  it("ignores illegal targets and clears the target on an action change", () => {
    const initial = createDemoState();
    expect(demoReducer(initial, { type: "target", target: 0 })).toBe(initial);
    const selected = demoReducer(initial, { type: "target", target: 12 });
    expect(selected.phase).toBe("choosing");
    expect(selected.result).toBeNull();
    expect(demoReducer(selected, { type: "action", actionType: "ambush" }).target).toBeNull();
  });

  it("locks selection, ignores rapid duplicate events, and reveals both before changing territory", () => {
    const locked = commit({ type: "override", target: 17 });
    expect(locked.phase).toBe("committed");
    expect(locked.result).toBeNull();
    expect(demoReducer(locked, { type: "commit" })).toBe(locked);
    expect(demoReducer(locked, { type: "target", target: 12 })).toBe(locked);
    expect(demoReducer(locked, { type: "action", actionType: "pass" })).toBe(locked);
    const revealed = demoReducer(locked, { type: "reveal", attempt: 0 });
    expect(revealed.result!.outcomes.B.action).toEqual(DEMO_RIVAL_MOVE);
    expect(revealed.match).toEqual(createDemoMatch());
    expect(demoReducer(revealed, { type: "reveal", attempt: 0 })).toBe(revealed);
    const finished = demoReducer(revealed, { type: "finish", attempt: 0 });
    expect(finished.match).toEqual(revealed.result!.state);
    expect(finished.match.energy.A).toBe(1);
    expect(finished.result!.outcomes.A.energySpent).toBe(2);
    expect(demoReducer(finished, { type: "finish", attempt: 0 })).toBe(finished);
  });

  it("toggles two Surge targets, replaces the second on a third choice, and clears both on action change", () => {
    let demo = demoReducer(createDemoState(), { type: "action", actionType: "surge" });
    for (const target of [13, 17]) demo = demoReducer(demo, { type: "target", target });
    expect(demo).toMatchObject({ target: 13, secondTarget: 17, phase: "choosing", result: null });
    demo = demoReducer(demo, { type: "target", target: 22 });
    expect(demo).toMatchObject({ target: 13, secondTarget: 22 });
    demo = demoReducer(demo, { type: "target", target: 13 });
    expect(demo).toMatchObject({ target: 22, secondTarget: null });
    demo = demoReducer(demo, { type: "target", target: 17 });
    expect(demoReducer(demo, { type: "action", actionType: "override" })).toMatchObject({ target: null, secondTarget: null });
  });

  it("commits both Surge targets once and resets captures, selection and stale events", () => {
    const locked = commit({ type: "surge", target: 13, secondTarget: 17 });
    expect(demoReducer(locked, { type: "commit" })).toBe(locked);
    const revealed = demoReducer(locked, { type: "reveal", attempt: 0 });
    expect(revealed.result!.outcomes.A.action).toEqual({ type: "surge", target: 13, secondTarget: 17 });
    const finished = demoReducer(revealed, { type: "finish", attempt: 0 });
    expect(finished.result!.score).toEqual({ A: 12, B: 9 });
    expect(finished.match.energy.A).toBe(0);
    const reset = demoReducer(finished, { type: "reset" });
    expect(reset).toEqual({ ...createDemoState(), attempt: 1 });
    expect(demoReducer(reset, { type: "finish", attempt: 0 })).toBe(reset);
  });

  it.each(["committed", "revealed", "finished"] as const)("fully resets from %s and rejects stale animation events", (phase) => {
    let demo = commit({ type: "override", target: 17 });
    if (phase !== "committed") demo = demoReducer(demo, { type: "reveal", attempt: 0 });
    if (phase === "finished") demo = demoReducer(demo, { type: "finish", attempt: 0 });
    const reset = demoReducer(demo, { type: "reset" });
    expect(reset).toEqual({ ...createDemoState(), attempt: 1 });
    expect(reset.match).not.toBe(demo.match);
    expect(demoReducer(reset, { type: "reveal", attempt: 0 })).toBe(reset);
    const next = demoReducer(demoReducer(reset, { type: "action", actionType: "pass" }), { type: "commit" });
    expect(demoReducer(next, { type: "reveal", attempt: 0 })).toBe(next);
    const revealed = demoReducer(next, { type: "reveal", attempt: 1 });
    expect(revealed.result!.outcomes.B.action).toEqual(DEMO_RIVAL_MOVE);
    expect(revealed.result!.state.winner).toBe("B");
  });

  it("replays different endings repeatedly with the same start and rival move", () => {
    let demo = createDemoState();
    for (let attempt = 0; attempt < 12; attempt++) {
      const move: Action = attempt % 2 ? { type: "pass" } : { type: "override", target: 17 };
      demo = demoReducer(demo, { type: "action", actionType: move.type });
      if (move.type !== "pass") demo = demoReducer(demo, { type: "target", target: move.target });
      demo = demoReducer(demo, { type: "commit" });
      demo = demoReducer(demo, { type: "reveal", attempt });
      demo = demoReducer(demo, { type: "finish", attempt });
      expect(demo.match.winner).toBe(attempt % 2 ? "B" : "A");
      expect(demo.result!.outcomes.B.action).toEqual(DEMO_RIVAL_MOVE);
      demo = demoReducer(demo, { type: "reset" });
      expect(demo).toEqual({ ...createDemoState(), attempt: attempt + 1 });
    }
  });
});
