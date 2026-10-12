import { describe, expect, it } from "vitest";
import {
  createInitialState, legalActions, legalTargets, resolveRound, score, validateAction,
  type Action, type Board, type MatchState,
} from "./rules";

const pass: Action = { type: "pass" };
const action = (type: "expand" | "ambush" | "surge" | "override", target: number): Action => ({ type, target });

function board(rows: string[]): Board {
  return rows.join("").split("").map((cell) => cell === "." ? "neutral" : cell as "A" | "B");
}

function state(rows: string[], energyA = 0, energyB = 0, round = 1): MatchState {
  return {
    ...createInitialState(), board: board(rows), energy: { A: energyA, B: energyB }, round,
  };
}

const facing = [".....", ".....", ".A.B.", ".....", "....."];

describe("action Energy costs", () => {
  it.each([
    [0, false, false], [1, false, false], [1.5, false, false], [2, true, false], [2.5, true, false], [3, true, true], [5, true, true],
  ] as const)("with %i Energy, Override affordability is %s and Surge affordability is %s", (energy, canOverride, canSurge) => {
    const current = state([".....", ".....", ".AB..", ".....", "....."], energy);
    for (const [move, affordable, spent] of [
      [action("override", 12), canOverride, 2], [action("surge", 10), canSurge, 3],
    ] as const) {
      expect(validateAction(current, "A", move).ok).toBe(affordable);
      expect(legalActions(current, "A").some((candidate) => candidate.type === move.type)).toBe(affordable);
      if (affordable) {
        const result = resolveRound(current, { A: move, B: pass });
        expect(result.outcomes.A.energySpent).toBe(spent);
        expect(result.state.energy.A).toBe(energy - spent);
      } else {
        expect(() => resolveRound(current, { A: move, B: pass })).toThrow("insufficient-energy");
      }
    }
  });
});

describe("opening and legality", () => {
  it("starts with the exact opposite 2x2 corners and full Energy", () => {
    const opening = createInitialState();
    expect(opening.board.map((cell) => cell === "neutral" ? "." : cell).join(""))
      .toBe("AA...AA...........BB...BB");
    expect(score(opening.board)).toEqual({ A: 4, B: 4 });
    expect(opening.energy).toEqual({ A: 5, B: 5 });
    expect(opening.round).toBe(1);
  });

  it("uses orthogonal adjacency without wrapping across a row", () => {
    const current = state(["...A.", ".....", ".....", ".....", "....B"]);
    expect(legalTargets(current, "A", "expand")).toEqual([2, 4, 8]);
    expect(validateAction(current, "A", action("expand", 5))).toEqual({ ok: false, reason: "not-adjacent" });
    expect(validateAction(current, "A", action("expand", 3))).toEqual({ ok: false, reason: "occupied-target" });
    expect(validateAction(current, "A", action("expand", 25))).toEqual({ ok: false, reason: "invalid-target" });
  });

  it("targets the opponent's legal Expand nodes with Ambush", () => {
    const current = state(facing, 1);
    expect(legalTargets(current, "A", "ambush")).toEqual([8, 12, 14, 18]);
    expect(validateAction(current, "A", action("ambush", 10))).toEqual({ ok: false, reason: "not-adjacent" });
  });

  it("lets disconnected territory act and gates Surge and Override on Energy", () => {
    const current = state(["A....", ".....", ".....", ".....", "A..BB"], 0, 3);
    expect(legalTargets(current, "A", "surge")).toEqual([]);
    expect(validateAction(current, "A", action("surge", 2))).toEqual({ ok: false, reason: "insufficient-energy" });
    const charged = { ...current, energy: { A: 3, B: 3 } };
    expect(legalTargets(charged, "A", "surge")).toContain(2);
    expect(legalTargets(charged, "A", "surge")).toContain(21);
    expect(validateAction(charged, "A", action("surge", 3))).toEqual({ ok: false, reason: "out-of-range" });
    expect(legalTargets(charged, "A", "override")).toEqual([]);
    expect(legalTargets(charged, "B", "override")).toEqual([]);
    expect(legalActions(charged, "A")).toContainEqual(pass);
  });
});

