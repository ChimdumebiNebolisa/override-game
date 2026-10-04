import { useEffect, useMemo, useRef, useState } from "react";
import {
  legalActions,
  legalTargets,
  score,
  type Action,
  type ActionOutcome,
  type MatchState,
  type Player,
} from "../shared/rules";
import { api, type LeaderboardEntry, type PublicMatch, type QuickRematchInvitation, type RankedInvitation, type RankedProfile, type RankedQueue, type RankedSettlement, type Room } from "./api";

declare global {
  interface Window {
    google?: { accounts: { id: { initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void; renderButton(element: HTMLElement, options: Record<string, unknown>): void } } };
  }
}

type Screen =
  | "home"
  | "practice"
  | "quick"
  | "game"
  | "room"
  | "ranked"
  | "leaderboard"
  | "profile"
  | "how-to"
  | "quick-rematch";
type Difficulty = "Easy" | "Normal" | "Hard";
type SoloMode = "practice" | "quick";
type PlayMode = SoloMode | "ranked";
const CURRENT_MATCH_KEY = "override:current-match";

function rankedInviteFromPath() {
  const match = window.location.pathname.match(/^\/ranked\/(challenge|rematch)\/([^/]+)$/);
  return match ? { kind: match[1] as "challenge" | "rematch", token: decodeURIComponent(match[2]) } : null;
}

