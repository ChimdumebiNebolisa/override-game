import { useRef, useState, type KeyboardEvent } from "react";
import { actionTargets, legalTargets, score, validateAction, type Action } from "../shared/rules";
import { GameBoard } from "./GameBoard";
import { GUIDE_LESSONS, guideScenario, resolveGuideScenario, SURGE_EXAMPLES, type FinishExampleId, type GuideLessonId, type SurgeExampleId } from "./guide-scenarios";
import { toggleSurgeTarget } from "./move-selection";

const ACTION_LABEL: Record<Action["type"], string> = {
  expand: "Expand", ambush: "Ambush", surge: "Surge", override: "Override", pass: "Pass",
};
const XY = (index: number) => `${String.fromCharCode(65 + index % 5)}${Math.floor(index / 5) + 1}`;
const cost = (type: Action["type"]) => type === "surge" ? 3 : type === "override" ? 2 : 0;

function moveLabel(action: Action) {
  return action.type === "pass" ? "Pass" : `${ACTION_LABEL[action.type]} ${actionTargets(action).map(XY).join(" + ")}`;
}

function summary(action: Action, result: ReturnType<typeof resolveGuideScenario>): string {
  const outcome = result.outcomes.A;
  if (action.type === "surge") {
    const captured = outcome.cells?.filter((cell) => cell.success).length ?? 0;
    const stolen = outcome.cells?.filter((cell) => cell.reason === "stolen").length ?? 0;
    const collided = outcome.cells?.filter((cell) => cell.reason === "collision").length ?? 0;
    return `Surge captured ${captured} ${captured === 1 ? "space" : "spaces"}${stolen ? `, stealing ${stolen} from the rival` : ""}${collided ? `; ${collided} target collided` : ""}. It spent 3 Energy.`;
  }
  if (outcome.reason === "ambush-hit") return `Your Ambush blocked Expand and earned ${outcome.energyEarned} Energy.`;
  if (outcome.reason === "ambush-missed") return "Your Ambush missed. The rival’s Expand claimed its target.";
  if (outcome.reason === "collision") return "Both Expands chose C3. It stays open, so neither score changes.";
  if (action.type === "override") return "You took one neighboring enemy space for 2 Energy.";
  if (action.type === "expand") return "You claimed an open neighboring space. Your territory score increased by one.";
  return result.state.phase === "sudden-death"
    ? "The score is tied after round 12. Sudden death starts; a lead ends the match."
    : `The match is tied at ${result.score.A}–${result.score.B}.`;
}

