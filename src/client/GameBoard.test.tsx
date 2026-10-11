import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialState } from "../shared/rules";
import { GameBoard } from "./GameBoard";

function renderBoard(you: "A" | "B" = "A") {
  return renderToStaticMarkup(<GameBoard board={createInitialState().board} legal={[]} target={null}
    disabled onTarget={() => undefined} you={you} />);
}

describe("territory labels on shared boards", () => {
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