function guestInviteFromPath() {
  const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function quickRematchFromPath() {
  const match = window.location.pathname.match(/^\/quick\/rematch\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

const ACTIONS: ReadonlyArray<{
  type: Action["type"];
  label: string;
  cost: number;
  short: string;
}> = [
  { type: "expand", label: "Expand", cost: 0, short: "Claim an adjacent node" },
  { type: "ambush", label: "Ambush", cost: 0, short: "Predict their Expand" },
  { type: "surge", label: "Surge", cost: 1, short: "Reach up to 2 spaces" },
  { type: "override", label: "Override", cost: 3, short: "Steal an adjacent node" },
  { type: "pass", label: "Pass", cost: 0, short: "Take no action" },
];

const OUTCOME_COPY: Record<ActionOutcome["reason"], string> = {
  claimed: "claimed the node",
  stolen: "took control of the node",
  "ambush-hit": "read the Expand and gained 1 Energy",
  "ambush-missed": "did not catch an Expand",
  collision: "collided; the node stayed neutral",
  intercepted: "was stopped by an Ambush",
  passed: "passed",
  "automatic-pass": "ran out of time and passed",
};

function coordinate(index: number) {
  return `${String.fromCharCode(65 + (index % 5))}${Math.floor(index / 5) + 1}`;
}

function creditExplanation(multiplier: number): string {
  if (multiplier === 0) return "Zero competitive credit for both players: RP, rated matches, placement, W-L-D, and streak stay unchanged.";
  if (multiplier < 1) return `${Math.round(multiplier * 100)}% RP credit. This counts as a rated match; W-L-D and streak stay unchanged.`;
  return "Full competitive credit: RP and eligible match stats update normally; placement advances if still in progress.";
}

const RIVAL_MILESTONES = [850, 950, 1050, 1150, 1250, 1400, 1550, 1750];

function nextRivalText(rating: number): string {
  const next = RIVAL_MILESTONES.find((target) => target > rating);
  return next ? `Next Rival: ${next === 1250 ? "ROOK" : `Rival ${next}`} · ${next - rating} RP away` : "All Rival benchmarks cleared.";
}

function actionText(action: Action) {
  const name = action.type[0].toUpperCase() + action.type.slice(1);
  return action.type === "pass" ? name : `${name} ${coordinate(action.target)}`;
}

function Brand({ onHome }: { onHome: () => void }) {
  return (
    <button className="brand" onClick={onHome} aria-label="OVERRIDE home">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>OVER<span>RIDE</span></span>
    </button>
  );
}

function AppHeader({ navigate }: { navigate: (screen: Screen) => void }) {
  return (
    <header className="site-header">
      <Brand onHome={() => navigate("home")} />
      <nav aria-label="Main navigation">
        <button onClick={() => navigate("how-to")}>How to play</button>
        <button onClick={() => navigate("leaderboard")}>Leaderboard</button>
        <button className="profile-button" onClick={() => navigate("profile")} aria-label="Open profile">
          G
        </button>
      </nav>
    </header>
  );
}

function Home({ navigate }: { navigate: (screen: Screen) => void }) {
  return (
    <main className="home-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span>5×5</span> simultaneous strategy</p>
          <h1>Predict.<br />Counter.<br /><em>Control the grid.</em></h1>
          <p className="hero-intro">
            Choose in secret. Reveal together. Outread your opponent in a complete match that takes about a minute.
          </p>
          <button className="primary-cta" onClick={() => navigate("practice")}>Start with Practice <span>→</span></button>
        </div>
        <DemoBoard />
      </section>

      <section className="mode-grid" aria-labelledby="choose-mode">
        <div className="section-heading">
          <p className="eyebrow">Choose a mode</p>
          <h2 id="choose-mode">Make your move.</h2>
        </div>
        <button className="mode-card practice-card" onClick={() => navigate("practice")}>
          <span className="mode-index">01</span>
          <span className="mode-copy"><strong>Practice</strong><small>Learn with hints and clear outcome explanations.</small></span>
          <span className="mode-arrow">↗</span>
        </button>
        <button className="mode-card quick-card" onClick={() => navigate("quick")}>
          <span className="mode-index">02</span>
          <span className="mode-copy"><strong>Quick Duel</strong><small>Face a bot or invite a friend. No account needed.</small></span>
          <span className="mode-arrow">↗</span>
        </button>
        <button className="mode-card ranked-card" onClick={() => navigate("ranked")}>
          <span className="mode-index">03</span>
          <span className="mode-copy"><strong>Ranked Duel</strong><small>Play human opponents and climb the leaderboard.</small></span>
          <span className="mode-arrow">↗</span>
        </button>
      </section>
    </main>
  );
}

function DemoBoard() {
  const cells = ["A", "A", "n", "n", "n", "A", "A", "n", "x", "n", "n", "n", "x", "n", "n", "n", "x", "n", "B", "B", "n", "n", "n", "B", "B"];
  return (
    <div className="demo-stage" aria-hidden="true">
      <div className="demo-stamp">Round 07 <b>03.2</b></div>
      <div className="demo-board">
        {cells.map((cell, index) => <span key={index} className={`demo-cell ${cell}`}><i /></span>)}
      </div>
      <div className="demo-caption"><span>A · 09</span><b>SIMULTANEOUS REVEAL</b><span>11 · B</span></div>
    </div>
  );
}

function ModeSelect({
  kind,
  onStart,
  navigate,
}: {
  kind: SoloMode;
  onStart: (mode: SoloMode, difficulty: Difficulty, creationKey: string) => Promise<void>;
  navigate: (screen: Screen) => void;
}) {
  const [difficulty, setDifficulty] = useState<Difficulty>("Normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creationRef = useRef<{ difficulty: Difficulty; key: string } | null>(null);
  const launch = async () => {
    setBusy(true);
    setError("");
    if (creationRef.current?.difficulty !== difficulty) creationRef.current = { difficulty, key: crypto.randomUUID() };
    try { await onStart(kind, difficulty, creationRef.current.key); creationRef.current = null; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The match could not start."); }
    finally { setBusy(false); }
  };
  return (
    <main className="panel-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="panel-heading">
        <p className="eyebrow">{kind === "practice" ? "Learn the grid" : "Quick Duel · Bot"}</p>
        <h1>{kind === "practice" ? "Practice" : "Choose your rival."}</h1>
        <p>{kind === "practice" ? "Legal targets and outcome explanations stay on. You can show or hide hints while you play." : "A full unranked match with no coaching and no sign-in."}</p>
      </div>
      <fieldset className="difficulty-picker">
        <legend>Bot difficulty</legend>
        {(["Easy", "Normal", "Hard"] as const).map((item) => (
          <button key={item} className={difficulty === item ? "active" : ""} onClick={() => setDifficulty(item)}>
            <strong>{item}</strong>
            <span>{item === "Easy" ? "Favors safe Expands" : item === "Normal" ? "Balances position and Energy" : "Reads the public board closely"}</span>
          </button>
        ))}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-cta full" disabled={busy} onClick={launch}>{busy ? "Starting match…" : `Play ${difficulty}`} <span>→</span></button>
      {kind === "quick" && (
        <div className="friend-entry">
          <span>or</span>
          <button className="secondary-cta" onClick={() => navigate("room")}>Play a friend</button>
        </div>
      )}
    </main>
  );
}

function Game({ mode, difficulty, initialMatch, onExit, onRestart, onOpenRanked, onOpenLeaderboard, onQuickRematch }: {
  mode: PlayMode;
  difficulty: Difficulty;
  initialMatch: PublicMatch;
  onExit: () => void;
  onRestart: (creationKey: string) => Promise<void>;
  onOpenRanked: () => void;
  onOpenLeaderboard: () => void;
  onQuickRematch: (match: PublicMatch) => void;
}) {
  const [match, setMatch] = useState(initialMatch.state);
  const [actionType, setActionType] = useState<Action["type"]>("expand");
  const [target, setTarget] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(() => Math.max(0, Math.ceil(((initialMatch.deadline ?? initialMatch.serverNow) - initialMatch.serverNow) / 1000)));
  const [locked, setLocked] = useState(initialMatch.locked);
  const [reveal, setReveal] = useState(initialMatch.status === "decision" ? null : initialMatch.lastResult);
  const acknowledgedRoundRef = useRef(initialMatch.status === "decision" ? initialMatch.state.round : initialMatch.state.round - 1);
  const [showFinalResult, setShowFinalResult] = useState(initialMatch.status === "finished");
  const [networkError, setNetworkError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [revision, setRevision] = useState(initialMatch.revision);
  const revisionRef = useRef(initialMatch.revision);
  const [resultType, setResultType] = useState(initialMatch.resultType);
  const [confirmResign, setConfirmResign] = useState(false);
  const [afkWarning, setAfkWarning] = useState(Boolean(initialMatch.afkWarning));
  const [serverStatus, setServerStatus] = useState(initialMatch.status);
  const [showHint, setShowHint] = useState(true);
  const [deadlineAt, setDeadlineAt] = useState(initialMatch.deadline ? Date.now() + (initialMatch.deadline - initialMatch.serverNow) : null);
  const lockingRef = useRef(false);
  const leaveButtonRef = useRef<HTMLButtonElement>(null);
  const roundLabelRef = useRef<HTMLElement>(null);
  const focusRoundAfterReveal = useRef(false);
  useEffect(() => { if (reveal) setConfirmResign(false); }, [reveal]);
  useEffect(() => {
    if (reveal || !focusRoundAfterReveal.current) return;
    focusRoundAfterReveal.current = false;
    const frame = window.requestAnimationFrame(() => roundLabelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [reveal]);
  const me = initialMatch.player;
  const rival: Player = me === "A" ? "B" : "A";
  const totals = score(match.board);
  const legal = actionType === "pass" ? [] : legalTargets(match, me, actionType);
  const selectedAction: Action | null = actionType === "pass"
    ? { type: "pass" }
    : target === null
      ? null
      : { type: actionType, target };

  const commit = async (forcedAction?: Action) => {
    if (lockingRef.current || match.status === "finished") return;
    const playerAction = forcedAction ?? selectedAction;
    if (!playerAction) return;
    lockingRef.current = true;
    setLocked(true);
    setNetworkError("");
    try {
      const response = await api.lockAction(initialMatch.id, playerAction, match.round, revision);
      receiveSnapshot(response.match);
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "The move could not be locked.");
      setLocked(false);
    } finally {
      lockingRef.current = false;
    }
  };

  const receiveSnapshot = (snapshot: PublicMatch) => {
    setMatch(snapshot.state);
    setServerStatus(snapshot.status);
    setReveal(snapshot.status === "finished" || (snapshot.lastResult && snapshot.lastResult.state.round > acknowledgedRoundRef.current)
      ? snapshot.lastResult : null);
    setRevision(snapshot.revision);
    revisionRef.current = snapshot.revision;
    setResultType(snapshot.resultType);
    setLocked(snapshot.locked || snapshot.status !== "decision");
    setAfkWarning(Boolean(snapshot.afkWarning));
    const nextDeadline = snapshot.deadline ? Date.now() + (snapshot.deadline - snapshot.serverNow) : null;
    setDeadlineAt((current) => current !== null && nextDeadline !== null && Math.abs(current - nextDeadline) < 250 ? current : nextDeadline);
    setTimeLeft(Math.max(0, Math.ceil(((snapshot.deadline ?? snapshot.serverNow) - snapshot.serverNow) / 1000)));
  };

  useEffect(() => {
    if (match.status === "finished") return;
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = (await api.getMatch<PublicMatch>(initialMatch.id)).match;
        if (active && snapshot.revision >= revisionRef.current) {
          receiveSnapshot(snapshot);
          setConnectionError("");
        }
      } catch {
        if (active) setConnectionError("Connection lost. Reconnecting…");
      }
    };
    const unsubscribe = initialMatch.roomId
      ? api.subscribe(initialMatch.roomId, () => void refresh())
      : api.subscribeMatch(initialMatch.id, () => void refresh());
    const deadlineDelay = Math.max(0, (deadlineAt ?? Date.now()) - Date.now() + 300);
    const deadlineFetch = window.setTimeout(() => void refresh(), deadlineDelay);
    const fallbackPoll = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearTimeout(deadlineFetch); window.clearInterval(fallbackPoll); unsubscribe(); };
  }, [initialMatch.id, initialMatch.roomId, match.round, match.status, deadlineAt]);

  const receiveTimeout = async () => {
    setLocked(true);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      for (let attempt = 0; attempt < 5; attempt++) {
        const snapshot = (await api.getMatch<PublicMatch>(initialMatch.id)).match;
        if (snapshot.lastResult?.state.round === match.round + 1 || snapshot.status === "finished") {
          receiveSnapshot(snapshot);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "The round result could not be loaded.");
    }
  };

  useEffect(() => {
    if (locked || reveal || match.status === "finished") return;
    const timer = window.setInterval(() => {
      setTimeLeft((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          void receiveTimeout();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [locked, reveal, match]);

  const nextRound = async () => {
    setNetworkError("");
    try {
      let snapshot: PublicMatch | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 350));
        snapshot = (await api.getMatch<PublicMatch>(initialMatch.id)).match;
        if (snapshot.status !== "transition") break;
      }
      if (!snapshot) return;
      acknowledgedRoundRef.current = reveal?.state.round ?? acknowledgedRoundRef.current;
      focusRoundAfterReveal.current = snapshot.status !== "finished";
      receiveSnapshot(snapshot);
      setActionType("expand");
      setTarget(null);
      setTimeLeft(Math.max(0, Math.ceil(((snapshot.deadline ?? snapshot.serverNow) - snapshot.serverNow) / 1000)));
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "The next round could not be loaded.");
    }
  };

  const chooseAction = (type: Action["type"]) => {
    if (locked || reveal) return;
    setActionType(type);
    setTarget(null);
  };

  const hint = useMemo(() => {
    const first = legalActions(match, me).find((action) => action.type !== "pass");
    return first ? `Try ${actionText(first)}. Legal targets are outlined on the grid.` : "No territory move is available. Pass this round.";
  }, [match, me]);

  const finalRoundReveal = match.status === "finished" && reveal &&
    (resultType === "standard" || resultType === "sudden-death" || resultType === "board-exhaustion");
  if (serverStatus === "voided" || (match.status === "finished" && (!finalRoundReveal || showFinalResult))) {
    return <ResultScreen match={match} totals={score(match.board)} player={me} ranked={mode === "ranked"} friend={Boolean(initialMatch.roomId)} matchId={initialMatch.id} resultType={resultType} onRestart={onRestart} onExit={onExit} onOpenRanked={onOpenRanked} onOpenLeaderboard={onOpenLeaderboard} onQuickRematch={onQuickRematch} onSnapshot={receiveSnapshot} />;
  }

  const resign = async () => {
    setNetworkError("");
    try { receiveSnapshot((await api.resignMatch(initialMatch.id)).match); setConfirmResign(false); }
    catch (reason) { setNetworkError(reason instanceof Error ? reason.message : "The match could not be resigned."); }
  };

  const closeResign = () => {
    setConfirmResign(false);
    window.requestAnimationFrame(() => leaveButtonRef.current?.focus());
  };

  const roundLabel = match.phase === "sudden-death"
    ? `Sudden Death ${Math.max(1, match.round - match.config.standardRounds)}`
    : `Round ${match.round} / ${match.config.standardRounds}`;

  return (
    <main className="game-page">
      <header className="match-header">
        <button ref={leaveButtonRef} className="icon-button" onClick={() => setConfirmResign(true)} aria-label="Leave match">×</button>
        <div><span>{mode === "practice" ? "Practice" : mode === "ranked" ? "Ranked Duel" : `Quick Duel · ${initialMatch.roomId ? "Friend" : difficulty}`}</span><strong ref={roundLabelRef} tabIndex={-1}>{roundLabel}</strong></div>
        <div className={`timer ${timeLeft <= 2 ? "urgent" : ""}`} aria-label={`${timeLeft} seconds remaining`}><b>0{timeLeft}</b><span>SEC</span></div>
      </header>

      <section className="score-rail" aria-label="Match score">
        <div className={`player-score you side-${me}`}><span className="owner-symbol">{me === "A" ? "●" : "◆"}</span><p><small>You · {me}</small><strong>{totals[me].toString().padStart(2, "0")}</strong></p></div>
        <div className="round-track"><span style={{ width: `${Math.min(100, ((match.round - 1) / match.config.standardRounds) * 100)}%` }} /></div>
        <div className={`player-score bot side-${rival}`}><p><small>{mode === "ranked" || initialMatch.roomId ? initialMatch.playerNames[rival] : `${difficulty} bot`} · {rival}</small><strong>{totals[rival].toString().padStart(2, "0")}</strong></p><span className="owner-symbol">{rival === "A" ? "●" : "◆"}</span></div>
      </section>

      <div className="game-layout">
        <section className="board-panel" aria-labelledby="board-title">
          <div className="board-label"><span id="board-title">Territory grid</span><span>{locked ? "MOVE LOCKED" : reveal ? "ROUND REVEALED" : "CHOOSE A TARGET"}</span></div>
          <GameBoard board={match.board} legal={legal} target={target} disabled={locked || Boolean(reveal)} onTarget={setTarget} />
          <div className="energy-bar">
            <span>ENERGY</span>
            {[1, 2, 3].map((value) => <i key={value} className={value <= match.energy[me] ? "charged" : ""}>ϟ</i>)}
            <strong>{match.energy[me]} / 3</strong>
          </div>
          {mode === "practice" && <div className="hint-control"><button type="button" onClick={() => setShowHint((value) => !value)} aria-pressed={showHint}>{showHint ? "Hide hints" : "Show hints"}</button></div>}
          {mode === "practice" && showHint && !reveal && <p className="coach-note"><b>Hint</b>{hint}</p>}
        </section>

        <section className="move-panel" aria-labelledby="move-title">
          <div className="move-heading"><div><span>YOUR MOVE</span><h2 id="move-title">Choose an action.</h2></div><small>One move per round</small></div>
          <div className="action-grid">
            {ACTIONS.map((action) => {
              const canAfford = match.energy[me] >= action.cost;
              const hasTargets = action.type === "pass" || legalTargets(match, me, action.type).length > 0;
              return (
                <button
                  key={action.type}
                  className={actionType === action.type ? "selected" : ""}
                  onClick={() => chooseAction(action.type)}
                  disabled={locked || Boolean(reveal) || !canAfford || !hasTargets}
                  aria-pressed={actionType === action.type}
                >
                  <span className={`action-glyph glyph-${action.type}`} aria-hidden="true" />
                  <span><strong>{action.label}</strong><small>{action.short}</small></span>
                  {action.cost > 0 && <b className="cost">{action.cost}ϟ</b>}
                </button>
              );
            })}
          </div>
          <div className="selection-line">
            <span>Selected</span><strong>{selectedAction ? actionText(selectedAction) : `${ACTIONS.find((item) => item.type === actionType)?.label}: choose a node`}</strong>
          </div>
          {networkError && <p className="form-error" role="alert">{networkError}</p>}
          {connectionError && <p className="form-error" role="status">{connectionError}</p>}
          {serverStatus === "grace" && <p className="status-note" role="status">Match paused while a player reconnects. The server will resume or finish it after the grace period.</p>}
          {afkWarning && <p className="afk-warning" role="alert"><b>AFK warning</b> Choose a move this round. A third connected miss ends the match.</p>}
          <button className="lock-button" disabled={!selectedAction || locked || Boolean(reveal)} onClick={() => void commit()}>
            {locked ? "Move locked" : "Lock move"}<span>{locked ? "✓" : "→"}</span>
          </button>
          <p className="privacy-note">{mode === "ranked" || initialMatch.roomId ? "Your opponent cannot see your move or lock timing before reveal." : "The bot chooses from the same public pre-round state and cannot see your pending move."}</p>
        </section>
      </div>

      {reveal && <RevealPanel result={reveal} player={me} finalRound={Boolean(finalRoundReveal)} onContinue={() => finalRoundReveal ? setShowFinalResult(true) : void nextRound()} />}
      {confirmResign && !reveal && <ResignDialog ranked={mode === "ranked"} onCancel={closeResign} onConfirm={() => void resign()} />}
    </main>
  );
}

function GameBoard({ board, legal, target, disabled, onTarget }: {
  board: MatchState["board"];
  legal: number[];
  target: number | null;
  disabled: boolean;
  onTarget: (target: number) => void;
}) {
  return (
    <div className="board-grid" role="group" aria-label="5 by 5 territory grid">
      <span className="axis corner" aria-hidden="true" />
      {["A", "B", "C", "D", "E"].map((label) => <span className="axis" aria-hidden="true" key={label}>{label}</span>)}
      {board.map((cell, index) => {
        const row = Math.floor(index / 5);
        const isLegal = legal.includes(index);
        return (
          <span className="cell-slot" key={index}>
            {index % 5 === 0 && <span className="axis row-axis" aria-hidden="true">{row + 1}</span>}
            <button
              className={`board-cell owner-${cell} ${isLegal ? "legal" : ""} ${target === index ? "targeted" : ""}`}
              onClick={() => isLegal && onTarget(index)}
              disabled={disabled || !isLegal}
              aria-label={`${coordinate(index)}, ${cell === "neutral" ? "neutral" : `owned by player ${cell}`}${isLegal ? ", legal target" : ""}`}
              aria-pressed={target === index}
            >
              {cell === "A" ? <span>●</span> : cell === "B" ? <span>◆</span> : <span className="node-dot" />}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function ResignDialog({ ranked, onCancel, onConfirm }: { ranked: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={dialogRef} className="confirm-bar" aria-labelledby="resign-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <p><strong id="resign-title">Resign match?</strong>{ranked ? " This counts as a loss." : " This ends the duel."}</p>
      <div><button className="secondary-cta" onClick={onCancel}>Keep playing</button><button className="danger-button" onClick={onConfirm}>Resign</button></div>
    </dialog>
  );
}

function RevealPanel({ result, player, finalRound, onContinue }: { result: NonNullable<PublicMatch["lastResult"]>; player: Player; finalRound: boolean; onContinue: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    continueRef.current?.focus();
    return () => dialog?.close();
  }, []);
  const rival: Player = player === "A" ? "B" : "A";
  const rows = ([player, rival] as const).map((side) => ({ side, outcome: result.outcomes[side] }));
  return (
    <dialog ref={dialogRef} className="reveal-scrim" aria-labelledby="reveal-title" onCancel={(event) => event.preventDefault()}>
      <section className="reveal-card">
        <p className="eyebrow">Simultaneous reveal</p>
        <h2 id="reveal-title">Round resolved.</h2>
        <div className="reveal-actions">
          {rows.map(({ side, outcome }) => (
            <div key={side} className={side === player ? "you" : "bot"}>
              <span>{side === player ? "YOU" : "RIVAL"}</span>
              <strong>{actionText(outcome.action)}</strong>
              <p>{OUTCOME_COPY[outcome.reason]}.</p>
            </div>
          ))}
        </div>
        <div className="reveal-score"><span>{result.score[player]}</span><small>territory</small><span>{result.score[rival]}</span></div>
        <button ref={continueRef} className="primary-cta full" onClick={onContinue}>{finalRound ? "See result" : "Next round"} <span>→</span></button>
      </section>
    </dialog>
  );
}

function ResultScreen({ match, totals, player, ranked, friend, matchId, resultType, onRestart, onExit, onOpenRanked, onOpenLeaderboard, onQuickRematch, onSnapshot }: {
  match: MatchState;
  totals: Readonly<Record<Player, number>>;
  player: Player;
  ranked: boolean;
  friend: boolean;
  matchId: string;
  resultType: string | null;
  onRestart: (creationKey: string) => Promise<void>;
  onExit: () => void;
  onOpenRanked: () => void;
  onOpenLeaderboard: () => void;
  onQuickRematch: (match: PublicMatch) => void;
  onSnapshot: (match: PublicMatch) => void;
}) {
  const rival: Player = player === "A" ? "B" : "A";
  const title = resultType === "server-error" ? "Match voided" : resultType === "no-contest" ? "No contest" : match.winner === player ? "Victory" : match.winner === rival ? "Defeat" : "Draw";
  const [settlement, setSettlement] = useState<RankedSettlement | null>(null);
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [invitation, setInvitation] = useState<RankedInvitation | null>(null);
  const [requested, setRequested] = useState(false);
  const [quickInvitation, setQuickInvitation] = useState<QuickRematchInvitation | null>(null);
  const [quickRequested, setQuickRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const restartKey = useRef<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mine = settlement?.[player === "A" ? "playerA" : "playerB"] ?? null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!ranked || resultType === "server-error") return;
    let active = true;
    const load = async () => {
      try {
        const settled = await api.getRankedSettlement(matchId);
        if (!settled.settlement) {
          const latest = (await api.getMatch<PublicMatch>(matchId)).match;
          if (active) {
            setError("");
            if (latest.status === "voided") onSnapshot(latest);
          }
          return;
        }
        const [currentProfile, rematch, queue] = await Promise.all([
          api.getProfile(), api.getRankedRematch(matchId), api.getRankedQueue(),
        ]);
        if (!active) return;
        setError("");
        setSettlement(settled.settlement);
        setProfile(currentProfile.profile);
        setInvitation(rematch.invitation);
        setRequested(rematch.requestedByYou);
        if (queue.queue?.matchId && queue.queue.matchId !== matchId &&
            (queue.queue.state === "readying" || queue.queue.state === "active")) onOpenRanked();
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Ranked result details could not be loaded.");
      }
    };
    void load();
    const poll = window.setInterval(() => void load(), 1_000);
    return () => { active = false; window.clearInterval(poll); };
  }, [ranked, matchId, resultType]);

  useEffect(() => {
    if (!friend || ranked) return;
    let active = true;
    const load = async () => {
      try {
        const response = await api.getQuickRematch(matchId);
        if (!active) return;
        setQuickInvitation(response.invitation);
        setQuickRequested(response.requestedByYou);
        if (response.match) onQuickRematch(response.match);
      } catch { /* The result remains usable if no rematch is pending. */ }
    };
    void load();
    const poll = window.setInterval(() => void load(), 1_000);
    return () => { active = false; window.clearInterval(poll); };
  }, [friend, ranked, matchId]);

  const requestRematch = async () => {
    setBusy(true); setError("");
    try { setInvitation((await api.requestRankedRematch(matchId)).invitation); setRequested(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The rematch could not be requested."); }
    finally { setBusy(false); }
  };
  const acceptRematch = async () => {
    if (!invitation) return;
    setBusy(true); setError("");
    try { await api.acceptRankedInvite("rematch", invitation.token); onOpenRanked(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The rematch could not be accepted."); }
    finally { setBusy(false); }
  };
  const requestQuickRematch = async () => {
    setBusy(true); setError("");
    try { setQuickInvitation((await api.requestQuickRematch(matchId)).invitation); setQuickRequested(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The rematch could not be requested."); }
    finally { setBusy(false); }
  };
  const acceptQuickRematch = async () => {
    if (!quickInvitation) return;
    setBusy(true); setError("");
    try { onQuickRematch((await api.acceptQuickRematch(matchId, quickInvitation.token)).match); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The rematch could not be accepted."); }
    finally { setBusy(false); }
  };

  const restart = async () => {
    setBusy(true); setError("");
    restartKey.current ??= crypto.randomUUID();
    try { await onRestart(restartKey.current); restartKey.current = null; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The rematch could not start."); }
    finally { setBusy(false); }
  };

  return (
    <main className="result-page">
      <p className="eyebrow">{ranked ? "Ranked Duel" : "Unranked match"} · Complete</p>
      <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
      <div className="result-score"><span>{totals[player]}</span><i>—</i><span>{totals[rival]}</span></div>
      <p>{resultType === "server-error" ? "Match voided due to a connection or server error. No rating was changed." :
        resultType === "no-contest" ? "Neither player receives competitive credit for this match." :
        resultType === "resignation" ? "The match ended by resignation." :
          resultType === "forfeit" ? "The match ended by forfeit." :
            match.endingReason === "board-exhaustion" ? "No legal territory-changing moves remained." : "Final territory after the last round."}</p>
      {ranked && mine && <section className="settlement-card">
        <div><span>RP change</span><strong className={mine.delta >= 0 ? "positive" : "negative"}>{mine.delta >= 0 ? "+" : ""}{mine.delta}</strong></div>
        <div><span>Rating</span><strong>{mine.profile.rating} → {mine.updatedProfile.rating}</strong></div>
        <div><span>Credit</span><strong>{Math.round(settlement!.multiplier * 100)}%</strong></div>
        <div><span>Tier</span><strong>{profile?.tier ?? "Updating"}</strong></div>
        <div><span>{(profile?.placementProgress ?? mine.updatedProfile.placementProgress) < 5 ? "Placement" : "Global rank"}</span><strong>{(profile?.placementProgress ?? mine.updatedProfile.placementProgress) < 5 ? `${profile?.placementProgress ?? mine.updatedProfile.placementProgress}/5` : profile?.rank ? `#${profile.rank}` : "Updating"}</strong></div>
      </section>}
      {ranked && mine && <><p className="status-note">{creditExplanation(settlement!.multiplier)}</p><p className="next-rival">{nextRivalText(profile?.rating ?? mine.updatedProfile.rating)}</p></>}
      {ranked && !settlement && resultType !== "server-error" && <p className="status-note" role="status">Rating update pending. This result will refresh automatically.</p>}
      {ranked && invitation && !requested && <div className="rematch-offer"><p><strong>Rematch requested.</strong> Sides will swap and credit is recalculated before ready.</p><button className="primary-cta" disabled={busy} onClick={acceptRematch}>Accept rematch <span>→</span></button></div>}
      {ranked && requested && <div className="rematch-offer"><p><strong>Rematch sent.</strong> Waiting for your opponent.</p>{invitation && <button className="secondary-cta" onClick={() => navigator.clipboard.writeText(invitation.inviteUrl)}>Copy invite link</button>}</div>}
      {friend && quickInvitation && !quickRequested && <div className="rematch-offer"><p><strong>Rematch requested.</strong> Accept to play again with sides swapped.</p><button className="primary-cta" disabled={busy} onClick={acceptQuickRematch}>Accept rematch <span>→</span></button></div>}
      {friend && quickRequested && <div className="rematch-offer"><p><strong>Rematch sent.</strong> Waiting for your friend.</p></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="result-actions">
        {ranked ? resultType !== "server-error" && settlement && !invitation && <button className="primary-cta" disabled={busy} onClick={requestRematch}>Request rematch <span>↻</span></button> : friend ? resultType !== "server-error" && !quickInvitation && <button className="primary-cta" disabled={busy} onClick={requestQuickRematch}>Request rematch <span>↻</span></button> : <button className="primary-cta" disabled={busy} onClick={restart}>Rematch <span>↻</span></button>}
        {ranked && (settlement || resultType === "server-error") && <button className="secondary-cta" onClick={onOpenRanked}>New opponent</button>}
        {ranked && <button className="secondary-cta" onClick={onOpenLeaderboard}>Leaderboard</button>}
        <button className="secondary-cta" onClick={onExit}>Home</button>
      </div>
      {!ranked && <small>Practice and Quick Duel results do not affect Ranked statistics.</small>}
    </main>
  );
}

function RoomScreen({ navigate, onMatch, inviteToken, initialRoom }: { navigate: (screen: Screen) => void; onMatch: (match: PublicMatch) => void; inviteToken?: string | null; initialRoom?: Room | null }) {
  const [tab, setTab] = useState<"create" | "join">(inviteToken ? "join" : "create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<Room | null>(initialRoom ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const creationRef = useRef<{ name: string; key: string } | null>(null);

  useEffect(() => {
    if (!room) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.getRoom(room.id);
        if (!active) return;
        setRoom(response.room);
        setError("");
        if (response.match) onMatch(response.match as PublicMatch);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "The room could not be refreshed.");
      }
    };
    void refresh();
    const poll = window.setInterval(() => void refresh(), 750);
    const unsubscribe = api.subscribe(room.id, () => void refresh());
    return () => { active = false; window.clearInterval(poll); unsubscribe(); };
  }, [room?.id]);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const roomName = name.trim();
      if (tab === "create" && creationRef.current?.name !== roomName) creationRef.current = { name: roomName, key: crypto.randomUUID() };
      const response = tab === "create"
        ? await api.createRoom(roomName, creationRef.current!.key)
        : inviteToken
          ? await api.joinInvite(inviteToken, roomName)
          : await api.joinRoom(code.trim().toUpperCase(), roomName);
      if (tab === "create") creationRef.current = null;
      if (inviteToken) window.history.replaceState(null, "", "/");
      setRoom(response.room);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The room could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="panel-page room-page">
      <button className="back-link" onClick={() => navigate(inviteToken ? "home" : "quick")}>← {inviteToken ? "Home" : "Quick Duel"}</button>
      <div className="panel-heading"><p className="eyebrow">Quick Duel · Friend</p><h1>{room?.status === "expired" ? "Room expired." : room ? "Room open." : inviteToken ? "You’re invited." : "Meet on the grid."}</h1><p>{room?.status === "expired" ? "This invite is no longer active." : room ? "Share the code or link. Your friend can join without an account." : inviteToken ? "Enter a display name to join this private duel. No account needed." : "Create a private room or enter a code from a friend."}</p></div>
      {room?.status === "expired" ? (
        <section className="room-ticket"><button className="primary-cta full" onClick={() => { if (inviteToken) navigate("quick"); else { setRoom(null); setError(""); setTab("create"); } }}>{inviteToken ? "Choose another duel" : "Create new room"} <span>→</span></button></section>
      ) : room ? (
        <section className="room-ticket">
          <span>ROOM CODE</span><strong>{room.code}</strong>
          <button className="secondary-cta" onClick={() => navigator.clipboard.writeText(room.inviteUrl)}>Copy invite link</button>
          {room.status === "open" && <button className="room-close" onClick={() => void api.closeRoom(room.id).then(() => setRoom(null)).catch((reason) => setError(reason instanceof Error ? reason.message : "The room could not be closed."))}>Close room</button>}
          <div className="seat-list"><p><i className="online" />{room.hostDisplayName}<small>Host</small></p><p><i />{room.guestDisplayName ?? "Waiting for friend…"}<small>{room.guestDisplayName ? "Joined" : "Open seat"}</small></p></div>
        </section>
      ) : (
        <section className="room-form">
          {!inviteToken && <div className="segmented"><button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>Create room</button><button className={tab === "join" ? "active" : ""} onClick={() => setTab("join")}>Join room</button></div>}
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" maxLength={24} /></label>
          {tab === "join" && !inviteToken && <label>Room code<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="e.g. K7MX9Q" maxLength={12} /></label>}
          <button className="primary-cta full" disabled={!name.trim() || (tab === "join" && !inviteToken && !code.trim()) || busy} onClick={submit}>{busy ? "Connecting…" : tab === "create" ? "Create room" : "Join room"}<span>→</span></button>
        </section>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </main>
  );
}

function QuickRematchLanding({ token, navigate, onMatch }: { token: string; navigate: (screen: Screen) => void; onMatch: (match: PublicMatch) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = async () => {
    setBusy(true); setError("");
    try {
      const response = await api.acceptQuickRematchInvite(token);
      window.history.replaceState(null, "", "/");
      onMatch(response.match);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This rematch invitation could not be accepted.");
    } finally { setBusy(false); }
  };
  return <main className="panel-page room-page">
    <button className="back-link" onClick={() => navigate("home")}>← Home</button>
    <div className="panel-heading"><p className="eyebrow">Quick Duel · Rematch</p><h1>Play it back.</h1><p>Your friend requested another duel. Starting sides swap for the rematch.</p></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-cta full" disabled={busy} onClick={accept}>{busy ? "Opening rematch…" : "Accept rematch"}<span>→</span></button>
  </main>;
}

function RankedScreen({ navigate, onMatch, inviteIntent }: { navigate: (screen: Screen) => void; onMatch: (match: PublicMatch) => void; inviteIntent: { kind: "challenge" | "rematch"; token: string } | null }) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [queue, setQueue] = useState<RankedQueue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const googleButton = useRef<HTMLDivElement>(null);
  const acceptingInvite = useRef(false);

  const openActiveMatch = async (next: RankedQueue | null) => {
    if (next?.state === "active" && next.matchId) {
      onMatch((await api.getMatch<PublicMatch>(next.matchId)).match);
    }
  };

  const refreshQueue = async () => {
    const response = await api.getRankedQueue();
    if (!response.queue && queue?.state === "readying" && queue.matchId) {
      const snapshot = (await api.getMatch<PublicMatch>(queue.matchId)).match;
      if (snapshot.state && snapshot.player) {
        onMatch(snapshot);
        return;
      }
    }
    if (!response.queue && queue?.state === "readying") setInviteUrl("");
    setQueue((current) => !response.queue && (current?.state === "searching" || current?.state === "readying")
      ? { state: current.state === "searching" ? "timed-out" : "ready-expired", matchId: null, competitiveMultiplier: null, readyDeadline: null }
      : response.queue);
    await openActiveMatch(response.queue);
  };

  useEffect(() => {
    let active = true;
    Promise.all([api.getSession(), api.getConfig()]).then(([session, config]) => {
      if (!active) return;
      setSignedIn(session.signedIn);
      setProfile(session.profile);
      setClientId(config.googleClientId);
      if (session.signedIn && session.profile?.handle) {
        if (!inviteIntent) void api.getCurrentRankedChallenge()
          .then(({ invitation }) => active && setInviteUrl(invitation?.inviteUrl ?? ""))
          .catch(() => undefined);
        void refreshQueue();
      }
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Ranked could not be loaded."));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if ((!queue && !inviteUrl) || queue?.state === "active" || queue?.state === "timed-out" || queue?.state === "ready-expired") return;
    const timer = window.setInterval(() => void refreshQueue().catch(() => undefined), 900);
    return () => window.clearInterval(timer);
  }, [queue?.state, queue?.matchId, inviteUrl]);

  useEffect(() => {
    if (signedIn || !clientId || !googleButton.current) return;
    const render = () => {
      if (!window.google || !googleButton.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          setBusy(true);
          void api.trackEvent("ranked_auth_started", "ranked").catch(() => undefined);
          api.googleSignIn(credential).then((response) => {
            setSignedIn(true);
            setProfile(response.profile);
            setError("");
          }).catch((reason) => setError(reason instanceof Error ? reason.message : "Google sign-in failed."))
            .finally(() => setBusy(false));
        },
      });
      googleButton.current.replaceChildren();
      window.google.accounts.id.renderButton(googleButton.current, { theme: "outline", size: "large", width: 320 });
    };
    if (window.google) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = render;
    script.onerror = () => setError("Google sign-in could not load. Check your connection and reload the page.");
    document.head.appendChild(script);
    return () => script.remove();
  }, [clientId, signedIn]);

  useEffect(() => {
    if (!profile?.handle || !inviteIntent || acceptingInvite.current || queue) return;
    acceptingInvite.current = true;
    setBusy(true);
    api.acceptRankedInvite(inviteIntent.kind, inviteIntent.token).then(({ shell }) => {
      setQueue({ state: "readying", matchId: shell.matchId, competitiveMultiplier: shell.competitiveMultiplier, readyDeadline: shell.readyDeadline });
      setError("");
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "This Ranked invitation could not be opened.");
      acceptingInvite.current = false;
    }).finally(() => setBusy(false));
  }, [profile?.handle, inviteIntent?.kind, inviteIntent?.token, queue]);

  const claim = async () => {
    setBusy(true); setError("");
    try { setProfile((await api.claimHandle(handle.trim())).profile); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That handle could not be claimed."); }
    finally { setBusy(false); }
  };
  const findOpponent = async () => {
    setBusy(true); setError("");
    try { const next = (await api.enterRankedQueue()).queue; setQueue(next); await openActiveMatch(next); void api.trackEvent("opponent_selected", "ranked-queue").catch(() => undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Matchmaking could not start."); }
    finally { setBusy(false); }
  };
  const ready = async () => {
    if (!queue?.matchId) return;
    setBusy(true); setError("");
    try { const next = (await api.readyRankedMatch(queue.matchId)).queue; setQueue(next); await openActiveMatch(next); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Ready status could not be saved."); }
    finally { setBusy(false); }
  };
  const challenge = async () => {
    setBusy(true); setError("");
    try { setInviteUrl((await api.createRankedChallenge()).invitation.inviteUrl); void api.trackEvent("opponent_selected", "ranked-friend").catch(() => undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The challenge could not be created."); }
    finally { setBusy(false); }
  };

  return (
    <main className="panel-page ranked-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="ranked-badge">R</div>
      <div className="panel-heading"><p className="eyebrow">Human opponents · Rated</p><h1>Ranked Duel</h1><p>Sign in with Google to enter matchmaking, complete five placement matches, and earn an official human leaderboard rank.</p></div>
      {!signedIn && clientId && <div className="google-slot" ref={googleButton} aria-label="Sign in with Google" />}
      {!signedIn && !clientId && <button className="google-button" disabled><span>G</span> Google sign-in is not configured</button>}
      {signedIn && !profile?.handle && <section className="room-form ranked-setup"><label>Choose a public handle<input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="3–16 letters, numbers, or _" maxLength={16} /></label><button className="primary-cta full" disabled={busy || !/^[A-Za-z0-9_]{3,16}$/.test(handle)} onClick={claim}>Claim handle <span>→</span></button></section>}
      {profile?.handle && !queue && !inviteIntent && <section className="ranked-console"><p>Signed in as <strong>{profile.handle}</strong></p><button className="primary-cta full" disabled={busy} onClick={findOpponent}>Find opponent <span>→</span></button><button className="secondary-cta full challenge-button" disabled={busy} onClick={challenge}>Challenge friend</button>{inviteUrl && <div className="invite-output"><span>Waiting for friend to accept</span><button onClick={() => navigator.clipboard.writeText(inviteUrl)}>Copy invite link</button></div>}</section>}
      {profile?.handle && inviteIntent && !queue && <section className="ranked-console"><div className="queue-pulse" /><strong>Opening {inviteIntent.kind}…</strong><p>Your destination was preserved through sign-in.</p></section>}
      {queue?.state === "searching" && <section className="ranked-console"><div className="queue-pulse" /><strong>Finding an opponent…</strong><p>Search expands over 15 seconds.</p><button className="secondary-cta full" onClick={() => void api.leaveRankedQueue().then(() => setQueue(null))}>Cancel</button></section>}
      {queue?.state === "timed-out" && <section className="ranked-console"><strong>No opponent found this time.</strong><p>Search timed out after 15 seconds.</p><button className="primary-cta full" disabled={busy} onClick={findOpponent}>Try again <span>→</span></button></section>}
      {queue?.state === "ready-expired" && <section className="ranked-console"><strong>Ready window expired.</strong><p>Both players need to confirm within 15 seconds. This match did not affect ratings.</p><button className="secondary-cta full" onClick={() => setQueue(null)}>Return to Ranked</button></section>}
      {queue?.state === "readying" && <section className="ranked-console"><p className="eyebrow">Opponent found</p><strong>{queue.competitiveMultiplier === 1 ? "Full competitive credit" : `${Math.round((queue.competitiveMultiplier ?? 0) * 100)}% RP credit`}</strong><p>{creditExplanation(queue.competitiveMultiplier ?? 0)}</p><p>Opponent identity appears after both players commit.</p><button className="primary-cta full" disabled={busy} onClick={ready}>Ready <span>→</span></button></section>}
      {queue?.state === "cooldown" && <section className="ranked-console"><strong>Ranked cooldown</strong><p>Matchmaking is temporarily unavailable after repeated disconnect incidents.</p></section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ranked-facts"><p><strong>1000</strong><span>Starting RP</span></p><p><strong>5</strong><span>Placements</span></p><p><strong>Human</strong><span>Opponents only</span></p></div>
      {!profile?.handle && <p className="status-note">Your Google email is never shown as your public game identity.</p>}
    </main>
  );
}

function InfoScreen({ screen, navigate }: { screen: "leaderboard" | "profile" | "how-to"; navigate: (screen: Screen) => void }) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [newHandle, setNewHandle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [around, setAround] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (screen === "profile") api.getProfile().then((response) => setProfile(response.profile)).catch(() => setProfile(null));
    if (screen === "leaderboard") api.getLeaderboard().then((response) => { setLeaders(response.top); setAround(response.around); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Leaderboard unavailable."));
  }, [screen]);
  const rename = async () => {
    setRenaming(true); setError("");
    try { setProfile((await api.renameHandle(newHandle.trim())).profile); setNewHandle(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The handle could not be changed."); }
    finally { setRenaming(false); }
  };
  if (screen === "how-to") return <HowTo navigate={navigate} />;
  return (
    <main className="panel-page info-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="panel-heading">
        <p className="eyebrow">{screen === "profile" ? "Player profile" : "Human Ranked"}</p>
        <h1>{screen === "profile" ? profile?.handle ?? "Playing as guest." : "Leaderboard"}</h1>
        <p>{screen === "profile" ? profile ? `${profile.tier ?? "Placement"} · ${profile.rating ?? 1000} RP` : "Practice and Quick Duel work without an account." : "Official ranks include eligible human Ranked players only."}</p>
      </div>
      {screen === "profile" && profile && <div className="profile-stats"><p><strong>{profile.rating ?? 1000}</strong><span>RP</span></p><p><strong>{profile.peakRating ?? profile.rating ?? 1000}</strong><span>Peak RP</span></p><p><strong>{profile.placementProgress ?? 0}/5</strong><span>Placement</span></p><p><strong>{profile.rank ? `#${profile.rank}` : "Unplaced"}</strong><span>Global rank</span></p><p><strong>{profile.ratedMatchCount ?? 0}</strong><span>Rated matches</span></p><p><strong>{profile.wins ?? 0}-{profile.losses ?? 0}-{profile.draws ?? 0}</strong><span>W-L-D</span></p><p><strong>{profile.streak ?? 0}</strong><span>Win streak</span></p></div>}
      {screen === "profile" && profile?.handle && <section className="room-form ranked-setup"><label>Change public handle<input value={newHandle} onChange={(event) => setNewHandle(event.target.value)} placeholder="3–16 letters, numbers, or _" maxLength={16} /></label><p className="status-note">After your first rename, you can change your handle once every 30 days.</p><button className="secondary-cta full" disabled={renaming || !/^[A-Za-z0-9_]{3,16}$/.test(newHandle.trim()) || newHandle.trim() === profile.handle} onClick={rename}>{renaming ? "Changing handle…" : "Change handle"}</button></section>}
      {screen === "leaderboard" && leaders.length > 0 && <ol className="leaderboard-list">{leaders.map((entry) => <li key={entry.handle}><b>#{entry.rank}</b><strong>{entry.handle}</strong><span>{entry.tier}</span><em>{entry.rating} RP</em></li>)}</ol>}
      {screen === "leaderboard" && around.length > 0 && <section aria-labelledby="around-title"><h2 id="around-title">Around you</h2><ol className="leaderboard-list">{around.map((entry) => <li key={entry.handle}><b>#{entry.rank}</b><strong>{entry.handle}</strong><span>{entry.tier}</span><em>{entry.rating} RP</em></li>)}</ol></section>}
      {((screen === "profile" && !profile) || (screen === "leaderboard" && leaders.length === 0)) && <div className="empty-state"><span aria-hidden="true">{screen === "profile" ? "G" : "#"}</span><strong>{screen === "profile" ? "No persistent profile yet" : "No placed players yet"}</strong><p>{screen === "profile" ? "Guest games do not carry into Ranked statistics." : "Bots and benchmark Rivals never appear in the human rankings."}</p></div>}
      <RivalsPanel rating={profile?.rating ?? 1000} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="secondary-cta full" onClick={() => navigate(screen === "profile" ? "quick" : "ranked")}>{screen === "profile" ? "Play Quick Duel" : "View Ranked"}</button>
    </main>
  );
}

function RivalsPanel({ rating }: { rating: number }) {
  const next = RIVAL_MILESTONES.find((target) => target > rating);
  return (
    <section className="rivals-panel" aria-labelledby="rivals-title">
      <div><p className="eyebrow">System benchmarks</p><h2 id="rivals-title">Rivals to beat</h2><small>Rivals are milestones created by OVERRIDE. They are not human accounts and never affect Global Rank.</small></div>
      <div className="rival-track">{RIVAL_MILESTONES.map((target) => <span key={target} className={target <= rating ? "cleared" : target === next ? "next" : ""}><b>{target === 1250 ? "ROOK" : "RIVAL"}</b><small>{target} RP</small></span>)}</div>
      <p className="next-rival">{nextRivalText(rating)}</p>
    </section>
  );
}

function HowTo({ navigate }: { navigate: (screen: Screen) => void }) {
  const steps = [
    ["Own the grid", "Finish with more nodes than your opponent."],
    ["Move in secret", "Both players choose from the same pre-round board, then reveal together."],
    ["Build Energy", "A correct Ambush earns 1 Energy. Spend 1 on Surge or 3 on Override."],
  ];
  return (
    <main className="panel-page how-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="panel-heading"><p className="eyebrow">How to play</p><h1>Read the board.<br />Then read your rival.</h1></div>
      <ol className="how-steps">{steps.map(([title, copy], index) => <li key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{copy}</p></div></li>)}</ol>
      <div className="action-rules">{ACTIONS.map((action) => <p key={action.type}><strong>{action.label}{action.cost ? ` · ${action.cost} Energy` : ""}</strong><span>{action.type === "ambush" ? "Blocks Expand only when you predict its exact target." : action.short + "."}</span></p>)}</div>
      <button className="primary-cta full" onClick={() => navigate("practice")}>Try Practice <span>→</span></button>
    </main>
  );
}

export function App() {
  const inviteIntent = rankedInviteFromPath();
  const guestInvite = guestInviteFromPath();
  const quickRematchToken = quickRematchFromPath();
  const [screen, setScreen] = useState<Screen>(() => inviteIntent ? "ranked" : guestInvite ? "room" : quickRematchToken ? "quick-rematch" : "home");
  const [gameKey, setGameKey] = useState(0);
  const [solo, setSolo] = useState<{ mode: PlayMode; difficulty: Difficulty }>({ mode: "practice", difficulty: "Normal" });
  const [botMatch, setBotMatch] = useState<PublicMatch | null>(null);
  const [resumedRoom, setResumedRoom] = useState<Room | null>(null);

  useEffect(() => {
    if (screen === "game" && botMatch) window.sessionStorage.setItem(CURRENT_MATCH_KEY, botMatch.id);
  }, [screen, botMatch]);

  useEffect(() => {
    if (inviteIntent || guestInvite || quickRematchToken) return;
    let active = true;
    const restore = async () => {
      try {
        const { match, room, rankedQueue, rankedChallenge } = await api.getResume();
        if (!active) return;
        let previous: PublicMatch | null = null;
        const previousId = window.sessionStorage.getItem(CURRENT_MATCH_KEY);
        if (!match && previousId) {
          try {
            const response = await api.getMatch<PublicMatch>(previousId);
            previous = response.match.status === "finished" || response.match.status === "voided" ? response.match : null;
          } catch {
            window.sessionStorage.removeItem(CURRENT_MATCH_KEY);
          }
        }
        if (!active) return;
        const resumedMatch = match ?? previous;
        if (resumedMatch) {
          const difficulty = resumedMatch.botDifficulty
            ? `${resumedMatch.botDifficulty[0].toUpperCase()}${resumedMatch.botDifficulty.slice(1)}` as Difficulty
            : "Normal";
          setSolo({ mode: resumedMatch.mode, difficulty });
          setBotMatch(resumedMatch);
          setScreen((current) => current === "home" ? "game" : current);
        } else if (room) {
          setResumedRoom(room);
          setScreen((current) => current === "home" ? "room" : current);
        } else if (rankedQueue || rankedChallenge) {
          setScreen((current) => current === "home" ? "ranked" : current);
        } else {
          void api.trackEvent("homepage_opened").catch(() => undefined);
        }
      } catch { /* The home screen remains available while reconnecting. */ }
    };
    void restore();
    return () => { active = false; };
  }, []);

  const navigate = (next: Screen) => {
    if (next !== "game") window.sessionStorage.removeItem(CURRENT_MATCH_KEY);
    if ((inviteIntent && next !== "ranked") || (guestInvite && next !== "room") || (quickRematchToken && next !== "quick-rematch")) window.history.replaceState(null, "", "/");
    if (next !== "room") setResumedRoom(null);
    if (next === "home") void api.trackEvent("homepage_opened").catch(() => undefined);
    if (next === "practice" || next === "quick" || next === "ranked") void api.trackEvent("mode_selected", next).catch(() => undefined);
    if (next === "room") void api.trackEvent("opponent_selected", "quick-human").catch(() => undefined);
    setScreen(next);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const start = async (mode: SoloMode, difficulty: Difficulty, creationKey: string, parentMatchId?: string) => {
    if (!parentMatchId) void api.trackEvent("opponent_selected", `${mode}-bot`).catch(() => undefined);
    const response = await api.createBotMatch(mode, difficulty.toLowerCase() as Lowercase<Difficulty>, creationKey, parentMatchId);
    setSolo({ mode, difficulty });
    setBotMatch(response.match);
    setGameKey((value) => value + 1);
    navigate("game");
  };

  return (
    <div className="app-shell">
      {screen !== "game" && <AppHeader navigate={navigate} />}
      {screen === "home" && <Home navigate={navigate} />}
      {screen === "practice" && <ModeSelect kind="practice" onStart={start} navigate={navigate} />}
      {screen === "quick" && <ModeSelect kind="quick" onStart={start} navigate={navigate} />}
      {screen === "game" && botMatch && <Game key={gameKey} {...solo} initialMatch={botMatch} onExit={() => navigate("home")} onOpenRanked={() => navigate("ranked")} onOpenLeaderboard={() => navigate("leaderboard")} onQuickRematch={(match) => { setBotMatch(match); setGameKey((value) => value + 1); }} onRestart={async (key) => { if (solo.mode === "ranked") navigate("ranked"); else if (botMatch.roomId) navigate("room"); else await start(solo.mode, solo.difficulty, key, botMatch.status === "voided" ? undefined : botMatch.id); }} />}
      {screen === "room" && <RoomScreen inviteToken={guestInvite} initialRoom={resumedRoom} navigate={navigate} onMatch={(match) => { window.history.replaceState(null, "", "/"); setSolo({ mode: "quick", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {screen === "quick-rematch" && quickRematchToken && <QuickRematchLanding token={quickRematchToken} navigate={navigate} onMatch={(match) => { setSolo({ mode: "quick", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {screen === "ranked" && <RankedScreen inviteIntent={inviteIntent} navigate={navigate} onMatch={(match) => { window.history.replaceState(null, "", "/"); setSolo({ mode: "ranked", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {(screen === "leaderboard" || screen === "profile" || screen === "how-to") && <InfoScreen screen={screen} navigate={navigate} />}
    </div>
  );
}