describe("simultaneous resolution", () => {
  it("lets one Surge steal two rival cells for 3 Energy total", () => {
    const before = state([".....", ".....", ".ABB.", ".....", "....."], 3);
    const move: Action = { type: "surge", target: 12, secondTarget: 13 };
    expect(validateAction(before, "A", move)).toEqual({ ok: true });
    expect(legalActions(before, "A")).toContainEqual(move);
    const result = resolveRound(before, { A: move, B: pass });
    expect(result.score).toEqual({ A: 3, B: 0 });
    expect(result.state.energy.A).toBe(0);
    expect(result.outcomes.A).toMatchObject({ success: true, energySpent: 3, cells: [
      { target: 12, success: true, reason: "stolen" },
      { target: 13, success: true, reason: "stolen" },
    ] });
    expect(before.board).toEqual(board([".....", ".....", ".ABB.", ".....", "....."]));
  });

  it("allows a mix of neutral and rival targets, without Ambush interception", () => {
    const before = state([".....", ".....", ".ABB.", ".....", "....."], 3, 1);
    const result = resolveRound(before, { A: { type: "surge", target: 6, secondTarget: 12 }, B: action("ambush", 6) });
    expect(result.score).toEqual({ A: 3, B: 1 });
    expect(result.outcomes.A.cells).toEqual([
      { target: 6, success: true, reason: "claimed" },
      { target: 12, success: true, reason: "stolen" },
    ]);
    expect(result.outcomes.B.reason).toBe("ambush-missed");
  });

  it.each([action("expand", 12), { type: "surge", target: 14, secondTarget: 12 } as Action])(
    "collides only on the shared cell against %j", (rival) => {
      const before = state(facing, 3, 3);
      const a: Action = { type: "surge", target: 10, secondTarget: 12 };
      const result = resolveRound(before, { A: a, B: rival });
      expect(result.state.board[10]).toBe("A");
      expect(result.state.board[12]).toBe("neutral");
      expect(result.outcomes.A).toMatchObject({ success: true, energySpent: 3, cells: [
        { target: 10, success: true, reason: "claimed" },
        { target: 12, success: false, reason: "collision" },
      ] });
      if (rival.type === "surge") {
        expect(result.state.board[14]).toBe("B");
        expect(result.state.energy).toEqual({ A: 0, B: 0 });
      }
      expect(resolveRound(before, { B: rival, A: a })).toEqual(result);
    },
  );

  it("resolves mutual two-cell steals from the pre-round board", () => {
    const before = state([".....", ".....", ".AABB", ".....", "....."], 3, 3);
    const result = resolveRound(before, {
      A: { type: "surge", target: 13, secondTarget: 14 },
      B: { type: "surge", target: 11, secondTarget: 12 },
    });
    expect(result.state.board.slice(11, 15)).toEqual(["B", "B", "A", "A"]);
    expect(result.score).toEqual({ A: 2, B: 2 });
  });

  it("spends Surge Energy even when both neutral targets collide", () => {
    const before = state(facing, 3, 3);
    const result = resolveRound(before, {
      A: { type: "surge", target: 7, secondTarget: 12 },
      B: { type: "surge", target: 12, secondTarget: 7 },
    });
    expect(result.state.board).toEqual(before.board);
    expect(result.state.energy).toEqual({ A: 0, B: 0 });
    for (const player of ["A", "B"] as const) {
      expect(result.outcomes[player]).toMatchObject({ success: false, reason: "collision", energySpent: 3 });
      expect(result.outcomes[player].cells!.every((cell) => !cell.success && cell.reason === "collision")).toBe(true);
    }
  });

  it("validates both Surge targets against the starting board and rejects duplicates", () => {
    const before = state(facing, 3);
    for (const [secondTarget, reason] of [
      [12, "invalid-target"], [25, "invalid-target"], [11, "occupied-target"], [4, "out-of-range"],
    ] as const) {
      const move: Action = { type: "surge", target: 12, secondTarget };
      expect(validateAction(before, "A", move)).toEqual({ ok: false, reason });
      expect(() => resolveRound(before, { A: move, B: pass })).toThrow(reason);
    }
    // The first capture cannot extend the second target's range in the same round.
    expect(validateAction(before, "A", { type: "surge", target: 1 }).ok).toBe(true);
    expect(validateAction(before, "A", { type: "surge", target: 1, secondTarget: 0 })).toEqual({ ok: false, reason: "out-of-range" });
    expect(validateAction({ ...before, energy: { A: 2, B: 0 } }, "A", { type: "surge", target: 12, secondTarget: 13 }))
      .toEqual({ ok: false, reason: "insufficient-energy" });
    const pairs = legalActions(before, "A").filter((move) => move.type === "surge" && move.secondTarget !== undefined);
    const targets = legalTargets(before, "A", "surge");
    expect(pairs).toHaveLength(targets.length * (targets.length - 1) / 2);
    for (const move of pairs) expect(validateAction(before, "A", move)).toEqual({ ok: true });
  });

  it.each([
    ["Expand/Expand different", action("expand", 10), action("expand", 14), "claimed", "claimed"],
    ["Expand/Expand same", action("expand", 12), action("expand", 12), "collision", "collision"],
    ["Expand/Surge different", action("expand", 10), action("surge", 9), "claimed", "claimed"],
    ["Expand/Surge same", action("expand", 12), action("surge", 12), "collision", "collision"],
    ["Surge/Surge different", action("surge", 5), action("surge", 9), "claimed", "claimed"],
    ["Surge/Surge same", action("surge", 12), action("surge", 12), "collision", "collision"],
  ] as const)("%s", (_name, a, b, reasonA, reasonB) => {
    const before = state(facing, 3, 3);
    const result = resolveRound(before, { A: a, B: b });
    expect(result.outcomes.A.reason).toBe(reasonA);
    expect(result.outcomes.B.reason).toBe(reasonB);
    if (a.type !== "pass" && b.type !== "pass" && "target" in a && "target" in b && a.target === b.target) {
      expect(result.state.board[a.target]).toBe("neutral");
    }
    expect(result.state.energy.A).toBe(3 - (a.type === "surge" ? 3 : 0) + (a.type === "expand" && reasonA === "claimed" ? 0.5 : 0));
    expect(result.state.energy.B).toBe(3 - (b.type === "surge" ? 3 : 0) + (b.type === "expand" && reasonB === "claimed" ? 0.5 : 0));
    expect(before.board).toEqual(board(facing));
    expect(before.energy).toEqual({ A: 3, B: 3 });
  });

  it("rewards a correct Ambush after blocking Expand, available next round", () => {
    const before = state(facing, 2);
    const result = resolveRound(before, { A: action("ambush", 12), B: action("expand", 12) });
    expect(result.outcomes.A).toMatchObject({ success: true, reason: "ambush-hit", energyEarned: 3 });
    expect(result.outcomes.B.reason).toBe("intercepted");
    expect(result.state.board[12]).toBe("neutral");
    expect(before.energy.A).toBe(2);
    expect(result.state.energy.A).toBe(5);
    expect(legalTargets(before, "A", "surge")).toEqual([]);
    expect(legalTargets(result.state, "A", "surge")).not.toEqual([]);
  });

  it("does not reward a missed or capped Ambush", () => {
    const missed = resolveRound(state(facing, 1), { A: action("ambush", 8), B: action("expand", 12) });
    expect(missed.outcomes.A.reason).toBe("ambush-missed");
    expect(missed.state.board[12]).toBe("B");
    expect(missed.state.energy.A).toBe(0);
    const capped = resolveRound(state(facing, 5), { A: action("ambush", 12), B: action("expand", 12) });
    expect(capped.outcomes.A.reason).toBe("ambush-hit");
    expect(capped.outcomes.A.energyEarned).toBe(0);
    expect(capped.state.energy.A).toBe(5);
  });

  it("does not intercept Surge or Override", () => {
    const surge = resolveRound(state(facing, 1, 3), { A: action("ambush", 12), B: action("surge", 12) });
    expect(surge.outcomes.A.reason).toBe("ambush-missed");
    expect(surge.state.board[12]).toBe("B");
    const override = resolveRound(state([".....", ".....", ".AB..", ".....", "....."], 1, 3), {
      A: action("ambush", 13), B: action("override", 11),
    });
    expect(override.outcomes.A.reason).toBe("ambush-missed");
    expect(override.outcomes.B.reason).toBe("stolen");
    expect(override.state.board[11]).toBe("B");
  });

  it("resolves two Ambushes and Pass without territorial effects", () => {
    const both = resolveRound(state(facing, 1, 1), { A: action("ambush", 12), B: action("ambush", 12) });
    expect(both.outcomes.A.reason).toBe("ambush-missed");
    expect(both.outcomes.B.reason).toBe("ambush-missed");
    expect(both.score).toEqual({ A: 1, B: 1 });
    const one = resolveRound(state(facing), { A: pass, B: action("expand", 12) });
    expect(one.outcomes.A.reason).toBe("passed");
    expect(one.state.board[12]).toBe("B");
    const none = resolveRound(state(facing), { A: null, B: pass });
    expect(none.outcomes.A.reason).toBe("automatic-pass");
    expect(none.outcomes.B.reason).toBe("passed");
  });

  it("resolves mutual Overrides from the pre-round board, independent of action order", () => {
    const before = state([".....", ".....", ".AB..", ".....", "....."], 3, 3);
    const a = action("override", 12);
    const b = action("override", 11);
    const result = resolveRound(before, { A: a, B: b });
    expect(result.state.board[11]).toBe("B");
    expect(result.state.board[12]).toBe("A");
    expect(result.state.energy).toEqual({ A: 1, B: 1 });
    expect(result.outcomes.A.reason).toBe("stolen");
    expect(result.outcomes.B.reason).toBe("stolen");
    expect(resolveRound(before, { B: b, A: a })).toEqual(result);
    expect(before.board[11]).toBe("A");
    expect(before.board[12]).toBe("B");
  });

  it("allows an unrelated Expand when the opponent Overrides its supporting territory", () => {
    const before = state([".....", ".....", ".AB..", ".....", "....."], 0, 3);
    const result = resolveRound(before, { A: action("expand", 10), B: action("override", 11) });
    expect(result.state.board[10]).toBe("A");
    expect(result.state.board[11]).toBe("B");
    expect(result.outcomes.A.reason).toBe("claimed");
    expect(result.outcomes.B.reason).toBe("stolen");
  });

  it("rejects invalid submitted actions instead of converting them to Pass", () => {
    const before = state(facing);
    expect(validateAction(before, "A", action("surge", 12))).toEqual({ ok: false, reason: "insufficient-energy" });
    expect(() => resolveRound(before, { A: action("surge", 12), B: pass }))
      .toThrow("Invalid A action: insufficient-energy");
    expect(resolveRound(before, { A: null, B: pass }).outcomes.A.reason).toBe("automatic-pass");
  });

  it("validates both actions on the pre-round board and replays identically", () => {
    const before = state(facing, 3, 3);
    const submitted = { A: action("expand", 12), B: action("override", 12) };
    expect(validateAction(before, "B", submitted.B)).toEqual({ ok: false, reason: "occupied-target" });
    expect(() => resolveRound(before, submitted)).toThrow("Invalid B action: occupied-target");
    const valid = { A: action("expand", 12), B: action("expand", 14) };
    expect(resolveRound(before, valid)).toEqual(resolveRound(before, valid));
  });

  it("cannot produce a legal same-cell Override pairing", () => {
    const before = state([".....", ".....", ".AB..", ".....", "....."], 3, 3);
    const a = legalTargets(before, "A", "override");
    const b = legalTargets(before, "B", "override");
    expect(a).toEqual([12]);
    expect(b).toEqual([11]);
    expect(a.filter((target) => b.includes(target))).toEqual([]);
  });

  it("cannot produce a same-cell Override pairing with any targeted action", () => {
    const before = state([".....", ".....", ".AB..", ".....", "....."], 3, 3);
    const types = ["expand", "ambush", "surge", "override"] as const;
    const actionsA = legalActions(before, "A");
    const actionsB = legalActions(before, "B");

    expect(actionsA.some((candidate) => candidate.type === "override")).toBe(true);
    expect(actionsB.some((candidate) => candidate.type === "override")).toBe(true);
    for (const actionA of actionsA) {
      for (const actionB of actionsB) {
        if (actionA.type === "pass" || actionB.type === "pass" ||
            (actionA.type !== "override" && actionB.type !== "override")) continue;
        expect(actionA.target).not.toBe(actionB.target);
      }
    }

    for (const target of before.board.keys()) {
      for (const type of types) {
        const overrideA = validateAction(before, "A", action("override", target));
        const otherB = validateAction(before, "B", action(type, target));
        expect(overrideA.ok && otherB.ok).toBe(false);

        const otherA = validateAction(before, "A", action(type, target));
        const overrideB = validateAction(before, "B", action("override", target));
        expect(otherA.ok && overrideB.ok).toBe(false);
      }
    }
  });
});

