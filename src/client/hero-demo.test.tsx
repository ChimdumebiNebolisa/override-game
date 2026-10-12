import { describe, expect, it } from "vitest";
import { createInitialState, resolveRound, score, validateAction } from "../shared/rules";
import { createDemoMatch, DEMO_HISTORY } from "./hero-demo";

describe("guide history", () => {
  it("keeps the guide’s tied history legal under Ambush capture rules", () => {
    let match = createInitialState();
    for (const moves of DEMO_HISTORY) {
      expect(match.status).toBe("active");
      expect(validateAction(match, "A", moves.A).ok).toBe(true);
      expect(validateAction(match, "B", moves.B).ok).toBe(true);
      match = resolveRound(match, moves).state;
    }
    expect(match).toEqual(createDemoMatch());
    expect(match).toMatchObject({ round: 15, phase: "sudden-death", status: "active" });
    expect(score(match.board)).toEqual({ A: 10, B: 10 });
  });

});
