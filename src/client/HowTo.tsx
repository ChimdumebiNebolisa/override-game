import { useState } from "react";
import { actionTargets, createInitialState, type Action } from "../shared/rules";
import { GameBoard } from "./GameBoard";
import { guideScenario, resolveGuideScenario } from "./guide-scenarios";
const ACTION_LABEL: Record<Action["type"], string> = { expand: "Expand", ambush: "Ambush", surge: "Surge", override: "Override", pass: "Pass" };
const XY = (index: number) => `${String.fromCharCode(65 + index % 5)}${Math.floor(index / 5) + 1}`;
function moveLabel(action: Action) { return action.type === "pass" ? "Pass" : `${ACTION_LABEL[action.type]} ${actionTargets(action).map(XY).join(" + ")}`; }

export function HowTo({ navigate, onStartPractice }: {
  navigate: (screen: "home" | "quick" | "practice") => void;
  onStartPractice: () => void;
}) {
  const [rules, setRules] = useState(false);
  return <main className="panel-page how-page">
    <button className="back-link" onClick={() => navigate("home")}>← Home</button>
    <div className="guide-heading"><div><p className="eyebrow">OVERRIDE · field guide</p><h1>How to play</h1>
      <p>Finish with more territory than your rival. Choose in secret and reveal together.</p></div></div>
    <div className="learning-choices">
      <button className="secondary-cta" aria-expanded={rules} onClick={() => setRules((value) => !value)}>Read the rules</button>
      <button className="primary-cta" onClick={onStartPractice}>Learn with a bot <small>Untimed learning</small></button>
    </div>
    {rules && <RulesReference />}
  </main>;
}

export function guideSummary(action: Action, result: ReturnType<typeof resolveGuideScenario>): string {
  const outcome = result.outcomes.A;
  if (action.type === "surge") {
    const captured = outcome.cells?.filter((cell) => cell.success).length ?? 0;
    const stolen = outcome.cells?.filter((cell) => cell.reason === "stolen").length ?? 0;
    const collided = outcome.cells?.filter((cell) => cell.reason === "collision").length ?? 0;
    const cells = outcome.cells?.map((cell) => `${XY(cell.target)} ${cell.reason === "collision" ? "stays empty because both players claimed it" : cell.reason === "stolen" ? "was stolen from the rival" : "was empty and is now yours"}`).join(". ");
    return `${cells}. Surge gained you ${captured} ${captured === 1 ? "space" : "spaces"}${stolen ? ` (+${stolen} from stealing; rival −${stolen})` : ""}. It spent ${outcome.energySpent} Energy total${collided ? "; collisions do not refund Energy or stop other targets" : ""}.`;
  }
  if (outcome.reason === "ambush-hit") return `You predicted ${actionTargets(action).map(XY).join("")}, the rival’s exact Expand target. Their Expand failed. You earned ${outcome.energyEarned} Energy${outcome.energyEarned === 0 ? " because Energy was already at the cap of 3" : " (capped at 3)"}. Ambush does not capture the target; it stays empty.`;
  if (outcome.reason === "ambush-missed") return `Your prediction ${actionTargets(action).map(XY).join("")} missed the rival’s move (${moveLabel(result.outcomes.B.action)}). You earned 0 Energy and captured no space. Ambush blocks only an Expand to the exact target.`;
  if (outcome.reason === "collision") return `Both players claimed ${actionTargets(action).map(XY).join("")}. It stays empty, so neither gains territory or earns Energy.`;
  if (action.type === "override") return `${XY(action.target)} was rival-owned and one step up, down, left, or right from your territory. Override stole it for ${outcome.energySpent} Energy: you +1 territory, rival −1.`;
  if (action.type === "expand") return `${XY(action.target)} was empty and one step up, down, left, or right from your territory. Expand claimed it: you +1 territory.`;
  return "You passed: your move took no territory and spent no Energy.";
}

