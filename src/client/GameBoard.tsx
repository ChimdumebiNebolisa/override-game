import type { MatchState } from "../shared/rules";

const coordinate = (index: number) => `${String.fromCharCode(65 + (index % 5))}${Math.floor(index / 5) + 1}`;

export function GameBoard({ board, legal, target, secondTarget = null, disabled, onTarget, label = "5 by 5 territory grid" }: {
  board: MatchState["board"];
  legal: number[];
  target: number | null;
  secondTarget?: number | null;
  disabled: boolean;
  onTarget: (target: number) => void;
  label?: string;
}) {
  return (
    <div className="board-grid" role="group" aria-label={label}>
      <span className="axis corner" aria-hidden="true" />
      {["A", "B", "C", "D", "E"].map((name) => <span className="axis" aria-hidden="true" key={name}>{name}</span>)}
      {board.map((cell, index) => {
        const row = Math.floor(index / 5);
        const isLegal = legal.includes(index);
        return (
          <span className="cell-slot" key={index}>
            {index % 5 === 0 && <span className="axis row-axis" aria-hidden="true">{row + 1}</span>}
            <button
              className={`board-cell owner-${cell} ${isLegal ? "legal" : ""} ${target === index || secondTarget === index ? "targeted" : ""}`}
              onClick={() => isLegal && onTarget(index)}
              disabled={disabled || !isLegal}
              aria-label={`${coordinate(index)}, ${cell === "neutral" ? "open" : `owned by player ${cell}`}${isLegal ? ", legal target" : ""}`}
              aria-pressed={target === index || secondTarget === index}
            >
              {cell === "A" ? <span>●</span> : cell === "B" ? <span>◆</span> : <span className="node-dot" />}
            </button>
          </span>
        );
      })}
    </div>
  );
}
