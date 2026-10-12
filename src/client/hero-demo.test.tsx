import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialState, resolveRound, score, validateAction } from "../shared/rules";
import { HeroDemo } from "./HeroDemo";
import { createDemoMatch, DEMO_HISTORY } from "./hero-demo";

describe("hero reveal and guide history", () => {
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

  it("shows a real capture without presenting game controls", () => {
    const html = renderToStaticMarkup(<HeroDemo />);
    expect(html).toContain('role="img"');
    expect(html).toContain('Territory: you 9, rival 8');
    expect(html).toContain('demo-cell A captured');
    expect(html).toContain('AMBUSH · C3 CAPTURED');
    expect(html).toContain('Ambush C3');
    expect(html).toContain('Expand C3');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<select');
  });
});