describe("match progression", () => {
  it("ends after the final standard round when territory differs", () => {
    const before = state(facing, 0, 0, 12);
    const result = resolveRound(before, { A: action("expand", 10), B: pass });
    expect(result.state).toMatchObject({ status: "finished", winner: "A", endingReason: "standard", round: 12 });
    expect(validateAction(result.state, "A", pass)).toEqual({ ok: false, reason: "match-finished" });
  });

  it("enters sudden death on a standard-round tie, then ends on first lead", () => {
    const tied = resolveRound(state(facing, 0, 0, 12), { A: pass, B: pass });
    expect(tied.state).toMatchObject({ status: "active", phase: "sudden-death", round: 13 });
    const decided = resolveRound(tied.state, { A: action("expand", 10), B: pass });
    expect(decided.state).toMatchObject({ status: "finished", winner: "A", endingReason: "sudden-death" });
  });

  it("draws after three tied sudden-death rounds", () => {
    let current = resolveRound(state(facing, 0, 0, 12), { A: pass, B: pass }).state;
    for (let round = 13; round <= 15; round++) current = resolveRound(current, { A: pass, B: pass }).state;
    expect(current).toMatchObject({ status: "finished", winner: null, endingReason: "sudden-death", round: 15 });
    expect(current.energy).toEqual({ A: 0, B: 0 });
  });

  it("ends a full board without a legal Override immediately", () => {
    const full = state(["AAAAA", "AAAAA", "AAAAA", "BBBBB", "BBBBB"]);
    const result = resolveRound(full, { A: pass, B: pass });
    expect(result.state).toMatchObject({ status: "finished", winner: "A", endingReason: "board-exhaustion", round: 1 });
  });

  it("keeps a full board active while an Override is legal", () => {
    const full = state(["AAAAA", "AAAAA", "AAAAA", "BBBBB", "BBBBB"], 3, 0);
    const result = resolveRound(full, { A: pass, B: pass });
    expect(result.state).toMatchObject({ status: "active", round: 2 });
    expect(legalTargets(result.state, "A", "override")).toContain(15);
  });

  it("resolves a third connected miss before applying forfeit over score", () => {
    const before = state([".....", ".....", "AA.B.", ".A...", "....."], 0, 0, 12);
    const result = resolveRound(before, { A: null, B: action("expand", 14) }, "A");
    expect(result.state.board[14]).toBe("B");
    expect(result.score).toEqual({ A: 3, B: 2 });
    expect(result.outcomes.A.reason).toBe("automatic-pass");
    expect(result.state).toMatchObject({ status: "finished", winner: "B", endingReason: "forfeit", round: 12 });
    expect(() => resolveRound(before, { A: pass, B: pass }, "A"))
      .toThrow("A connected-miss forfeit requires an automatic Pass");
  });
});
