import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { guideScenario, resolveGuideScenario } from "./guide-scenarios";
import { guideSummary, HowTo, RulesReference } from "./HowTo";

describe("beginner guide explanations", () => {
  it("offers exactly two learning choices and removes staged play", () => {
    const html = renderToStaticMarkup(<HowTo navigate={() => undefined} onStartPractice={() => undefined} />);
    expect(html).toContain("Learn with a bot");
    expect(html).toContain("Read the rules");
    expect(html).toContain("Untimed learning");
    expect(html).not.toContain("Lesson");
    expect(html).not.toContain("Reveal both moves");
    expect(html.match(/<button/g)).toHaveLength(3); // Home navigation plus two choices.
  });
  it("covers all powers, turn timing, opening and endings independently in static rules", () => {
    const html = renderToStaticMarkup(<RulesReference />);
    for (const text of ["zero Energy", "Selecting a space never locks", "ten seconds", "three seconds", "Expand · free", "Ambush · free", "Surge · 3 Energy total", "Override · 2 Energy", "automatic Pass", "12 rounds", "sudden death", "3 sudden-death", "collisions", "refund", "pre-round", "−1", "−2"]) expect(html).toContain(text);
    expect(html).toContain("Normal opening");
    expect(html).toContain("Partial Surge");
  });

  it("describes actual Surge alternatives, numerical steals, and partial collisions", () => {
    const scenario = guideScenario("surge", "collision");
    const partial = { type: "surge", target: 13, secondTarget: 12 } as const;
    const result = resolveGuideScenario(scenario, partial);
    const text = guideSummary(partial, result);
    expect(text).toContain("D3 was stolen from the rival");
    expect(text).toContain("C3 stays empty because both players claimed it");
    expect(text).toContain("+1 from stealing; rival −1");
    expect(text).toContain("3 Energy total; collisions do not refund Energy or stop other targets");
    expect(result.score).toEqual({ A: 2, B: 0 });
    expect(result.state.energy.A).toBe(0);
    const alternative = { type: "surge", target: 7 } as const;
    expect(guideSummary(alternative, resolveGuideScenario(scenario, alternative))).toContain("C2 was empty and is now yours");
    const steal = guideScenario("surge", "steal");
    const two = { type: "surge", target: 12, secondTarget: 13 } as const;
    expect(guideSummary(two, resolveGuideScenario(steal, two))).toContain("+2 from stealing; rival −2");
  });

  it("explains Ambush hits, misses, no capture, and the Energy cap", () => {
    const scenario = guideScenario("ambush");
    const hit = { type: "ambush", target: 12 } as const;
    const result = resolveGuideScenario(scenario, hit);
    expect(guideSummary(hit, result)).toContain("earned 1 Energy");
    expect(guideSummary(hit, result)).toContain("does not capture the target; it stays empty");
    expect(result.state.board[12]).toBe("neutral");
    const capped = { ...scenario, start: { ...scenario.start, energy: { A: 3, B: 0 } } };
    expect(guideSummary(hit, resolveGuideScenario(capped, hit))).toContain("already at the cap of 3");
    const miss = { type: "ambush", target: 8 } as const;
    const missed = resolveGuideScenario(scenario, miss);
    expect(guideSummary(miss, missed)).toContain("D2 missed the rival’s move (Expand C3)");
    expect(guideSummary(miss, missed)).toContain("earned 0 Energy");
    expect(missed.state.energy.A).toBe(0);
    expect(missed.state.board[12]).toBe("B");
  });

  it("distinguishes an Expand collision from an Ambush hit in both guide modes", () => {
    const scenario = guideScenario("ambush");
    const expand = { type: "expand", target: 12 } as const;
    const ambush = { type: "ambush", target: 12 } as const;
    const collision = resolveGuideScenario(scenario, expand);
    const hit = resolveGuideScenario(scenario, ambush);
    expect(collision.state.board).toEqual(hit.state.board);
    expect(collision.state.energy.A).toBe(0);
    expect(hit.state.energy.A).toBe(1);
    expect(guideSummary(expand, collision)).toContain("neither gains territory or earns Energy");
    const html = renderToStaticMarkup(<RulesReference />);
    expect(html).toContain("An Expand collision leaves the space empty and earns no Energy.");
    expect(html).toContain("If the rival chooses elsewhere, Expand can still capture your target; Ambush captures nothing.");
    expect(html).toContain("At 3 Energy, a successful Ambush and an Expand collision can have the same immediate result.");
  });

  it("describes the chosen Expand and Override coordinates and score changes", () => {
    const expand = guideScenario("expand");
    const move = { type: "expand", target: 10 } as const;
    expect(guideSummary(move, resolveGuideScenario(expand, move))).toContain("A3 was empty");
    const override = guideScenario("override");
    const steal = { type: "override", target: 12 } as const;
    expect(guideSummary(steal, resolveGuideScenario(override, steal))).toContain("2 Energy: you +1 territory, rival −1");
  });

  it("explains Pass without incorrectly restarting sudden death after a final draw", () => {
    const draw = guideScenario("finish", "single", "draw");
    const pass = { type: "pass" } as const;
    expect(guideSummary(pass, resolveGuideScenario(draw, pass))).toBe("You passed: your move took no territory and spent no Energy.");
  });
});
