import { describe, expect, it } from "vitest";
import { chooseBotAction, type BotDifficulty } from "./bots";
import { createInitialState, legalActions, resolveRound, validateAction, type Action, type MatchState } from "./rules";

function state(rows: string[], energyA = 0, energyB = 0): MatchState {
  return {
    ...createInitialState(),
    board: rows.join("").split("").map((cell) => cell === "." ? "neutral" : cell as "A" | "B"),
    energy: { A: energyA, B: energyB },
  };
}

const facing = state([".....", ".....", ".A.B.", ".....", "....."]);
const difficulties: BotDifficulty[] = ["easy", "normal", "hard"];

describe("bot policies", () => {
  it("always returns a legal action for either side across the three policies", () => {
    for (const difficulty of difficulties) {
      for (const player of ["A", "B"] as const) {
        for (const seed of [0, 1, 8, 9, 42]) {
          const current = { ...facing, energy: { A: 3, B: 3 } };
          const chosen = chooseBotAction(current, player, difficulty, [], seed);
          expect(validateAction(current, player, chosen)).toEqual({ ok: true });
          expect(legalActions(current, player)).toContainEqual(chosen);
        }
      }
    }
  });

  it("makes Easy favor Expand while occasionally trying Ambush and affordable Surge", () => {
    const choices = Array.from({ length: 10 }, (_, seed) => chooseBotAction(facing, "A", "easy", [], seed));
    expect(choices.filter((chosen) => chosen.type === "expand")).toHaveLength(8);
    expect(choices[8].type).toBe("ambush");
    expect(chooseBotAction({ ...facing, energy: { A: 1, B: 0 } }, "A", "easy", [], 9).type).toBe("surge");
  });

  it("uses Normal's board and Energy assessment to choose a safe Expand or a useful Override", () => {
    const expansion = chooseBotAction(facing, "A", "normal");
    expect(expansion.type).toBe("expand");
    if (expansion.type !== "pass") expect(expansion.target).not.toBe(12);
    const full = state(["AAAAA", "AAAAA", "AAAAA", "BBBBB", "BBBBB"], 3);
    expect(chooseBotAction(full, "A", "normal").type).toBe("override");
  });

  it("uses only the last three revealed opponent actions for Hard predictions", () => {
    const previousExpand: Action = { type: "expand", target: 13 };
    const recent = [previousExpand, previousExpand, previousExpand];
    expect(chooseBotAction(facing, "A", "hard", recent)).toEqual({ type: "ambush", target: 12 });
    const oldOnly = [previousExpand, previousExpand, ...Array<Action>(3).fill({ type: "pass" })];
    expect(chooseBotAction(facing, "A", "hard", oldOnly).type).toBe("expand");
  });

  it("repeats the same choice for the same public state, history, and seed without mutating inputs", () => {
    const history: Action[] = [{ type: "expand", target: 13 }];
    const boardBefore = [...facing.board];
    const first = chooseBotAction(facing, "A", "hard", history, 71);
    expect(chooseBotAction(facing, "A", "hard", history, 71)).toEqual(first);
    expect(facing.board).toEqual(boardBefore);
    expect(history).toEqual([{ type: "expand", target: 13 }]);
  });

  it("plays seeded complete matches legally at every difficulty", () => {
    for (const difficulty of difficulties) {
      const play = () => {
        let current = createInitialState();
        const history: Record<"A" | "B", Action[]> = { A: [], B: [] };
        const trace: Array<{ A: Action; B: Action }> = [];
        const maxRounds = current.config.standardRounds + current.config.suddenDeathRounds + 1;

        for (let round = 0; current.status === "active" && round < maxRounds; round++) {
          const actions = {
            A: chooseBotAction(current, "A", difficulty, history.B.slice(-3), 2026 + round),
            B: chooseBotAction(current, "B", difficulty, history.A.slice(-3), 2026 + round),
          };
          expect(validateAction(current, "A", actions.A)).toEqual({ ok: true });
          expect(validateAction(current, "B", actions.B)).toEqual({ ok: true });

          trace.push(actions);
          const result = resolveRound(current, actions);
          current = result.state;
          history.A.push(result.outcomes.A.action);
          history.B.push(result.outcomes.B.action);
        }

        expect(current.status, `${difficulty} match should terminate`).toBe("finished");
        return trace;
      };
      expect(play()).toEqual(play());
    }
  });

  it("passes when no territory move exists and rejects a finished state", () => {
    const full = state(["AAAAA", "AAAAA", "AAAAA", "BBBBB", "BBBBB"]);
    for (const difficulty of difficulties) expect(chooseBotAction(full, "A", difficulty)).toEqual({ type: "pass" });
    const finished: MatchState = { ...full, status: "finished", winner: "A", endingReason: "standard" };
    expect(() => chooseBotAction(finished, "A", "normal")).toThrow("finished match");
  });
});
