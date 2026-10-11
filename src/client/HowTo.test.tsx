import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { legalTargets } from "../shared/rules";
import { GUIDE_LESSONS, guideScenario, resolveGuideScenario, SURGE_EXAMPLES } from "./guide-scenarios";
import { guideSummary, HowTo, LessonExperience } from "./HowTo";

describe("beginner guide explanations", () => {
  it("passes the full engine target set through the actual lesson component", () => {
    const examples = [
      ...GUIDE_LESSONS.map((lesson) => ({ lesson: lesson.id, surgeExample: "single" as const, finishExample: "standard-win" as const })),
      ...SURGE_EXAMPLES.map((example) => ({ lesson: "surge" as const, surgeExample: example.id, finishExample: "standard-win" as const })),
      ...(["sudden-lead", "draw"] as const).map((example) => ({ lesson: "finish" as const, surgeExample: "single" as const, finishExample: example })),
    ];
    for (const example of examples) {
      const lessonIndex = GUIDE_LESSONS.findIndex((lesson) => lesson.id === example.lesson);
      const scenario = guideScenario(example.lesson, example.surgeExample, example.finishExample);
      const action = example.lesson === "finish" && example.finishExample !== "draw" ? "expand" : GUIDE_LESSONS[lessonIndex].action;
      const legal = action === "pass" ? [] : legalTargets(scenario.start, "A", action);
      const html = renderToStaticMarkup(<LessonExperience {...example} lessonIndex={lessonIndex} onBack={() => undefined} onNext={() => undefined} />);
      const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map((match) => match[1]).filter((attributes) => attributes.includes('board-cell'));
      expect(buttons).toHaveLength(25);
      buttons.forEach((button, index) => {
        expect(button.includes('disabled=""'), `${example.lesson}/${example.surgeExample} target ${index}`).toBe(!legal.includes(index));
        expect(button.includes('legal target')).toBe(legal.includes(index));
      });
    }
  });
  it("explains rules before selection and keeps both tabs, six lessons, and distance examples", () => {
    const html = renderToStaticMarkup(<HowTo navigate={() => undefined} onStartPractice={() => undefined} />);
    expect(html).toContain("Learn by playing");
    expect(html).toContain("Read the rules");
    expect(html).toContain("Lesson 1 of 6");
    expect(html.indexOf("Expand takes one empty space directly above, below, left, or right of a space you own.")).toBeLessThan(html.indexOf("Choose one highlighted space."));
    expect(html).toContain("Legal targets: C1, C2, A3, B3");
    expect(html).toContain("Numbered badges are suggestions; all highlighted spaces are legal.");
    expect(html).toContain("Surge can reach C2 because moving right once and up once takes two steps.");
    expect(html).toContain("Expand: B3 → C3 is one step right to an empty space.");
    expect(html).toContain("Override: B3 → C3 is one step right to a rival-owned space.");
    expect(html).toContain("Select one space, then optionally select a second before locking; both are part of the same move.");
    expect(html).toContain("A diagonal position alone does not qualify; the target must be directly beside at least one space you own.");
    expect(html).not.toContain("orthogonal");
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
    const lesson = renderToStaticMarkup(<LessonExperience lesson="ambush" lessonIndex={2} surgeExample="single" finishExample="standard-win" onBack={() => undefined} onNext={() => undefined} />);
    const reference = renderToStaticMarkup(<HowTo navigate={() => undefined} onStartPractice={() => undefined} />);
    for (const html of [lesson, reference]) {
      expect(html).toContain("An Expand collision leaves the space empty and earns no Energy.");
      expect(html).toContain("If the rival chooses elsewhere, Expand can still capture your target; Ambush captures nothing.");
      expect(html).toContain("At 3 Energy, a successful Ambush and an Expand collision can have the same immediate result.");
    }
    expect(lesson.indexOf("An Expand collision")).toBeLessThan(lesson.indexOf("Choose an empty space directly beside rival territory"));
  });

  it("describes the chosen Expand and Override coordinates and score changes", () => {
    const expand = guideScenario("expand");
    const move = { type: "expand", target: 10 } as const;
    expect(guideSummary(move, resolveGuideScenario(expand, move))).toContain("A3 was empty");
    const override = guideScenario("override");
    const steal = { type: "override", target: 12 } as const;
    expect(guideSummary(steal, resolveGuideScenario(override, steal))).toContain("2 Energy: you +1 territory, rival −1");
  });

  it("explains simultaneous collisions and match endings before the instruction", () => {
    const render = (lesson: "collision" | "surge" | "finish", surgeExample: "collision" | "single" = "single") => renderToStaticMarkup(
      <LessonExperience lesson={lesson} lessonIndex={GUIDE_LESSONS.findIndex((entry) => entry.id === lesson)} surgeExample={surgeExample} finishExample="standard-win" onBack={() => undefined} onNext={() => undefined} />,
    );
    const collision = render("collision");
    expect(collision.indexOf("Both moves resolve together from the board at the start of the round.")).toBeGreaterThan(0);
    expect(collision.indexOf("Both moves resolve together")).toBeLessThan(collision.indexOf("C3 is the only open space. Lock"));
    const partial = render("surge", "collision");
    expect(partial).toContain("Your other Surge target still resolves, and all 3 Energy are spent.");
    const finish = render("finish");
    expect(finish.indexOf("A tie starts up to three sudden-death rounds")).toBeGreaterThan(0);
    expect(finish.indexOf("A tie starts up to three sudden-death rounds")).toBeLessThan(finish.indexOf("It’s round 12."));
  });

  it("explains Pass without incorrectly restarting sudden death after a final draw", () => {
    const draw = guideScenario("finish", "single", "draw");
    const pass = { type: "pass" } as const;
    expect(guideSummary(pass, resolveGuideScenario(draw, pass))).toBe("You passed: your move took no territory and spent no Energy.");
  });
});
