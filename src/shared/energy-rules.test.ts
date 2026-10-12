import { describe, expect, it } from "vitest";
import { createInitialState, legalActions, legalTargets, resolveRound, validateAction, type MatchState, type Player } from "./rules";

const pass = { type: "pass" } as const;
function facing(a: number, b: number): MatchState {
  const board = Array<MatchState["board"][number]>(25).fill("neutral");
  board[11] = "A"; board[13] = "B";
  return { ...createInitialState(), board, energy: { A: a, B: b } };
}

describe("revised Energy rules", () => {
  it("starts both players at the full configured cap", () => {
    expect(createInitialState().energy).toEqual({ A: 5, B: 5 });
    expect(createInitialState().config.energyCap).toBe(5);
    expect(createInitialState({ energyCap: 3 }).energy).toEqual({ A: 3, B: 3 });
  });

  it.each([0, 2.5, 4.5, 5])("rewards a successful Expand from %s Energy without exceeding the cap", (energy) => {
    const before = facing(energy, 2);
    const result = resolveRound(before, { A: { type: "expand", target: 10 }, B: pass });
    expect(result.state.energy.A).toBe(Math.min(5, energy + 0.5));
    expect(result.outcomes.A.energyEarned).toBe(Math.min(0.5, 5 - energy));
    expect(result.state.board[10]).toBe("A");
    expect(before.energy.A).toBe(energy);
  });

  it.each(["A", "B"] as const)("allows %s to Ambush a space beside both players", (player: Player) => {
    const rival = player === "A" ? "B" : "A";
    const before = facing(1, 1);
    expect(legalTargets(before, player, "ambush")).toContain(12);
    expect(validateAction(before, player, { type: "ambush", target: 12 })).toEqual({ ok: true });
    const result = resolveRound(before, { [player]: { type: "ambush", target: 12 }, [rival]: { type: "expand", target: 12 } } as Parameters<typeof resolveRound>[1]);
    expect(result.state.board[12]).toBe("neutral");
    expect(result.state.energy[player]).toBe(4);
    expect(result.state.energy[rival]).toBe(0);
    expect(result.outcomes[player]).toMatchObject({ energyEarned: 3, energyDrained: 1, energySpent: 0 });
    expect(result.outcomes[rival].energyEarned).toBe(0);
  });

  it.each([0, 0.5, 1, 2, 5])("drains a rival holding %s Energy and grants the full reward", (energy) => {
    const result = resolveRound(facing(1, energy), { A: { type: "ambush", target: 12 }, B: { type: "expand", target: 12 } });
    expect(result.state.energy).toEqual({ A: 4, B: Math.max(0, energy - 2) });
    expect(result.outcomes.A).toMatchObject({ energyEarned: 3, energyDrained: Math.min(2, energy) });
  });

  it.each([4, 4.5, 5])("still drains the rival when the reward is capped from %s Energy", (energy) => {
    const result = resolveRound(facing(energy, 5), { A: { type: "ambush", target: 12 }, B: { type: "expand", target: 12 } });
    expect(result.state.energy).toEqual({ A: 5, B: 3 });
    expect(result.outcomes.A).toMatchObject({ energyEarned: 5 - energy, energyDrained: 2 });
  });

  it.each([1, 1.5, 5])("charges exactly one Energy on a miss from %s", (energy) => {
    const result = resolveRound(facing(energy, 2), { A: { type: "ambush", target: 8 }, B: { type: "expand", target: 12 } });
    expect(result.state.energy).toEqual({ A: energy - 1, B: 2.5 });
    expect(result.outcomes.A).toMatchObject({ success: false, reason: "ambush-missed", energySpent: 1, energyEarned: 0 });
    expect(result.outcomes.A.energyDrained ?? 0).toBe(0);
  });

  it.each([0, 0.5])("rejects Ambush below one Energy (%s)", (energy) => {
    const before = facing(energy, 5);
    expect(legalTargets(before, "A", "ambush")).toEqual([]);
    expect(legalActions(before, "A").some((action) => action.type === "ambush")).toBe(false);
    expect(validateAction(before, "A", { type: "ambush", target: 12 })).toEqual({ ok: false, reason: "insufficient-energy" });
    expect(() => resolveRound(before, { A: { type: "ambush", target: 12 }, B: pass })).toThrow("insufficient-energy");
  });

  it("rejects diagonal and wrapped Ambush targets", () => {
    const before = facing(5, 5);
    expect(validateAction(before, "A", { type: "ambush", target: 7 })).toEqual({ ok: false, reason: "not-adjacent" });
    const edge = { ...before, board: before.board.map((_, index) => index === 4 ? "B" as const : "neutral" as const) };
    expect(validateAction(edge, "A", { type: "ambush", target: 5 })).toEqual({ ok: false, reason: "not-adjacent" });
  });

  it("rewards neither an Expand collision nor an intercepted Expand", () => {
    const collision = resolveRound(facing(2, 2), { A: { type: "expand", target: 12 }, B: { type: "expand", target: 12 } });
    expect(collision.state.energy).toEqual({ A: 2, B: 2 });
    expect(collision.outcomes.A.energyEarned).toBe(0);
    expect(collision.outcomes.B.energyEarned).toBe(0);
  });

  it("retains legacy caps and does not mutate the pre-round state", () => {
    const before = { ...facing(2.5, 1), config: { ...createInitialState().config, energyCap: 3 } };
    const saved = structuredClone(before);
    const result = resolveRound(before, { A: { type: "ambush", target: 12 }, B: { type: "expand", target: 12 } });
    expect(result.state.energy).toEqual({ A: 3, B: 0 });
    expect(result.state.config.energyCap).toBe(3);
    expect(before).toEqual(saved);
  });
});