export function RulesReference() {
  const facing = guideScenario("surge", "mixed").start;
  const mixed = resolveGuideScenario(guideScenario("surge", "mixed"), { type: "surge", target: 10, secondTarget: 13 });
  const partialStart = guideScenario("surge", "collision").start;
  const partial = resolveGuideScenario(guideScenario("surge", "collision"), { type: "surge", target: 10, secondTarget: 12 });
  return (
    <article className="rules-reference">
      <header><p className="eyebrow">Read the rules · reference</p><h2>One board. Two hidden moves.</h2><p>Both players choose from the same starting board. The game reveals both moves and scores territory after resolution.</p></header>
      <section className="rules-section"><h3>Goal and board</h3><p>Finish with more spaces than your rival. The blue circle is Player A; the coral diamond is Player B. These diagrams show you as Player A. Real matches assign sides at random.</p><p>The 5×5 board starts with four spaces for each player and zero Energy. Open spaces are neutral.</p><GameBoard board={createInitialState().board} legal={[]} target={null} disabled label="Normal opening: opposing 2 by 2 corners, four spaces each" onTarget={() => undefined} /></section>
      <section className="rules-section"><h3>Round sequence</h3><ol><li>Choose an action and its target or targets.</li><li>Lock your move. Your rival cannot see it.</li><li>Both moves reveal together, then the board and score update.</li></ol><p>Selecting a space never locks it. You may edit your choice until Lock is accepted. New timed rounds last ten seconds. Human moves reveal when both lock or time expires, followed by three seconds of reveal. Bot matches wait for Next round after each result.</p></section>
      <section className="rules-section"><h3>Actions</h3>
        <div className="rule-action"><h4>Expand · free</h4><p>Expand takes one empty space directly above, below, left, or right of a space you own. Ambush can block it if the rival predicts the same target.</p></div>
        <div className="rule-action"><h4>Ambush · free</h4><p>Predict the empty space your rival will Expand into. The target must be one step up, down, left, or right from rival territory. If you pick their exact target, their Expand fails and you gain 1 Energy, capped at 3. A miss earns no Energy. Ambush does not capture the target and never blocks Surge or Override.</p></div>
        <details><summary>Ambush and collision exceptions</summary><p>An Expand collision leaves the space empty and earns no Energy. A successful Ambush also leaves it empty, but earns 1 Energy unless you already have 3. If the rival chooses elsewhere, Expand can still capture your target; Ambush captures nothing. At 3 Energy, a successful Ambush and an Expand collision can have the same immediate result.</p></details>
        <div className="rule-action"><h4>Surge · 3 Energy total</h4><p>Claim or steal one or two distinct spaces for 3 Energy total. Select one space, then optionally select a second before locking; both are part of the same move. Tap a selected space to remove it; a third choice replaces the second. Each target must be one or two steps up, down, left, or right from territory you owned before the round. Targets can be empty, rival-owned, or one of each. Capturing one does not extend the other’s range. Stealing one gives you +1 territory and your rival −1; stealing two gives you +2 and your rival −2.</p></div>
        <div className="rule-action"><h4>Override · 2 Energy</h4><p>Steal one rival-owned space directly above, below, left, or right of your territory. Empty spaces are illegal. A diagonal position alone does not qualify; the target must be directly beside at least one space you own. Stealing gives you +1 territory and your rival −1.</p></div>
        <div className="rule-action"><h4>Pass · free</h4><p>Take no action this round. No space or Energy is needed. A timed deadline supplies an automatic Pass if you have not locked. Results distinguish it from a Pass you locked yourself.</p></div>
      </section>
      <section className="rules-section"><h3>Energy</h3><p>You start with 0 Energy. A successful Ambush adds 1, up to the cap of 3. Surge spends 3 once, whether you choose one space or two. Override spends 2. A collision does not refund Energy.</p></section>
      <details className="rules-section"><summary>Grid distance examples</summary><p>Count steps up, down, left, or right from territory owned before the round. A path may turn: a diagonally positioned space can be two steps away. Both moves resolve together from this pre-round board.</p>
        <DistanceDiagram action="expand" />
        <DistanceDiagram action="override" />
        <DistanceDiagram action="surge" />
      </details>
      <section className="rules-section"><h3>Simultaneous reveal and collisions</h3><p>If both players claim the same open space with Expand or Surge, neither captures that space. Other targets in a two-target Surge still resolve. A hit by Ambush blocks only Expand, never Surge or Override. Actions resolve from the same pre-round board.</p>
        <div className="rule-examples"><figure><figcaption>Before · You Surge A3 + D3</figcaption><GameBoard board={facing.board} legal={[]} target={null} disabled label="Surge example before · you Player A at B3, rival Player B at D3" onTarget={() => undefined} /></figure>
          <figure><figcaption>After · open A3 claimed, rival D3 stolen</figcaption><GameBoard board={mixed.state.board} legal={[]} target={null} disabled label="Surge example after · Player A owns A3 and D3" onTarget={() => undefined} /><p>Territory: You {mixed.score.A} — Rival {mixed.score.B}</p></figure>
        </div>
        <div className="rule-examples"><figure><figcaption>Before · You Surge A3 + C3; rival Expands C3</figcaption><GameBoard board={partialStart.board} legal={[]} target={null} disabled label="Partial Surge collision before resolution" onTarget={() => undefined} /></figure>
          <figure><figcaption>After · A3 succeeds; C3 collides</figcaption><GameBoard board={partial.state.board} legal={[]} target={null} disabled label="Partial Surge collision after resolution" onTarget={() => undefined} /><p>You capture one space; C3 stays open.</p></figure>
        </div>
      </section>
      <section className="rules-section"><h3>Match endings</h3><p>After 12 rounds, the higher territory score wins. A tie starts sudden death. A new lead ends the match; if scores stay tied for all 3 sudden-death rounds, the match is a draw.</p>
        <details><summary>Other endings</summary><p>The board can end early when there are no empty spaces and neither player has a legal Surge or Override capture. An abandoned timed match can also end by forfeit. A finished score counts spaces owned by each player.</p></details>
      </section>
    </article>
  );
}

function DistanceDiagram({ action }: { action: "expand" | "override" | "surge" }) {
  const surge = action === "surge";
  const caption = surge ? "Surge can reach C2 because moving right once and up once takes two steps. B3 → C3 → C2 turns; B3 → C3 → D3 goes straight. Both are in range."
    : action === "expand" ? "Expand: B3 → C3 is one step right to an empty space. Diagonal C2 cannot be taken directly from B3."
      : "Override: B3 → C3 is one step right to a rival-owned space. Diagonal C2 cannot be stolen directly from B3.";
  const steps: Record<number, string> = { 11: "B3 ●", 12: action === "override" ? "C3 ◆" : surge ? "C3 ↑" : "C3 →", 7: surge ? "C2 ②" : "C2 ×", 13: surge ? "D3 ②" : "" };
  return <div className="distance-example"><div className="distance-grid" role="img" aria-label={caption}>
    {Array.from({ length: 25 }, (_, index) => <span key={index} className={index === 11 ? "source" : index === 12 ? "step" : surge && (index === 7 || index === 13) ? "target" : ""}>{steps[index] ?? ""}</span>)}
  </div><p>{caption}</p></div>;
}
