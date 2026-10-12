import { createInitialState, resolveRound } from "../shared/rules";
import { DEMO_HISTORY } from "./hero-demo";

const before = DEMO_HISTORY.slice(0, 4).reduce((match, moves) => resolveRound(match, moves).state, createInitialState());
const reveal = resolveRound(before, { A: { type: "ambush", target: 12 }, B: { type: "expand", target: 12 } });

export function HeroDemo() {
  return <figure className="hero-demo" aria-labelledby="demo-title">
    <header className="demo-heading">
      <p className="demo-kicker">SIMULTANEOUS REVEAL</p>
      <h2 id="demo-title">Their move.<br />Your territory.</h2>
    </header>
    <div className="demo-moves" aria-label="Revealed moves">
      <span className="demo-move-you"><small>You</small><strong>Ambush C3</strong></span>
      <span className="demo-move-rival"><small>Rival</small><strong>Expand C3</strong></span>
    </div>
    <div className="demo-board" role="img" aria-label={`Ambush reveal: your blue territory captures C3 and stops the rival’s Expand. Territory: you ${reveal.score.A}, rival ${reveal.score.B}.`}>
      <span className="demo-axis" aria-hidden="true" />
      {"ABCDE".split("").map((column) => <span key={column} className="demo-axis" aria-hidden="true">{column}</span>)}
      {Array.from({ length: 5 }, (_, row) => [
        <span key={`row-${row}`} className="demo-axis" aria-hidden="true">{row + 1}</span>,
        ...reveal.state.board.slice(row * 5, row * 5 + 5).map((owner, column) => {
          const captured = row * 5 + column === 12;
          return <span key={row * 5 + column} className={`demo-cell ${owner}${captured ? " captured" : ""}`} aria-hidden="true">
            <span className="demo-node" />
            {captured && <span className="demo-capture-mark">+1</span>}
          </span>;
        }),
      ])}
    </div>
    <figcaption className="demo-caption"><span>AMBUSH · C3 CAPTURED</span><p>You read their Expand.<br />You took the space.</p></figcaption>
  </figure>;
}