export function HowTo({ navigate, onStartPractice }: {
  navigate: (screen: "home" | "quick" | "practice") => void;
  onStartPractice: () => void;
}) {
  const [tab, setTab] = useState<"learn" | "rules">("learn");
  const [lesson, setLesson] = useState<GuideLessonId>("expand");
  const [surgeExample, setSurgeExample] = useState<SurgeExampleId>("single");
  const [finishExample, setFinishExample] = useState<FinishExampleId>("standard-win");
  const lessonIndex = GUIDE_LESSONS.findIndex((item) => item.id === lesson);
  const chooseLesson = (next: GuideLessonId) => {
    setLesson(next);
    if (next === "surge") setSurgeExample("single");
  };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setTab(event.key === "ArrowRight" ? "rules" : "learn");
    document.getElementById(`guide-tab-${event.key === "ArrowRight" ? "rules" : "learn"}`)?.focus();
  };
  return (
    <main className="panel-page how-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="guide-heading">
        <div><p className="eyebrow">OVERRIDE · field guide</p><h1>How to play</h1><p>Claim more spaces than your rival. Each round, you both choose in secret and reveal together.</p></div>
        <button className="primary-cta guide-start" onClick={() => navigate("quick")}>Start a game <span>→</span></button>
      </div>
      <div className="guide-legend" aria-label="Guide board legend">
        <span><i className="guide-piece you" aria-hidden="true">●</i>You · Player A</span>
        <span><i className="guide-piece rival" aria-hidden="true">◆</i>Rival · Player B</span>
        <span><i className="guide-open" aria-hidden="true" />Open space</span>
        <small>Your side stays blue throughout the lessons.</small>
      </div>
      <div className="guide-tabs" role="tablist" aria-label="How to play modes">
        <button id="guide-tab-learn" type="button" role="tab" aria-selected={tab === "learn"} aria-controls="guide-panel-learn" tabIndex={tab === "learn" ? 0 : -1} onClick={() => setTab("learn")} onKeyDown={tabKeyDown}>Learn by playing</button>
        <button id="guide-tab-rules" type="button" role="tab" aria-selected={tab === "rules"} aria-controls="guide-panel-rules" tabIndex={tab === "rules" ? 0 : -1} onClick={() => setTab("rules")} onKeyDown={tabKeyDown}>Read the rules</button>
      </div>
      <section id="guide-panel-learn" role="tabpanel" aria-labelledby="guide-tab-learn" hidden={tab !== "learn"}>
        <div className="guide-learn-intro"><div><h2>Learn by playing</h2><p>Untimed examples. Pick a move, lock it, then reveal both moves.</p></div><button className="secondary-cta" onClick={onStartPractice}>Beginner Practice <span>→</span></button></div>
        <nav className="lesson-nav" aria-label="Choose a lesson">
          {GUIDE_LESSONS.map((item, index) => <button key={item.id} type="button" aria-current={lesson === item.id ? "step" : undefined}
            onClick={() => chooseLesson(item.id)}><small>{String(index + 1).padStart(2, "0")}</small>{item.title}</button>)}
        </nav>
        {lesson === "surge" && <div className="surge-examples" role="group" aria-label="Surge examples">
          {SURGE_EXAMPLES.map((item, index) => <button type="button" key={item.id} aria-pressed={surgeExample === item.id}
            onClick={() => setSurgeExample(item.id)}><small>{String(index + 1).padStart(2, "0")}</small>{item.title}</button>)}
        </div>}
        {lesson === "finish" && <div className="surge-examples" role="group" aria-label="Match ending examples">
          {([
            ["standard-win", "Round 12 win"], ["sudden-lead", "Sudden-death lead"], ["draw", "Round 15 draw"],
          ] as const).map(([id, title], index) => <button type="button" key={id} aria-pressed={finishExample === id}
            onClick={() => setFinishExample(id)}><small>{String(index + 1).padStart(2, "0")}</small>{title}</button>)}
        </div>}
        <LessonExperience key={`${lesson}-${surgeExample}-${finishExample}`} lesson={lesson} lessonIndex={lessonIndex} surgeExample={surgeExample} finishExample={finishExample}
          onBack={() => chooseLesson(GUIDE_LESSONS[Math.max(0, lessonIndex - 1)].id)}
          onNext={() => lessonIndex < GUIDE_LESSONS.length - 1 ? chooseLesson(GUIDE_LESSONS[lessonIndex + 1].id) : onStartPractice()} />
        <p className="guide-practice-note">Practice starts untimed with hints on and Easy selected. Choose a turn timer before you begin if you want timed Practice.</p>
      </section>
      <section id="guide-panel-rules" role="tabpanel" aria-labelledby="guide-tab-rules" hidden={tab !== "rules"}>
        <RulesReference />
      </section>
    </main>
  );
}

