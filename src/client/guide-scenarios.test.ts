import { describe, expect, it } from "vitest";
import { legalActions, legalTargets, resolveRound, score, validateAction } from "../shared/rules";
import { DEMO_HISTORY } from "./hero-demo";
import { GUIDE_LESSONS, guideScenario, resolveGuideScenario, SURGE_EXAMPLES } from "./guide-scenarios";

describe("How to play lesson positions", () => {
  it("offers suggestions without restricting engine-valid targets or Surge target counts", () => {
    const scenarios = [
      ...GUIDE_LESSONS.map((lesson) => guideScenario(lesson.id)),
      ...SURGE_EXAMPLES.map((example) => guideScenario("surge", example.id)),
      ...(["standard-win", "sudden-lead", "draw"] as const).map((example) => guideScenario("finish", "single", example)),
    ];
    for (const scenario of scenarios) {
      expect(scenario).not.toHaveProperty("allowedTargets");
      expect(scenario).not.toHaveProperty("targetCount");
    }
    const single = guideScenario("surge", "single");
    expect(single).toHaveProperty("suggestedTargets", [12]);
    expect(legalTargets(single.start, "A", "surge")).toEqual([1, 5, 6, 7, 10, 12, 13, 15, 16, 17, 21]);
  });

  it("allows turning Surge paths but rejects direct diagonal Expand and Override", () => {
    const surge = guideScenario("surge").start;
    expect(validateAction(surge, "A", { type: "surge", target: 7 })).toEqual({ ok: true });
    expect(validateAction(surge, "A", { type: "expand", target: 7 })).toEqual({ ok: false, reason: "not-adjacent" });
    const override = guideScenario("override").start;
    expect(validateAction(override, "A", { type: "override", target: 7 })).toEqual({ ok: false, reason: "not-adjacent" });
    expect(validateAction(surge, "A", { type: "surge", target: 13, secondTarget: 14 })).toEqual({ ok: false, reason: "out-of-range" });
    expect(validateAction(surge, "A", { type: "surge", target: 12, secondTarget: 12 })).toEqual({ ok: false, reason: "invalid-target" });
  });
  it("starts every lesson from an active position and uses legal fixed rival moves", () => {
    for (const lesson of GUIDE_LESSONS) {
      const scenario = guideScenario(lesson.id);
      expect(scenario.start.status, lesson.id).toBe("active");
      expect(validateAction(scenario.start, "B", scenario.rivalMove), lesson.id).toEqual({ ok: true });
      if (lesson.action === "pass") continue;
      for (const target of scenario.suggestedTargets ?? []) {
        expect(legalTargets(scenario.start, "A", lesson.action), `${lesson.id} target ${target}`).toContain(target);
      }
    }
  });

  it("demonstrates Ambush hits and misses through the shared resolver", () => {
    const scenario = guideScenario("ambush");
    const hit = resolveGuideScenario(scenario, { type: "ambush", target: 12 });
    const miss = resolveGuideScenario(scenario, { type: "ambush", target: 8 });
    expect(hit.outcomes.A.reason).toBe("ambush-hit");
    expect(hit.state.energy.A).toBe(scenario.start.energy.A + 3);
    expect(hit.state.energy.B).toBe(0);
    expect(miss.state.energy.A).toBe(scenario.start.energy.A - 1);
    expect(miss.outcomes.A.reason).toBe("ambush-missed");
    expect(miss.state.board[12]).toBe("B");
  });

  it("resolves Surge variants as a one-space move or two-target move", () => {
    const single = guideScenario("surge", "single");
    const singleResult = resolveGuideScenario(single, { type: "surge", target: 12 });
    expect(singleResult.outcomes.A.cells?.[0]).toMatchObject({ success: true, reason: "claimed" });
    expect(singleResult.state.energy.A).toBe(0);

    const mixed = guideScenario("surge", "mixed");
    const mixedResult = resolveGuideScenario(mixed, { type: "surge", target: 10, secondTarget: 13 });
    expect(mixedResult.outcomes.A.cells?.map((cell) => cell.reason)).toEqual(["claimed", "stolen"]);
    expect(mixedResult.score).toEqual(score(mixedResult.state.board));

    const collision = guideScenario("surge", "collision");
    const collisionResult = resolveGuideScenario(collision, { type: "surge", target: 10, secondTarget: 12 });
    expect(collisionResult.outcomes.A.cells?.map((cell) => cell.reason)).toEqual(["claimed", "collision"]);
    expect(collisionResult.state.board[10]).toBe("A");
    expect(collisionResult.state.board[12]).toBe("neutral");

    const steal = guideScenario("surge", "steal");
    const stealResult = resolveGuideScenario(steal, { type: "surge", target: 12, secondTarget: 13 });
    expect(stealResult.outcomes.A.cells?.map((cell) => cell.reason)).toEqual(["stolen", "stolen"]);
    expect(stealResult.score).toEqual({ A: 3, B: 0 });
  });

  it("keeps the same starting position and rival move across retries", () => {
    for (const example of SURGE_EXAMPLES) {
      const first = guideScenario("surge", example.id);
      const retry = guideScenario("surge", example.id);
      expect(retry.start).toEqual(first.start);
      expect(retry.rivalMove).toEqual(first.rivalMove);
    }
  });

  it("reaches round 12 from the recorded legal history and enters sudden death on a tie", () => {
    const beforeFinalRound = DEMO_HISTORY.slice(0, 11).reduce(
      (state, moves) => resolveRound(state, moves).state,
      guideScenario("expand").start,
    );
    expect(beforeFinalRound).toMatchObject({ round: 12, phase: "standard", status: "active" });
    const scenario = guideScenario("finish");
    expect(scenario.start).toEqual(beforeFinalRound);
    expect(legalActions(scenario.start, "A")).toContainEqual({ type: "pass" });
    const result = resolveGuideScenario(scenario, { type: "pass" });
    expect(result.state).toMatchObject({ round: 13, phase: "sudden-death", status: "active" });
    expect(result.score.A).toBe(result.score.B);
  });

  it("teaches a round-12 win, sudden-death lead, and draw with real outcomes", () => {
    const standard = guideScenario("finish", "single", "standard-win");
    expect(standard.start).toMatchObject({ round: 12, phase: "standard", status: "active" });
    const standardTarget = legalTargets(standard.start, "A", "expand")[0];
    const standardResult = resolveGuideScenario(standard, { type: "expand", target: standardTarget });
    expect(standardResult.state).toMatchObject({ status: "finished", winner: "A", endingReason: "standard" });

    const sudden = guideScenario("finish", "single", "sudden-lead");
    expect(sudden.start).toMatchObject({ round: 13, phase: "sudden-death", status: "active" });
    expect(score(sudden.start.board).A).toBe(score(sudden.start.board).B);
    const suddenTarget = legalTargets(sudden.start, "A", "expand")[0];
    const suddenResult = resolveGuideScenario(sudden, { type: "expand", target: suddenTarget });
    expect(suddenResult.state).toMatchObject({ status: "finished", winner: "A", endingReason: "sudden-death" });

    const draw = guideScenario("finish", "single", "draw");
    expect(draw.start).toMatchObject({ round: 15, phase: "sudden-death", status: "active" });
    const drawResult = resolveGuideScenario(draw, { type: "pass" });
    expect(drawResult.state).toMatchObject({ status: "finished", winner: null, endingReason: "sudden-death" });
  });
});
