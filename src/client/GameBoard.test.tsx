import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialState, legalTargets } from "../shared/rules";
import { GameBoard } from "./GameBoard";
import { GUIDE_LESSONS, guideScenario, SURGE_EXAMPLES } from "./guide-scenarios";

function renderBoard(you: "A" | "B" = "A") {
  return renderToStaticMarkup(<GameBoard board={createInitialState().board} legal={[]} target={null}
    disabled onTarget={() => undefined} you={you} />);
}

describe("territory labels on shared boards", () => {
  it("renders every engine-valid lesson target as enabled, with separate suggestion badges", () => {
    const examples = [
      ...GUIDE_LESSONS.filter((lesson) => lesson.action !== "pass").map((lesson) => ({ scenario: guideScenario(lesson.id), action: lesson.action })),
      ...SURGE_EXAMPLES.map((example) => ({ scenario: guideScenario("surge", example.id), action: "surge" as const })),
      ...(["standard-win", "sudden-lead"] as const).map((example) => ({ scenario: guideScenario("finish", "single", example), action: "expand" as const })),
    ];
    for (const { scenario, action } of examples) {
      const legal = legalTargets(scenario.start, "A", action);
      const html = renderToStaticMarkup(<GameBoard board={scenario.start.board} legal={legal} suggested={scenario.suggestedTargets}
        target={null} disabled={false} onTarget={() => undefined} />);
      const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map((match) => match[1]);
      expect(buttons).toHaveLength(25);
      buttons.forEach((button, index) => {
        expect(button.includes('legal target'), `target ${index}`).toBe(legal.includes(index));
        expect(button.includes('disabled=""'), `target ${index}`).toBe(!legal.includes(index));
        expect(button.includes('suggested step'), `target ${index}`).toBe(scenario.suggestedTargets?.includes(index) ?? false);
      });
      expect((html.match(/class="suggested-target"/g) ?? []).length).toBe(scenario.suggestedTargets?.length ?? 0);
    }
  });
  it("labels each owner as You or Rival from Player A's perspective", () => {
    const html = renderBoard();

    expect((html.match(/class="territory-label"/g) ?? [])).toHaveLength(8);
    expect((html.match(/>You<\/span>/g) ?? [])).toHaveLength(4);
    expect((html.match(/>Rival<\/span>/g) ?? [])).toHaveLength(4);
    expect(html).toContain("A1, your territory");
    expect(html).toContain("E5, rival territory");
  });

  it("keeps You and Rival labels correct when the local player is Player B", () => {
    const html = renderBoard("B");

    expect((html.match(/>You<\/span>/g) ?? [])).toHaveLength(4);
    expect((html.match(/>Rival<\/span>/g) ?? [])).toHaveLength(4);
    expect(html).toContain("A1, rival territory");
    expect(html).toContain("E5, your territory");
  });
});