function LessonExperience({ lesson, lessonIndex, surgeExample, finishExample, onBack, onNext }: {
  lesson: GuideLessonId;
  lessonIndex: number;
  surgeExample: SurgeExampleId;
  finishExample: FinishExampleId;
  onBack: () => void;
  onNext: () => void;
}) {
  const scenario = guideScenario(lesson, surgeExample, finishExample);
  const lessonInfo = GUIDE_LESSONS[lessonIndex];
  const defaultAction: Action["type"] = lesson === "finish" && finishExample !== "draw" ? "expand" : lessonInfo.action;
  const [actionType, setActionType] = useState<Action["type"]>(defaultAction);
  const [targets, setTargets] = useState<number[]>([]);
  const [phase, setPhase] = useState<"choose" | "locked" | "revealed">("choose");
  const [result, setResult] = useState<ReturnType<typeof resolveGuideScenario> | null>(null);
  const resolving = useRef(false);
  const available = actionType === "pass" ? [] : legalTargets(scenario.start, "A", actionType)
    .filter((target) => !scenario.allowedTargets || scenario.allowedTargets.includes(target));
  const move: Action | null = actionType === "pass" ? { type: "pass" }
    : targets.length === 0 ? null
      : actionType === "surge" && targets.length === 2 ? { type: "surge", target: targets[0], secondTarget: targets[1] }
        : { type: actionType, target: targets[0] };
  const enoughTargets = !scenario.targetCount || targets.length === scenario.targetCount;
  const canLock = phase === "choose" && Boolean(move) && enoughTargets && validateAction(scenario.start, "A", move!).ok;
  const totals = score(result?.state.board ?? scenario.start.board);
  const howMany = lesson === "surge" ? SURGE_EXAMPLES.findIndex((item) => item.id === surgeExample) + 1 : null;
  const instruction = lesson === "expand" ? "Choose one glowing open space to claim."
    : lesson === "collision" ? "C3 is the only open space. Lock your Expand to reveal what happens."
      : lesson === "ambush" ? "Choose C3 as your prediction. Lock to see whether it hits; retry with another legal target to compare."
        : lesson === "surge" ? surgeExample === "single" ? "Take one space, then lock Surge without choosing a second."
          : surgeExample === "mixed" ? "Take the open A3 and the rival’s D3. Both must be in range before reveal."
            : surgeExample === "collision" ? "Choose A3 and C3. Lock to reveal both moves; one collision can’t stop the other capture."
              : "Take both rival spaces, C3 and D3, with one 3-Energy move."
          : lesson === "override" ? "C3 touches you orthogonally. C2 is diagonal and stays illegal; A3 is empty."
            : finishExample === "standard-win" ? "It’s round 12. Expand an open space to take the lead and win on territory."
              : finishExample === "sudden-lead" ? "The score tied after round 12. Expand to take a lead; sudden death ends immediately."
                : "The score is tied entering round 15. Pass; if no one leads after this extra round, it’s a draw.";
  const title = lesson === "expand" ? "Claim your first space"
    : lesson === "collision" ? "Choose secretly. Reveal together."
      : lesson === "ambush" ? "Predict where they Expand"
        : lesson === "surge" ? `Surge · ${SURGE_EXAMPLES[howMany! - 1].title}`
          : lesson === "override" ? "Steal a neighboring space" : "Finish a match";
  const rivalDescription = result ? moveLabel(result.outcomes.B.action) : phase === "locked" ? "Hidden until reveal" : "Hidden";

  const restart = () => { resolving.current = false; setActionType(defaultAction); setTargets([]); setResult(null); setPhase("choose"); };
  const chooseTarget = (target: number) => {
    if (phase !== "choose") return;
    setTargets((current) => actionType === "surge" ? toggleSurgeTarget(current, target) : [target]);
  };
  const chooseAction = (type: Action["type"]) => {
    if (phase !== "choose") return;
    setActionType(type); setTargets([]);
  };
  const allowedActions: Action["type"][] = lesson === "finish" ? [defaultAction] : [lessonInfo.action];

  return (
    <section className="lesson-card" aria-labelledby="lesson-title">
      <div className="lesson-copy">
        <div className="lesson-progress"><span>Lesson {lessonIndex + 1} of {GUIDE_LESSONS.length}</span><span>{scenario.note}</span></div>
        <progress aria-label="Lesson progress" value={lessonIndex + 1} max={GUIDE_LESSONS.length} />
        <h3 id="lesson-title">{title}</h3>
        <p className="lesson-instruction">{instruction}</p>
        <p className="lesson-hint">{actionType === "pass" ? "Pass needs no target. Lock it, then reveal." : `Select the action, choose ${actionType === "surge" ? "one or two" : "a legal"} target${actionType === "surge" ? "s" : ""}, lock your move, then reveal.`}</p>
        <div className="lesson-controls" role="group" aria-label="Choose an action">
          {allowedActions.map((type) => <button key={type} type="button" className={actionType === type ? "selected" : ""}
            aria-pressed={actionType === type} disabled={phase !== "choose"} onClick={() => chooseAction(type)}>
            <span>{ACTION_LABEL[type]}</span><small>{cost(type) ? `${cost(type)} Energy` : "Free"}</small>
          </button>)}
        </div>
        {lesson === "surge" && <p className="lesson-hint">Each target must be within two grid steps of territory you owned before reveal; the first capture never extends the second’s range. Tap a selected space to remove it; a third choice replaces the second.</p>}
        {lesson === "ambush" && <p className="lesson-hint">Ambush blocks Expand only. It never stops Surge or Override.</p>}
        <div className="lesson-selection"><span>{actionType === "surge" ? `Selected · ${targets.length}/2` : "Your choice"}</span><strong>{move ? moveLabel(move) : `${ACTION_LABEL[actionType]} · choose a glowing space`}</strong></div>
        {phase === "choose" && <button className="primary-cta lesson-lock" disabled={!canLock} onClick={() => setPhase("locked")}>Lock move <span>→</span></button>}
        {phase === "locked" && <div className="lesson-lock-state"><p role="status">Your move is locked. The rival’s move is still hidden.</p><button className="primary-cta lesson-lock" onClick={() => { if (resolving.current) return; resolving.current = true; const resolved = resolveGuideScenario(scenario, move!); setResult(resolved); setPhase("revealed"); }}>Reveal both moves <span>→</span></button></div>}
        {result && <div className="lesson-outcome" role="status" aria-live="polite" aria-atomic="true">
          <strong>{moveLabel(result.outcomes.A.action)} / {rivalDescription}</strong>
          <span>{lesson === "finish" ? result.state.winner
            ? `${result.state.winner === "A" ? "You win" : "Rival wins"} on territory${finishExample === "standard-win" ? " after round 12" : " after taking a sudden-death lead"}.`
            : "Scores stayed tied through all three sudden-death rounds. The match is a draw."
            : summary(result.outcomes.A.action, result)}</span>
          <span>Score · You {result.score.A} — Rival {result.score.B}</span>
          {lesson === "ambush" && result.outcomes.A.reason === "ambush-hit" && <span>Energy · {scenario.start.energy.A} → {result.state.energy.A} / 3</span>}
          {lesson === "finish" && <span>{result.state.endingReason === "standard" ? "The higher territory score after 12 rounds wins." : result.state.endingReason === "sudden-death" ? result.state.winner ? "A lead ends sudden death immediately." : "The score stayed tied for all 3 extra rounds." : "The score remains tied after round 12; sudden death begins."}</span>}
        </div>}
        <div className="lesson-navigation">
          <button className="secondary-cta" disabled={lessonIndex === 0} onClick={onBack}>Back</button>
          <button className="secondary-cta" onClick={restart}>Retry</button>
          <button className="primary-cta" disabled={!result} onClick={onNext}>{lessonIndex === GUIDE_LESSONS.length - 1 ? "Begin Practice" : "Next"}<span>→</span></button>
        </div>
      </div>
      <div className="lesson-board-panel">
        <div className="lesson-board-heading"><span>{scenario.note}</span><span>{phase === "choose" ? "YOUR TURN" : phase === "locked" ? "LOCKED" : "REVEALED"}</span></div>
        <div className="lesson-scores"><span><i className="guide-piece you" aria-hidden="true">●</i>You <strong>{totals.A}</strong></span><span>Territory</span><span><strong>{totals.B}</strong>Rival <i className="guide-piece rival" aria-hidden="true">◆</i></span></div>
        <GameBoard board={result?.state.board ?? scenario.start.board} legal={phase === "choose" ? available : []}
          target={targets[0] ?? null} secondTarget={targets[1] ?? null} disabled={phase !== "choose"}
          label={`Lesson board · you Player A blue, rival Player B coral · ${phase === "revealed" ? "moves revealed" : "legal spaces highlighted"}`} onTarget={chooseTarget} />
        <div className="lesson-board-status"><span>Your Energy</span><strong>{result?.state.energy.A ?? scenario.start.energy.A} / 3</strong><span>Rival move</span><strong>{rivalDescription}</strong></div>
        {lesson === "override" && <p className="lesson-hint">Only C3 glows: it holds rival territory and touches your B3. Diagonal C2 and empty A3 cannot be stolen.</p>}
      </div>
    </section>
  );
}

