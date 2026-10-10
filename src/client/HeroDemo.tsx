import { useEffect, useReducer, useRef } from "react";
import { actionTargets, legalTargets, score, type Action } from "../shared/rules";
import { createDemoState, demoExplanation, demoReducer, selectedDemoMove } from "./hero-demo";

const ACTIONS = [
  { type: "expand", label: "Expand", cost: 0, hint: "Claim an open space beside your territory." },
  { type: "ambush", label: "Ambush", cost: 0, hint: "Predict their Expand to block the claim." },
  { type: "surge", label: "Surge", cost: 3, hint: "Take up to two open or rival spaces within two steps. Tap again to deselect." },
  { type: "override", label: "Override", cost: 2, hint: "Steal a rival space beside your territory." },
  { type: "pass", label: "Pass", cost: 0, hint: "Sit this round out. No space needed." },
] as const;

const coordinate = (index: number) => `${String.fromCharCode(65 + index % 5)}${Math.floor(index / 5) + 1}`;
const moveText = (action: Action) => `${ACTIONS.find((item) => item.type === action.type)!.label}${action.type === "pass" ? "" : ` ${actionTargets(action).map(coordinate).join(" + ")}`}`;

export function HeroDemo() {
  const [demo, dispatch] = useReducer(demoReducer, undefined, createDemoState);
  const actionRef = useRef<HTMLSelectElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const finished = demo.phase === "finished";
  const choosing = demo.phase === "choosing";
  const revealed = demo.phase === "revealed" || finished;
  const selected = selectedDemoMove(demo);
  const totals = score(demo.match.board);
  const targets = demo.actionType === "pass" ? [] : legalTargets(demo.match, "A", demo.actionType);
  const action = ACTIONS.find((item) => item.type === demo.actionType)!;
  const resultTitle = demo.result?.state.winner === "A" ? "You win." : demo.result?.state.winner === "B" ? "You lose." : "Draw.";

  useEffect(() => {
    if (demo.phase !== "committed" && demo.phase !== "revealed") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => dispatch({
      type: demo.phase === "committed" ? "reveal" : "finish", attempt: demo.attempt,
    }), reducedMotion ? 0 : demo.phase === "committed" ? 350 : 850);
    return () => window.clearTimeout(timer);
  }, [demo.phase, demo.attempt]);

  useEffect(() => {
    if (finished && (document.activeElement === document.body || sectionRef.current?.contains(document.activeElement))) {
      retryRef.current?.focus({ preventScroll: true });
    }
  }, [finished]);
  useEffect(() => { if (demo.attempt > 0) actionRef.current?.focus({ preventScroll: true }); }, [demo.attempt]);

  return (
    <section ref={sectionRef} className="hero-demo" data-phase={demo.phase} aria-labelledby="demo-title">
      <header className="demo-heading">
        <p className="demo-kicker">Play the last round <span>15 / 15 · sudden death</span></p>
        <h2 id="demo-title">{finished ? resultTitle : demo.phase === "committed" ? "Move committed." : demo.phase === "revealed" ? "Both moves revealed." : "Final round. Choose your move."}</h2>
      </header>
      <div className="demo-score" aria-label={`${finished ? "Final" : "Current"} territory score: you ${totals.A}, rival ${totals.B}`}>
        <span><i className="demo-owner you" aria-hidden="true" />You <b>{totals.A}</b></span>
        <small>{finished ? "Final territory" : "Territory"}</small>
        <span><b>{totals.B}</b>Rival <i className="demo-owner rival" aria-hidden="true" /></span>
      </div>
      <div className="demo-action-row">
        <label htmlFor="demo-action">Your action
          <select id="demo-action" ref={actionRef} value={demo.actionType} disabled={!choosing}
            aria-describedby="demo-action-hint" onChange={(event) => dispatch({ type: "action", actionType: event.target.value as Action["type"] })}>
            {ACTIONS.map((item) => <option key={item.type} value={item.type}>{item.label} · {item.cost ? `${item.cost} Energy` : "free"}</option>)}
          </select>
        </label>
        <span className="demo-energy">Your Energy <b>{demo.match.energy.A} / 3</b></span>
      </div>
      <p id="demo-action-hint" className="demo-hint">{action.hint}</p>
      <div key={demo.attempt} className="demo-board" role="group" aria-label="Final round board. Highlighted spaces are legal choices.">
        <span className="demo-axis" aria-hidden="true" />
        {"ABCDE".split("").map((column) => <span key={column} className="demo-axis" aria-hidden="true">{column}</span>)}
        {Array.from({ length: 5 }, (_, row) => [
          <span key={`row-${row}`} className="demo-axis" aria-hidden="true">{row + 1}</span>,
          ...demo.match.board.slice(row * 5, row * 5 + 5).map((owner, column) => {
            const index = row * 5 + column;
            const legal = choosing && targets.includes(index);
            const mine = revealed && actionTargets(demo.result!.outcomes.A.action).includes(index);
            const theirs = revealed && actionTargets(demo.result!.outcomes.B.action).includes(index);
            const changed = finished && Boolean(demo.result!.outcomes.A.cells?.some((cell) => cell.target === index && cell.success) || demo.result!.outcomes.B.cells?.some((cell) => cell.target === index && cell.success));
            const isSelected = demo.target === index || demo.secondTarget === index;
            const ownerText = owner === "A" ? "your territory" : owner === "B" ? "rival territory" : "open";
            return <button key={index} className={`demo-cell ${owner} ${legal ? "legal" : ""} ${isSelected ? "selected" : ""} ${mine ? "move-you" : ""} ${theirs ? "move-rival" : ""} ${changed ? "changed" : ""}`}
              disabled={!legal} aria-label={`${coordinate(index)}, ${ownerText}${legal ? `, choose ${action.label}` : ""}`}
              aria-pressed={isSelected} onClick={() => dispatch({ type: "target", target: index })}>
              <span className="demo-node" aria-hidden="true" />
              {(mine || theirs) && <span className="demo-marker" aria-hidden="true">{mine && theirs ? "Both" : mine ? "You" : "Rival"}</span>}
            </button>;
          }),
        ])}
      </div>
      <div className="demo-feedback" role="status" aria-live="polite" aria-atomic="true">
        {revealed ? <>
          <p className="demo-revealed-moves"><span>You: {moveText(demo.result!.outcomes.A.action)}</span><span>Rival: {moveText(demo.result!.outcomes.B.action)}</span></p>
          <p>{finished ? `${resultTitle} ${totals.A}–${totals.B}. ${demoExplanation(demo.result!)}` : "Both moves are in. Resolving territory…"}</p>
        </> : <>
          <p>{demo.phase === "committed" ? "Locked in. Revealing together…" : selected ? `${moveText(selected)} selected. Commit when ready.` : "Choose an action, then a highlighted space."}</p>
          <p className="demo-secret">Rival’s move is locked and hidden.</p>
        </>}
      </div>
      {finished ? <button ref={retryRef} className="demo-commit" onClick={() => dispatch({ type: "reset" })}>Try another move <span aria-hidden="true">↺</span></button> :
        <button className="demo-commit" disabled={!choosing || !selected} onClick={() => dispatch({ type: "commit" })}>
          {choosing ? "Commit move" : "Move committed"}<span aria-hidden="true">{choosing ? "→" : "✓"}</span>
        </button>}
    </section>
  );
}