function RulesReference() {
  const facing = guideScenario("surge", "mixed").start;
  const mixed = resolveGuideScenario(guideScenario("surge", "mixed"), { type: "surge", target: 10, secondTarget: 13 });
  const partialStart = guideScenario("surge", "collision").start;
  const partial = resolveGuideScenario(guideScenario("surge", "collision"), { type: "surge", target: 10, secondTarget: 12 });
  return (
    <article className="rules-reference">
      <header><p className="eyebrow">Read the rules · reference</p><h2>One board. Two hidden moves.</h2><p>Both players choose from the same starting board. The game reveals both moves and scores territory after resolution.</p></header>
      <section className="rules-section"><h3>Goal and board</h3><p>Finish with more spaces than your rival. The blue circle is Player A; the coral diamond is Player B. The guide keeps you as Player A so the pieces stay familiar.</p><p>The 5×5 board starts with four spaces for each player. Open spaces are still neutral and can be claimed.</p></section>
      <section className="rules-section"><h3>Round sequence</h3><ol><li>Choose an action and its target or targets.</li><li>Lock your move. Your rival cannot see it.</li><li>Both moves reveal together, then the board and score update.</li></ol><p>In the real match, every action uses your actual side. Ranked and friend matches keep their timed rounds.</p></section>
      <section className="rules-section"><h3>Actions</h3>
        <div className="rule-action"><h4>Expand · free</h4><p>Claim one open space beside your territory. Ambush can block it if the rival predicts the same target.</p></div>
        <div className="rule-action"><h4>Ambush · free</h4><p>Name one open space beside the rival’s territory. It blocks their Expand only when they choose that exact space. A hit earns 1 Energy, up to 3. A miss does not earn Energy.</p></div>
        <div className="rule-action"><h4>Surge · 3 Energy</h4><p>Claim or steal one or two distinct spaces. Each target must be one or two orthogonal steps from territory you owned before this round resolved. Targets can be open, rival-owned, or one of each. Capturing one does not extend the other’s range.</p></div>
        <div className="rule-action"><h4>Override · 2 Energy</h4><p>Steal one rival-owned space directly above, below, left, or right of your territory. Empty spaces and diagonal rivals are illegal.</p></div>
        <div className="rule-action"><h4>Pass · free</h4><p>Give up your move this round. No space or Energy is needed.</p></div>
      </section>
      <section className="rules-section"><h3>Energy</h3><p>You start with 0 Energy. A successful Ambush adds 1, up to the cap of 3. Surge spends 3 once, whether you choose one space or two. Override spends 2. A collision does not refund Energy.</p></section>
      <section className="rules-section"><h3>Grid distance</h3><p>Count steps up, down, left, and right from space you owned before reveal. Diagonal movement has no shortcut. From B3, C3 is one step away and D3 is two.</p>
        <DistanceDiagram />
      </section>
      <section className="rules-section"><h3>Move conflicts</h3><p>If both players claim the same open space with Expand or Surge, neither captures that space. Other targets in a two-target Surge still resolve. A hit by Ambush blocks only Expand, never Surge or Override. Actions resolve from the same pre-round board.</p>
        <div className="rule-examples"><figure><figcaption>Before · You Surge A3 + D3</figcaption><GameBoard board={facing.board} legal={[]} target={null} disabled label="Surge example before · you Player A at B3, rival Player B at D3" onTarget={() => undefined} /></figure>
          <figure><figcaption>After · open A3 claimed, rival D3 stolen</figcaption><GameBoard board={mixed.state.board} legal={[]} target={null} disabled label="Surge example after · Player A owns A3 and D3" onTarget={() => undefined} /><p>Territory: You {mixed.score.A} — Rival {mixed.score.B}</p></figure>
        </div>
        <div className="rule-examples"><figure><figcaption>Before · You Surge A3 + C3; rival Expands C3</figcaption><GameBoard board={partialStart.board} legal={[]} target={null} disabled label="Partial Surge collision before resolution" onTarget={() => undefined} /></figure>
          <figure><figcaption>After · A3 succeeds; C3 collides</figcaption><GameBoard board={partial.state.board} legal={[]} target={null} disabled label="Partial Surge collision after resolution" onTarget={() => undefined} /><p>You capture one space; C3 stays open.</p></figure>
        </div>
      </section>
      <section className="rules-section"><h3>Match endings</h3><p>After 12 rounds, the higher territory score wins. A tie starts sudden death. A new lead ends the match; if scores stay tied for all 3 sudden-death rounds, the match is a draw.</p>
        <details><summary>Other endings</summary><p>The board can end early when no open spaces or legal Surge or Override captures remain. An abandoned timed match can also end by forfeit. A finished score counts spaces owned by each player.</p></details>
      </section>
    </article>
  );
}

function DistanceDiagram() {
  const steps: Record<number, string> = { 11: "You", 12: "1", 13: "2" };
  return <div className="distance-example"><div className="distance-grid" role="img" aria-label="From your territory at B3, C3 is one step and D3 is two steps away.">
    {Array.from({ length: 25 }, (_, index) => <span key={index} className={index === 11 ? "source" : index === 12 ? "step" : index === 13 ? "target" : ""}>{steps[index] ?? ""}</span>)}
  </div><p>B3 → C3 → D3 is two orthogonal steps. A Surge can reach D3 from B3.</p></div>;
}
