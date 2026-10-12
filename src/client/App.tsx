import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HeroDemo } from "./HeroDemo";
import { GameBoard } from "./GameBoard";
import { HowTo } from "./HowTo";
import { acknowledgeLearning, beginLearning, loadLearning, observeLearning, readFlag, resolvedRound, saveLearning, WELCOME_KEY, writeFlag, type LearningRun } from "./learning";
import { toggleSurgeTarget } from "./move-selection";
import {
  legalActions,
  actionTargets,
  legalTargets,
  score,
  type Action,
  type ActionOutcome,
  type MatchState,
  type Player,
} from "../shared/rules";
import { PLACEMENT_MATCHES } from "../shared/rating";
import { api, RequestError, snapshotIsCurrent, type LeaderboardEntry, type PublicMatch, type QuickRematchInvitation, type RankedInvitation, type RankedProfile, type RankedQueue, type RankedSettlement, type Room } from "./api";
import {
  beginGoogleFirebaseSignIn,
  clearGoogleAuthReturnFromLocation,
  completeGoogleFirebaseRedirect,
  googleAuthReturnScreenFromLocation,
} from "./firebase-auth";

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
let googleAuthStartup: Promise<void> | null = null;

function finishGoogleAuthRedirect(): Promise<void> {
  if (!googleAuthStartup) {
    googleAuthStartup = (async () => {
      try {
        if (!googleAuthReturnScreenFromLocation()) return;
        const { firebaseConfig } = await api.getConfig();
        if (!firebaseConfig) throw new Error("Google sign-in is not configured.");
        const idToken = await completeGoogleFirebaseRedirect(firebaseConfig);
        if (idToken) await api.googleSignIn(idToken);
      } finally {
        clearGoogleAuthReturnFromLocation();
      }
    })();
  }
  return googleAuthStartup;
}

function decodePathComponent(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function rankedInviteFromPath() {
  const match = window.location.pathname.match(/^\/ranked\/(challenge|rematch)\/([^/]+)$/);
  const token = match ? decodePathComponent(match[2]) : null;
  return match && token ? { kind: match[1] as "challenge" | "rematch", token } : null;
}

function guestInviteFromPath() {
  const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
  return match ? decodePathComponent(match[1]) : null;
}

function quickRematchFromPath() {
  const match = window.location.pathname.match(/^\/quick\/rematch\/([^/]+)$/);
  return match ? decodePathComponent(match[1]) : null;
}

const ACTIONS: ReadonlyArray<{
  type: Action["type"];
  label: string;
  cost: number;
  short: string;
}> = [
  { type: "expand", label: "Expand", cost: 0, short: "Claim an adjacent node" },
  { type: "ambush", label: "Ambush", cost: 0, short: "Predict their Expand" },
  { type: "surge", label: "Surge", cost: 3, short: "Take up to 2 open or rival nodes" },
  { type: "override", label: "Override", cost: 2, short: "Steal an adjacent node" },
  { type: "pass", label: "Pass", cost: 0, short: "Take no action" },
];

const OUTCOME_COPY: Record<ActionOutcome["reason"], string> = {
  claimed: "claimed the node",
  stolen: "took control of the node",
  "ambush-hit": "read the Expand",
  "ambush-missed": "did not catch an Expand",
  collision: "collided; the node stayed neutral",
  intercepted: "was stopped by an Ambush",
  passed: "passed",
  "automatic-pass": "ran out of time and passed",
};

function outcomeExplanation(outcome: ActionOutcome): string {
  if (outcome.action.type === "surge" && outcome.cells) {
    const captured = outcome.cells.filter((cell) => cell.success).length;
    const stolen = outcome.cells.filter((cell) => cell.reason === "stolen").length;
    const blocked = outcome.cells.length - captured;
    return `captured ${captured} ${captured === 1 ? "node" : "nodes"}${stolen ? ` (${stolen} stolen)` : ""}${blocked ? `; ${blocked} collided` : ""}`;
  }
  if (outcome.reason === "ambush-hit" && outcome.energyEarned === 0) {
    return "read the Expand; Energy was already full";
  }
  return OUTCOME_COPY[outcome.reason];
}

function energyEffect(outcome: ActionOutcome): string {
  const effects = [
    ...(outcome.energySpent > 0 ? [`Spent ${outcome.energySpent} Energy`] : []),
    ...(outcome.energyEarned > 0 ? [`Earned ${outcome.energyEarned} Energy`] : []),
  ];
  if (outcome.reason === "ambush-hit" && outcome.energyEarned === 0) effects.push("Energy was full; none earned");
  return effects.length ? effects.join(" · ") : "No Energy change";
}

const signed = (value: number) => value >= 0 ? `+${value}` : `−${Math.abs(value)}`;

function GameDialog({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => {
      dialogRef.current?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialogRef} className={`game-dialog ${className}`} aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <button className="icon-button dialog-close" aria-label="Close explanation" onClick={onClose}>×</button>
    {children}
  </dialog>;
}

const ACTION_HELP: Record<Action['type'], string> = {
  expand: "Claim one open space beside your territory for free.",
  ambush: "Predict the rival’s exact Expand target to earn 1 Energy; you don’t capture it.",
  override: "Spend 2 Energy to steal one adjacent rival space.",
  surge: "Spend 3 Energy to take up to two spaces, each within two steps of your territory.",
  pass: "Make no move; Pass earns no Energy and needs no target.",
};

function trainingPrompt(run: LearningRun, selected: boolean, action: Action['type']) {
  if (run.expandAcknowledged && !run.completed && !run.seenTips.includes("independent-popup")) return { key: "independent-popup", title: "Your turn", text: "Choose your own move, then lock it." };
  if (run.completed || action !== "expand") return { key: `${action}-popup`, title: ACTIONS.find((item) => item.type === action)?.label ?? "Your move", text: ACTION_HELP[action] };
  if (selected) return { key: "lock-popup", title: "Lock your move", text: "Your choice stays editable until you press Lock move; both moves reveal together." };
  return { key: "target-popup", title: "Claim a space", text: "Try Expand: choose a highlighted space beside your territory." };
}

export function roundActionsDisabled(status: PublicMatch["status"], locked: boolean): boolean {
  return status !== "decision" || locked;
}

export function snapshotKeepsRoundLocked({ status, snapshotLocked, locking, lockedRound, round }: {
  status: PublicMatch["status"];
  snapshotLocked: boolean;
  locking: boolean;
  lockedRound: number | null;
  round: number;
}): boolean {
  return snapshotLocked || status !== "decision" || locking || lockedRound === round;
}

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
  return action.type === "pass" ? name : `${name} ${actionTargets(action).map(coordinate).join(" + ")}`;
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

function Home({ navigate, onGenericStart, onLearn }: { navigate: (screen: Screen) => void; onGenericStart: () => void; onLearn: () => void }) {
  return (
    <main className="home-shell">
      <section className="hero">
        <div className="hero-copy">
          <h1>Your rival has a plan.<br /><em>Ruin it.</em></h1>
          <p className="hero-intro">
            A territory duel on a 5×5 grid. Choose your move in secret, reveal together, and fight for control.
          </p>
          <div className="hero-entry"><button className="primary-cta" onClick={onGenericStart}>Start a game <span>→</span></button><p>No account needed.</p></div>
          <button className="secondary-cta learning-link" onClick={onLearn}>Learn with a bot · untimed <span aria-hidden="true">→</span></button>
        </div>
        <HeroDemo />
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

function ModeSelect({
  kind,
  onStart,
  navigate,
}: {
  kind: SoloMode;
  onStart: (mode: SoloMode, difficulty: Difficulty, creationKey: string, timed: boolean) => Promise<void>;
  navigate: (screen: Screen) => void;
}) {
  const [difficulty, setDifficulty] = useState<Difficulty>(kind === "practice" ? "Easy" : "Normal");
  const [timedPractice, setTimedPractice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertainCreation, setUncertainCreation] = useState(false);
  const creationRef = useRef<{ difficulty: Difficulty; timed: boolean; key: string } | null>(null);
  const launch = async () => {
    setBusy(true);
    setError("");
    const timed = kind === "quick" || timedPractice;
    if (creationRef.current?.difficulty !== difficulty || creationRef.current.timed !== timed) creationRef.current = { difficulty, timed, key: crypto.randomUUID() };
    try { await onStart(kind, difficulty, creationRef.current.key, timed); creationRef.current = null; setUncertainCreation(false); }
    catch (reason) {
      const uncertain = reason instanceof RequestError && reason.uncertain;
      setUncertainCreation(uncertain);
      if (!uncertain) creationRef.current = null;
      setError(`${reason instanceof Error ? reason.message : "The match could not start."}${uncertain ? " Retry to recover this same match." : ""}`);
    }
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
      <fieldset className="difficulty-picker" disabled={busy || uncertainCreation}>
        <legend>Bot difficulty</legend>
        {(["Easy", "Normal", "Hard"] as const).map((item) => (
          <button key={item} className={difficulty === item ? "active" : ""} onClick={() => setDifficulty(item)}>
            <strong>{item}</strong>
            <span>{item === "Easy" ? "Favors safe Expands" : item === "Normal" ? "Balances position and Energy" : "Reads the public board closely"}</span>
          </button>
        ))}
      </fieldset>
      {kind === "practice" && <label className="timed-practice"><input type="checkbox" disabled={busy || uncertainCreation} checked={timedPractice} onChange={(event) => setTimedPractice(event.target.checked)} />
        <span><strong>Use a turn timer</strong><small>Ten seconds per round. Off by default while you learn.</small></span>
      </label>}
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

function Game({ mode, difficulty, initialMatch, onExit, onRestart, onRestartPractice, onOpenRanked, onOpenLeaderboard, onQuickRematch, onReplayLearning, onStartDuel }: {
  mode: PlayMode;
  difficulty: Difficulty;
  initialMatch: PublicMatch;
  onExit: () => void;
  onRestart: (creationKey: string, currentMatch: PublicMatch) => Promise<void>;
  onRestartPractice: (creationKey: string) => Promise<void>;
  onOpenRanked: () => void;
  onOpenLeaderboard: () => void;
  onQuickRematch: (match: PublicMatch) => void;
  onReplayLearning: () => void;
  onStartDuel: () => void;
}) {
  const [match, setMatch] = useState(initialMatch.state);
  const [actionType, setActionType] = useState<Action["type"]>("expand");
  const [selectedTargets, setSelectedTargets] = useState<number[]>([]);
  const target = selectedTargets[0] ?? null;
  const [timeLeft, setTimeLeft] = useState(() => Math.max(0, Math.ceil(((initialMatch.deadline ?? initialMatch.serverNow) - initialMatch.serverNow) / 1000)));
  const [locked, setLocked] = useState(initialMatch.locked);
  const currentRoundRef = useRef(initialMatch.status === "review" ? initialMatch.state.round - 1 : initialMatch.state.round);
  const lockedRoundRef = useRef(initialMatch.locked ? initialMatch.state.round : null);
  const [reveal, setReveal] = useState(initialMatch.status === "decision" ? null : initialMatch.lastResult);
  const acknowledgedRoundRef = useRef(initialMatch.status === "decision" ? initialMatch.state.round - 1 : 0);
  const loadedLearning = loadLearning(initialMatch.id);
  const learningRef = useRef<LearningRun | null>(loadedLearning ? observeLearning(loadedLearning, initialMatch) : null);
  const [learning, setLearning] = useState(() => learningRef.current ? observeLearning(learningRef.current, initialMatch) : null);
  const updateLearning = (run: LearningRun) => { learningRef.current = run; setLearning(run); saveLearning(run); };
  const [submitting, setSubmitting] = useState(false);
  const [nextPending, setNextPending] = useState(false);
  const nextRef = useRef<{ round: number; key: string } | null>(null);
  const nextInFlight = useRef(false);
  const snapshotRef = useRef(initialMatch);
  const [leavingForDuel, setLeavingForDuel] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [revision, setRevision] = useState(initialMatch.revision);
  const revisionRef = useRef(initialMatch.revision);
  const [resultType, setResultType] = useState(initialMatch.resultType);
  const [confirmResign, setConfirmResign] = useState(false);
  const [afkWarning, setAfkWarning] = useState(Boolean(initialMatch.afkWarning));
  const [serverStatus, setServerStatus] = useState(initialMatch.status);
  const [showHint, setShowHint] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [dismissedResult, setDismissedResult] = useState<number | null>(null);
  const [deadlineAt, setDeadlineAt] = useState(initialMatch.deadline ? Date.now() + (initialMatch.deadline - initialMatch.serverNow) : null);
  const lockingRef = useRef(false);
  const restartingPracticeRef = useRef(false);
  const practiceRestartKeyRef = useRef<string | null>(null);
  const [restartingPractice, setRestartingPractice] = useState(false);
  const leaveButtonRef = useRef<HTMLButtonElement>(null);
  const roundLabelRef = useRef<HTMLElement>(null);
  const focusRoundAfterReveal = useRef(false);
  useEffect(() => {
    if (reveal || !focusRoundAfterReveal.current) return;
    focusRoundAfterReveal.current = false;
    const frame = window.requestAnimationFrame(() => roundLabelRef.current?.focus({ preventScroll: true }));
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
      : actionType === "surge" && selectedTargets.length === 2
        ? { type: "surge", target, secondTarget: selectedTargets[1] } : { type: actionType, target };
  const decisionOpen = serverStatus === "decision" && match.status === "active";
  const canAct = decisionOpen && !roundActionsDisabled(serverStatus, locked) && !submitting;

  const commit = async (forcedAction?: Action) => {
    if (lockingRef.current || !canAct) return;
    const playerAction = forcedAction ?? selectedAction;
    if (!playerAction) return;
    lockingRef.current = true;
    setSubmitting(true);
    setNetworkError("");
    try {
      const response = await api.lockAction(initialMatch.id, playerAction, match.round, revision);
      receiveSnapshot(response.match);
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "The move could not be locked.");
      lockingRef.current = false;
      try {
        receiveSnapshot((await api.getMatch<PublicMatch>(initialMatch.id)).match);
      } catch { setLocked(true); /* Keep uncertain controls closed until an authoritative poll. */ }
    } finally {
      lockingRef.current = false;
      setSubmitting(false);
    }
  };

  const receiveSnapshot = (snapshot: PublicMatch, acknowledgeRound?: number): boolean => {
    if (!snapshotIsCurrent(snapshot, revisionRef.current)) return false;
    snapshotRef.current = snapshot;
    const advancedRound = snapshot.status === "decision" && snapshot.state.round > currentRoundRef.current;
    if (advancedRound) {
      currentRoundRef.current = snapshot.state.round;
      lockedRoundRef.current = null;
      setActionType("expand");
      setSelectedTargets([]);
      setResultOpen(false);
    }
    if (acknowledgeRound !== undefined) acknowledgedRoundRef.current = Math.max(acknowledgedRoundRef.current, acknowledgeRound);
    const pendingLearningRound = learningRef.current?.pendingAcknowledgement;
    if (snapshot.status === "decision" && pendingLearningRound != null && resolvedRound(snapshot) === pendingLearningRound) {
      acknowledgedRoundRef.current = Math.max(acknowledgedRoundRef.current, pendingLearningRound);
      focusRoundAfterReveal.current = true;
    }
    setMatch(snapshot.state);
    setServerStatus(snapshot.status);
    setReveal(snapshot.status === "finished" || (snapshot.lastResult && (resolvedRound(snapshot) ?? 0) > acknowledgedRoundRef.current)
      ? snapshot.lastResult : null);
    if (learningRef.current) updateLearning(observeLearning(learningRef.current, snapshot));
    setRevision(snapshot.revision);
    revisionRef.current = snapshot.revision;
    setResultType(snapshot.resultType);
    if (snapshot.locked) lockedRoundRef.current = snapshot.state.round;
    setLocked(snapshotKeepsRoundLocked({ status: snapshot.status, snapshotLocked: snapshot.locked,
      locking: lockingRef.current, lockedRound: lockedRoundRef.current, round: snapshot.state.round }));
    setAfkWarning(Boolean(snapshot.afkWarning));
    const nextDeadline = snapshot.deadline ? Date.now() + (snapshot.deadline - snapshot.serverNow) : null;
    setDeadlineAt((current) => current !== null && nextDeadline !== null && Math.abs(current - nextDeadline) < 250 ? current : nextDeadline);
    setTimeLeft(Math.max(0, Math.ceil(((snapshot.deadline ?? snapshot.serverNow) - snapshot.serverNow) / 1000)));
    return true;
  };

  useEffect(() => {
    if (match.status === "finished") return;
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = (await api.getMatch<PublicMatch>(initialMatch.id)).match;
        if (active && snapshotIsCurrent(snapshot, revisionRef.current)) {
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
    const deadlineFetch = deadlineAt === null ? null : window.setTimeout(() => void refresh(), deadlineDelay);
    const fallbackPoll = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; if (deadlineFetch !== null) window.clearTimeout(deadlineFetch); window.clearInterval(fallbackPoll); unsubscribe(); };
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
    if (!initialMatch.timed || !decisionOpen || deadlineAt === null) return;
    let requested = false;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (!remaining && !requested) { requested = true; void receiveTimeout(); }
    };
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [initialMatch.timed, decisionOpen, deadlineAt]);

  const nextRound = async () => {
    if (nextInFlight.current || !reveal || match.status === "finished") return;
    const reviewedRound = resolvedRound(snapshotRef.current);
    if (reviewedRound === null) return;
    nextInFlight.current = true;
    setNextPending(true);
    setNetworkError("");
    if (learningRef.current) updateLearning({ ...learningRef.current, pendingAcknowledgement: reviewedRound });
    try {
      let snapshot: PublicMatch | null = null;
      if (serverStatus === "review") {
        if (nextRef.current?.round !== reviewedRound) nextRef.current = { round: reviewedRound, key: crypto.randomUUID() };
        snapshot = (await api.nextRound(initialMatch.id, reviewedRound, revision, nextRef.current.key)).match;
      } else {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 350));
          snapshot = (await api.getMatch<PublicMatch>(initialMatch.id)).match;
          if (snapshot.status !== "transition") break;
        }
      }
      if (!snapshot) return;
      focusRoundAfterReveal.current = snapshot.status !== "finished";
      if (!receiveSnapshot(snapshot, reviewedRound)) return;
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "The next round could not be loaded.");
      try { receiveSnapshot((await api.getMatch<PublicMatch>(initialMatch.id)).match); }
      catch { /* Keep the review and retry identity until the next authoritative snapshot. */ }
    } finally { nextInFlight.current = false; setNextPending(false); }
  };

  const chooseAction = (type: Action["type"]) => {
    if (!canAct) return;
    setActionType(type);
    setSelectedTargets([]);
  };

  const restartPractice = async () => {
    if (restartingPracticeRef.current) return;
    restartingPracticeRef.current = true;
    setRestartingPractice(true);
    setNetworkError("");
    practiceRestartKeyRef.current ??= crypto.randomUUID();
    try {
      await onRestartPractice(practiceRestartKeyRef.current);
      practiceRestartKeyRef.current = null;
    } catch (reason) {
      setNetworkError(reason instanceof Error ? reason.message : "Practice could not restart.");
    } finally {
      restartingPracticeRef.current = false;
      setRestartingPractice(false);
    }
  };

  const hint = useMemo(() => {
    const first = legalActions(match, me).find((action) => action.type !== "pass");
    return first ? `Try ${actionText(first)}. Legal targets are outlined on the grid.` : "No territory move is available. Pass this round.";
  }, [match, me]);

  const acknowledgeReview = () => {
    const round = resolvedRound(snapshotRef.current);
    if (learningRef.current && round !== null) updateLearning(acknowledgeLearning(learningRef.current, round));
  };
  const exit = () => { if (match.status === "finished") acknowledgeReview(); onExit(); };
  if (serverStatus === "voided" || match.status === "finished") {
    return <ResultScreen match={match} totals={score(match.board)} player={me} ranked={mode === "ranked"} friend={Boolean(initialMatch.roomId)} matchId={initialMatch.id} resultType={resultType} onRestart={async (key) => { acknowledgeReview(); await onRestart(key, snapshotRef.current); }} onExit={exit} onOpenRanked={onOpenRanked} onOpenLeaderboard={onOpenLeaderboard} onQuickRematch={onQuickRematch} onSnapshot={receiveSnapshot}
      lastResult={reveal} learningReady={Boolean(learning && !learning.skipped && learning.independentRound !== null && !learning.completed)} onStartDuel={() => { acknowledgeReview(); onStartDuel(); }} onReplayLearning={onReplayLearning} />;
  }

  const resign = async () => {
    setNetworkError("");
    try { receiveSnapshot((await api.resignMatch(initialMatch.id)).match); setConfirmResign(false); if (leavingForDuel) { acknowledgeReview(); onStartDuel(); } }
    catch (reason) { setNetworkError(reason instanceof Error ? reason.message : "The match could not be resigned."); }
  };

  const closeResign = () => {
    setConfirmResign(false);
    setLeavingForDuel(false);
    window.requestAnimationFrame(() => leaveButtonRef.current?.focus());
  };

  const upcomingRoundLabel = match.phase === "sudden-death"
    ? `Sudden Death ${Math.max(1, match.round - match.config.standardRounds)}`
    : `Round ${match.round} / ${match.config.standardRounds}`;
  const roundLabel = (serverStatus === "review" || serverStatus === "transition") && reveal
    ? `Round ${resolvedRound(snapshotRef.current)} · ${serverStatus === "review" ? "Review" : "Reveal"}` : upcomingRoundLabel;
  const coaching = learning && !learning.skipped;
  const qualifyingReview = Boolean(coaching && !learning.completed && learning.independentRound !== null && reveal);
  const prompt = learning ? trainingPrompt(learning, Boolean(selectedAction), actionType) : null;
  const showPrompt = Boolean(coaching && prompt && decisionOpen && !locked && !learning.seenTips.includes(prompt.key));
  const closeHelp = () => {
    if (coaching && prompt && !learning.seenTips.includes(prompt.key)) updateLearning({ ...learning, seenTips: [...learning.seenTips, prompt.key] });
    setHelpOpen(false);
  };
  const automatic = initialMatch.progression === "automatic" && initialMatch.policyVersion === 2;
  const lastResult = reveal ?? snapshotRef.current.lastResult;
  const reviewRound = resolvedRound(snapshotRef.current);
  const showResult = Boolean(lastResult && (resultOpen || (!automatic && !decisionOpen && dismissedResult !== reviewRound)));
  const closeResult = () => { setDismissedResult(reviewRound); setResultOpen(false); };

  return (
    <main className={`game-page${initialMatch.timed ? " timed-decision" : ""}`}>
      <header className="match-header">
        <button ref={leaveButtonRef} className="icon-button" onClick={() => setConfirmResign(true)} aria-label="Leave match">×</button>
        <div><span>{mode === "practice" ? "Practice" : mode === "ranked" ? "Ranked Duel" : `Quick Duel · ${initialMatch.roomId ? "Friend" : difficulty}`}</span><strong ref={roundLabelRef} tabIndex={-1}>{roundLabel}</strong></div>
        {initialMatch.timed && decisionOpen
          ? <div className={`timer ${timeLeft <= 3 ? "urgent" : ""}`} aria-label={`${timeLeft} seconds remaining`}><b>{timeLeft}</b><span>SEC</span></div>
          : initialMatch.timed ? <div className="timer untimed"><b>—</b><span>{serverStatus === "review" ? "REVIEW" : "REVEAL"}</span></div>
          : <div className="timer untimed" aria-label="Untimed Practice"><b>—</b><span>NO TIMER</span></div>}
      </header>

      <section className="score-rail" aria-label="Match score">
        <div className={`player-score you side-${me}`}><span className="owner-symbol">{me === "A" ? "●" : "◆"}</span><p><small>You · {me}</small><strong>{totals[me].toString().padStart(2, "0")}</strong></p></div>
        <div className="round-track"><span style={{ width: `${Math.min(100, ((match.round - 1) / match.config.standardRounds) * 100)}%` }} /></div>
        <div className={`player-score bot side-${rival}`}><p><small>{mode === "ranked" || initialMatch.roomId ? initialMatch.playerNames[rival] : `${difficulty} bot`} · {rival}</small><strong>{totals[rival].toString().padStart(2, "0")}</strong></p><span className="owner-symbol">{rival === "A" ? "●" : "◆"}</span></div>
      </section>

      {automatic && serverStatus === "transition" && reveal && <aside className="round-notice" role="status">
        Round {reviewRound}: you {outcomeExplanation(reveal.outcomes[me])}; rival {outcomeExplanation(reveal.outcomes[rival])}. Next round opens automatically.
      </aside>}
      {showResult && lastResult && <GameDialog title={`Round ${reviewRound} result`} className="round-dialog" onClose={closeResult}>
        <RevealPanel result={lastResult} player={me} finalRound={false} activeRoundOpen={decisionOpen}
        automatic={automatic} pending={nextPending}
        learningReady={qualifyingReview} onStartDuel={() => { setLeavingForDuel(true); setConfirmResign(true); }}
        onContinue={() => {
          if (decisionOpen) {
            acknowledgedRoundRef.current = resolvedRound(snapshotRef.current) ?? 0;
            setReveal(null);
            closeResult();
            focusRoundAfterReveal.current = true;
          } else void nextRound();
        }} />
        {initialMatch.timed && decisionOpen && <p className="status-note">The clock keeps running.</p>}
        {networkError && <p className="form-error" role="alert">{networkError}</p>}
      </GameDialog>}
      {(helpOpen || showPrompt) && !showResult && !confirmResign && <GameDialog title={!helpOpen && prompt ? prompt.title : "Action rules"} onClose={closeHelp}>
        <h2>{!helpOpen && prompt ? prompt.title : "Action rules"}</h2>
        {!helpOpen && prompt ? <p>{prompt.text}</p> : <div className="action-help-list">{ACTIONS.map((action) => <p key={action.type}><b>{action.label}</b> · {ACTION_HELP[action.type]}</p>)}<p>Energy caps at 3; collisions leave the space neutral and don’t refund Energy.</p></div>}
        {initialMatch.timed && decisionOpen && <p className="status-note">The clock keeps running.</p>}
        <button className="primary-cta full" onClick={closeHelp}>Got it <span aria-hidden="true">→</span></button>
        {coaching && <button className="back-link" onClick={() => { updateLearning({ ...learning, skipped: true }); setHelpOpen(false); }}>Skip coaching</button>}
      </GameDialog>}

      <div className="game-layout">
        <section className="move-panel" aria-labelledby="move-title">
          <div className="move-heading"><div><span>YOUR MOVE</span><h2 id="move-title">Choose an action.</h2></div><small>One move per round</small></div>
          <div className="action-grid">
            {ACTIONS.map((action) => {
              const canAfford = match.energy[me] >= action.cost;
              const hasTargets = action.type === "pass" || legalTargets(match, me, action.type).length > 0;
              const reason = !canAfford ? `Need ${action.cost - match.energy[me]} more Energy` : !hasTargets ? "No legal target · see action rules" : action.short;
              return (
                <button key={action.type} className={actionType === action.type ? "selected" : ""}
                  onClick={() => chooseAction(action.type)} disabled={!canAct || !canAfford || !hasTargets}
                  aria-pressed={actionType === action.type} aria-label={`${action.label} · ${reason}${action.cost ? ` · ${action.cost} Energy` : " · free"}`}>
                  <span className={`action-glyph glyph-${action.type}`} aria-hidden="true" />
                  <span><strong>{action.label}</strong><small className="action-description">{reason}</small><small className="action-availability">{!canAfford ? `Need ${action.cost - match.energy[me]}ϟ` : !hasTargets ? "No target" : action.cost ? `${action.cost}ϟ` : "Free"}</small></span>
                  {action.cost > 0 && <b className="cost">{action.cost}ϟ</b>}
                </button>
              );
            })}
          </div>
          <p className="selected-action-help" role="status">{ACTIONS.find((action) => action.type === actionType)?.short}{actionType === "ambush" ? " · hit: +1ϟ, no capture." : ""}</p>
        </section>
        <section className="board-panel" aria-labelledby="board-title">
          <div className="board-label"><span id="board-title">Territory grid</span><span>{!decisionOpen ? "ROUND REVEALED" : submitting ? "SENDING MOVE" : locked ? "MOVE LOCKED" : "CHOOSE A TARGET"}</span></div>
          <GameBoard board={match.board} legal={legal} target={target} secondTarget={selectedTargets[1] ?? null} disabled={!canAct} you={me}
            onTarget={(cell) => setSelectedTargets((current) => actionType === "surge" ? toggleSurgeTarget(current, cell) : [cell])} />
          <div className="energy-bar" aria-label={`Your Energy ${match.energy[me]} of 3. Rival Energy ${match.energy[rival]} of 3.`}>
            <span>ENERGY</span>
            {[1, 2, 3].map((value) => <i key={value} className={value <= match.energy[me] ? "charged" : ""}>ϟ</i>)}
            <strong>{match.energy[me]} / 3</strong>
            <small className="rival-energy">RIVAL {match.energy[rival]} / 3</small>
          </div>
          {!learning && <p className="energy-note">Ambush hits earn +1 Energy · cap 3</p>}
          {mode === "practice" && !learning && <div className="hint-control"><button type="button" onClick={() => setShowHint((value) => !value)} aria-pressed={showHint}>{showHint ? "Hide hints" : "Show hints"}</button></div>}
          {mode === "practice" && !learning && showHint && <p className="coach-note"><b>Hint</b>{hint}</p>}
        </section>

        <section className="commit-panel" aria-label={decisionOpen ? "Confirm your move" : "Match options"}>
          <div className="selection-line">
            <span>Selected{actionType === "surge" ? ` · ${selectedTargets.length}/2 · tap again to deselect` : ""}</span><strong>{selectedAction ? actionText(selectedAction) : `${ACTIONS.find((item) => item.type === actionType)?.label}: choose a node`}</strong>
          </div>
          <button className="lock-button" disabled={!selectedAction || !canAct} onClick={() => void commit()}>
            {submitting ? "Sending move…" : locked ? "Move locked" : "Lock move"}<span>{locked ? "✓" : "→"}</span>
          </button>
          <nav className="match-tools" aria-label="Match help">
            <button className="back-link" onClick={() => setHelpOpen(true)}>Action rules</button>
            <button className="back-link" disabled={!lastResult} onClick={() => setResultOpen(true)}>Round result</button>
          </nav>
          {networkError && <p className="form-error" role="alert">{networkError}</p>}
          {connectionError && <p className="form-error" role="status">{connectionError}</p>}
          {serverStatus === "grace" && <p className="status-note" role="status">Match paused while a player reconnects. The server will resume or finish it after the grace period.</p>}
          {afkWarning && <p className="afk-warning" role="alert"><b>AFK warning</b> Choose a move this round. A third connected miss ends the match.</p>}
          {mode === "practice" && <button className="secondary-cta full" disabled={restartingPractice} onClick={() => void restartPractice()}>
            {restartingPractice ? "Restarting Practice…" : "Restart Practice"}
          </button>}
          {learning && <button className="back-link" onClick={onReplayLearning}>Replay learning</button>}
          {!learning && <p className="privacy-note">{mode === "ranked" || initialMatch.roomId ? initialMatch.policyVersion === 2 ? "Moves stay secret until both players lock or time expires. Early reveal means both committed." : "Moves stay secret until the fixed server deadline." : "The bot chooses from the same public pre-round state and cannot see your pending move."}</p>}
        </section>
      </div>

      {confirmResign && <ResignDialog ranked={mode === "ranked"} onCancel={closeResign} onConfirm={() => void resign()} />}
    </main>
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

function WelcomeDialog({ onClose, onLearn, onDuel }: { onClose: () => void; onLearn: () => void; onDuel: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    dialogRef.current?.querySelector<HTMLButtonElement>('.primary-cta')?.focus();
    return () => dialogRef.current?.close();
  }, []);
  return <dialog ref={dialogRef} className="welcome-dialog" aria-labelledby="welcome-title"
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && index === buttons.length - 1) {
        event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
      }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <button className="icon-button" aria-label="Close welcome" onClick={onClose}>×</button>
    <h2 id="welcome-title">Your first move</h2><p>Finish with more territory than your rival.</p>
    <button className="primary-cta full" autoFocus onClick={onLearn}>Learn with a bot <small>Recommended · untimed</small></button>
    <button className="secondary-cta full" onClick={onDuel}>Jump into a duel</button>
  </dialog>;
}

export function RevealPanel({ result, player, finalRound, activeRoundOpen, onContinue, automatic = false, pending = false, learningReady = false, onStartDuel }: {
  result: NonNullable<PublicMatch["lastResult"]>;
  player: Player;
  finalRound: boolean;
  activeRoundOpen: boolean;
  onContinue: () => void;
  automatic?: boolean;
  pending?: boolean;
  learningReady?: boolean;
  onStartDuel?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(finalRound);
  useEffect(() => {
    setDetailsOpen(finalRound);
  }, [result.state.round, activeRoundOpen, finalRound]);
  const rival: Player = player === "A" ? "B" : "A";
  const rows = ([player, rival] as const).map((side) => ({ side, outcome: result.outcomes[side] }));
  const winnerText = result.state.winner === player ? "You win" : result.state.winner === rival ? "Rival wins" : "The match is tied";
  return (
    <section className="round-review" role="region" aria-labelledby="reveal-title" aria-live="polite">
      <div className="round-review-heading">
        <p className="eyebrow">Simultaneous reveal</p>
        <h2 id="reveal-title">Round {result.round ?? (result.state.status === "finished" ? result.state.round : result.state.round - 1)} resolved.</h2>
        <button className="reveal-details-toggle" type="button" aria-expanded={detailsOpen} aria-controls="reveal-actions"
          onClick={() => setDetailsOpen((open) => !open)}>
          {detailsOpen ? "Hide details" : "Show details"}
        </button>
      </div>
        <div id="reveal-actions" className={`reveal-actions${detailsOpen ? "" : " is-compact"}`}>
          {rows.map(({ side, outcome }) => (
            <div key={side} className={`${side === player ? "you" : "bot"} side-${side}`}>
              <span>{side === player ? "YOU" : "RIVAL"}</span>
              <strong>{actionText(outcome.action)}</strong>
              <p>{outcomeExplanation(outcome)}.</p>
              <small>{energyEffect(outcome)}</small>
              {detailsOpen && <>
                {outcome.cells && <p>{outcome.cells.map((cell) => `${coordinate(cell.target)}: ${OUTCOME_COPY[cell.reason]}`).join(" · ")}</p>}
                <p>Territory {result.score[side]}{result.beforeScore && ` (${signed(result.score[side] - result.beforeScore[side])})`} · Energy {result.state.energy[side]}{result.beforeEnergy && ` (${signed(result.state.energy[side] - result.beforeEnergy[side])})`}</p>
              </>}
            </div>
          ))}
        </div>
        {finalRound && result.state.status === "finished" && (result.state.winner !== null || result.state.endingReason) && <p className={`reveal-winner ${result.state.winner === player ? "you-win" : result.state.winner === rival ? "rival-wins" : "tied"}`} role="status">{winnerText}</p>}
        <div className="reveal-score" aria-label={`Territory score: you ${result.score[player]}, rival ${result.score[rival]}`}>
          <div><small>You</small><strong>{result.score[player]}</strong></div><i aria-hidden="true">—</i><div><small>Rival</small><strong>{result.score[rival]}</strong></div>
        </div>
        {!finalRound && (automatic && !activeRoundOpen ? <p role="status">Next round opens automatically after the shared reveal.</p>
          : <div className="review-navigation">{learningReady && <p>You practiced the loop. Continue Practice or start a duel.</p>}<button className="secondary-cta full" disabled={pending} onClick={onContinue}>
            {pending ? "Opening round…" : activeRoundOpen ? "Hide result" : "Next round"} <span>→</span>
          </button>{learningReady && <button className="primary-cta full" disabled={pending} onClick={onStartDuel}>Start a duel <span>→</span></button>}</div>)}
      </section>
  );
}

export function RankedSettlementDetails({ settlement, profile }: { settlement: RankedSettlement; profile: RankedProfile | null }) {
  const mine = settlement.player;
  return <>
    <section className="settlement-card">
      {mine.delta !== undefined && <div><span>RP change</span><strong className={mine.delta >= 0 ? "positive" : "negative"}>{mine.delta >= 0 ? "+" : ""}{mine.delta}</strong></div>}
      {mine.ratingAfter !== undefined && <div><span>Rating</span><strong>{mine.ratingBefore === undefined ? mine.ratingAfter : `${mine.ratingBefore} → ${mine.ratingAfter}`}</strong></div>}
      <div><span>Credit</span><strong>{Math.round(settlement.multiplier * 100)}%</strong></div>
      {mine.placementProgress >= PLACEMENT_MATCHES && <div><span>Tier</span><strong>{profile?.tier ?? "Updating"}</strong></div>}
      <div><span>{mine.placementProgress < PLACEMENT_MATCHES ? "Placement" : "Global rank"}</span><strong>{mine.placementProgress < PLACEMENT_MATCHES ? `${mine.placementProgress}/${PLACEMENT_MATCHES}` : profile?.rank ? `#${profile.rank}` : "Updating"}</strong></div>
    </section>
    <p className="status-note">{creditExplanation(settlement.multiplier)}</p>
    {profile?.rating !== undefined && <p className="next-rival">{nextRivalText(profile.rating)}</p>}
  </>;
}

function ResultScreen({ match, totals, player, ranked, friend, matchId, resultType, onRestart, onExit, onOpenRanked, onOpenLeaderboard, onQuickRematch, onSnapshot, lastResult, learningReady, onStartDuel, onReplayLearning }: {
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
  lastResult: PublicMatch['lastResult'];
  learningReady: boolean;
  onStartDuel: () => void;
  onReplayLearning: () => void;
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
      <h1 className={title === "Victory" ? "victory" : title === "Defeat" ? "defeat" : title === "Draw" ? "draw" : ""} ref={titleRef} tabIndex={-1}>{title}</h1>
      <div className="result-score" aria-label={`Final score: you ${totals[player]}, rival ${totals[rival]}`}><span><small>You</small>{totals[player]}</span><i>—</i><span><small>Rival</small>{totals[rival]}</span></div>
      <p>{resultType === "server-error" ? "Match voided due to a connection or server error. No rating was changed." :
        resultType === "no-contest" ? "Neither player receives competitive credit for this match." :
        resultType === "resignation" ? "The match ended by resignation." :
          resultType === "forfeit" ? "The match ended by forfeit." :
            match.endingReason === "board-exhaustion" ? "No legal territory-changing moves remained." : "Final territory after the last round."}</p>
      {lastResult && <RevealPanel result={lastResult} player={player} finalRound activeRoundOpen={false} onContinue={onExit} />}
      {learningReady && <p role="status">You practiced the loop. Start a duel or leave to acknowledge this result.</p>}
      {!ranked && !friend && <div className="learning-choices"><button className="secondary-cta" onClick={onStartDuel}>Start a duel</button><button className="back-link" onClick={onReplayLearning}>Replay learning</button></div>}
      {ranked && settlement && <RankedSettlementDetails settlement={settlement} profile={profile} />}
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

function RankedScreen({ navigate, onMatch, inviteIntent, authRedirectError }: { navigate: (screen: Screen) => void; onMatch: (match: PublicMatch) => void; inviteIntent: { kind: "challenge" | "rematch"; token: string } | null; authRedirectError: string }) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [firebaseConfig, setFirebaseConfig] = useState<{ apiKey: string; authDomain: string; projectId: string; appId: string } | null>(null);
  const [handle, setHandle] = useState("");
  const [queue, setQueue] = useState<RankedQueue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [challengeCode, setChallengeCode] = useState("");
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const [inviteFailed, setInviteFailed] = useState(false);
  const [inviteAttempt, setInviteAttempt] = useState(0);
  const [arenaConnected, setArenaConnected] = useState(false);
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
      setFirebaseConfig(config.firebaseConfig);
      if (session.signedIn && session.profile?.handle) {
        if (!inviteIntent) void api.getCurrentRankedChallenge()
          .then(({ invitation }) => {
            if (!active) return;
            setInviteUrl(invitation?.inviteUrl ?? "");
            setInviteCode(invitation?.code ?? "");
          })
          .catch(() => undefined);
        void refreshQueue();
      }
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Ranked could not be loaded."));
    return () => { active = false; };
  }, []);

  useEffect(() => { if (authRedirectError) setError(authRedirectError); }, [authRedirectError]);

  useEffect(() => {
    if ((!queue && !inviteUrl) || queue?.state === "active" || queue?.state === "timed-out" || queue?.state === "ready-expired") return;
    const timer = window.setInterval(() => void refreshQueue().catch(() => undefined), 900);
    return () => window.clearInterval(timer);
  }, [queue?.state, queue?.matchId, inviteUrl]);

  useEffect(() => {
    if (queue?.state !== "readying" || !queue.matchId) {
      setArenaConnected(false);
      return;
    }
    setArenaConnected(false);
    return api.subscribeMatch(queue.matchId, () => void refreshQueue(), () => setArenaConnected(true), () => setArenaConnected(false));
  }, [queue?.state, queue?.matchId]);

  const signInWithGoogle = async () => {
    if (!firebaseConfig || busy) return;
    setBusy(true);
    setError("");
    void api.trackEvent("ranked_auth_started", "ranked").catch(() => undefined);
    try {
      await beginGoogleFirebaseSignIn(firebaseConfig, "ranked");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!profile?.handle || !inviteIntent || inviteDismissed || acceptingInvite.current || queue) return;
    acceptingInvite.current = true;
    setInviteFailed(false);
    setBusy(true);
    api.acceptRankedInvite(inviteIntent.kind, inviteIntent.token).then(({ shell }) => {
      setQueue({ state: "readying", matchId: shell.matchId, competitiveMultiplier: shell.competitiveMultiplier, readyDeadline: shell.readyDeadline });
      setError("");
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "This Ranked invitation could not be opened.");
      setInviteFailed(true);
      acceptingInvite.current = false;
    }).finally(() => setBusy(false));
  }, [profile?.handle, inviteIntent?.kind, inviteIntent?.token, queue, inviteDismissed, inviteAttempt]);

  const dismissInvite = () => {
    acceptingInvite.current = false;
    setInviteDismissed(true);
    setError("");
    window.history.replaceState(null, "", "/");
  };

  const retryInvite = () => {
    acceptingInvite.current = false;
    setInviteFailed(false);
    setError("");
    setInviteAttempt((attempt) => attempt + 1);
  };

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
    try {
      const invitation = (await api.createRankedChallenge()).invitation;
      setInviteUrl(invitation.inviteUrl);
      setInviteCode(invitation.code ?? "");
      void api.trackEvent("opponent_selected", "ranked-friend").catch(() => undefined);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The challenge could not be created."); }
    finally { setBusy(false); }
  };
  const acceptChallengeCode = async () => {
    setBusy(true); setError("");
    try {
      const { shell } = await api.acceptRankedChallengeCode(challengeCode.trim());
      setChallengeCode("");
      setInviteUrl("");
      setInviteCode("");
      setQueue({ state: "readying", matchId: shell.matchId, competitiveMultiplier: shell.competitiveMultiplier, readyDeadline: shell.readyDeadline });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "That challenge code could not be opened."); }
    finally { setBusy(false); }
  };

  return (
    <main className="panel-page ranked-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="ranked-badge">R</div>
      <div className="panel-heading"><p className="eyebrow">Human opponents · Rated</p><h1>Ranked Duel</h1><p>Sign in with Google to enter matchmaking, complete two placement matches, and earn an official human leaderboard rank.</p></div>
      {!signedIn && <button className="google-button" disabled={!firebaseConfig || busy} onClick={() => void signInWithGoogle()}><span>G</span> {busy ? "Signing in…" : firebaseConfig ? "Continue with Google" : "Google sign-in is not configured"}</button>}
      {signedIn && !profile?.handle && <section className="room-form ranked-setup"><label>Choose a public handle<input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="3–16 letters, numbers, or _" maxLength={16} /></label><button className="primary-cta full" disabled={busy || !/^[A-Za-z0-9_]{3,16}$/.test(handle)} onClick={claim}>Claim handle <span>→</span></button></section>}
      {profile?.handle && !queue && (!inviteIntent || inviteDismissed) && <section className="ranked-console"><p>Signed in as <strong>{profile.handle}</strong></p><button className="primary-cta full" disabled={busy} onClick={findOpponent}>Find opponent <span>→</span></button><button className="secondary-cta full challenge-button" disabled={busy} onClick={challenge}>Challenge friend</button>{inviteUrl && <div className="invite-output"><span>Waiting for friend to accept</span>{inviteCode && <p>Challenge code <strong>{inviteCode}</strong></p>}<div className="invite-actions">{inviteCode && <button onClick={() => navigator.clipboard.writeText(inviteCode)}>Copy code</button>}<button onClick={() => navigator.clipboard.writeText(inviteUrl)}>Copy invite link</button></div></div>}<form className="ranked-code-form" onSubmit={(event) => { event.preventDefault(); void acceptChallengeCode(); }}><label>Join a Ranked challenge<input value={challengeCode} onChange={(event) => setChallengeCode(event.target.value.toUpperCase())} placeholder="10-character code" maxLength={12} autoCapitalize="characters" /></label><button className="secondary-cta full" disabled={busy || !challengeCode.trim()}>Join challenge</button></form></section>}
      {profile?.handle && inviteIntent && !inviteDismissed && !queue && <section className="ranked-console">{inviteFailed ? <><strong>Invitation could not be opened.</strong><p>Check that it is still valid, or return to Ranked.</p><button className="primary-cta full" disabled={busy} onClick={retryInvite}>Retry invitation <span>→</span></button><button className="secondary-cta full" disabled={busy} onClick={dismissInvite}>Return to Ranked</button></> : <><div className="queue-pulse" /><strong>Opening {inviteIntent.kind}…</strong><p>Your destination was preserved through sign-in.</p></>}</section>}
      {queue?.state === "searching" && <section className="ranked-console"><div className="queue-pulse" /><strong>Finding an opponent…</strong><p>Search expands over 15 seconds.</p><button className="secondary-cta full" onClick={() => void api.leaveRankedQueue().then(() => setQueue(null))}>Cancel</button></section>}
      {queue?.state === "timed-out" && <section className="ranked-console"><strong>No opponent found this time.</strong><p>Search timed out after 15 seconds.</p><button className="primary-cta full" disabled={busy} onClick={findOpponent}>Try again <span>→</span></button></section>}
      {queue?.state === "ready-expired" && <section className="ranked-console"><strong>Ready window expired.</strong><p>Both players need to confirm within 15 seconds. This match did not affect ratings.</p><button className="secondary-cta full" onClick={() => { if (inviteIntent) dismissInvite(); setQueue(null); }}>Return to Ranked</button></section>}
      {queue?.state === "readying" && <section className="ranked-console"><p className="eyebrow">Opponent found</p><strong>{queue.competitiveMultiplier === 1 ? "Full competitive credit" : `${Math.round((queue.competitiveMultiplier ?? 0) * 100)}% RP credit`}</strong><p>{creditExplanation(queue.competitiveMultiplier ?? 0)}</p><p>{arenaConnected ? "Opponent identity appears after both players commit." : "Connecting to the arena…"}</p><button className="primary-cta full" disabled={busy || !arenaConnected} onClick={ready}>Ready <span>→</span></button></section>}
      {queue?.state === "cooldown" && <section className="ranked-console"><strong>Ranked cooldown</strong><p>Matchmaking is temporarily unavailable after repeated disconnect incidents.</p></section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ranked-facts"><p><strong>1000</strong><span>Starting RP</span></p><p><strong>{PLACEMENT_MATCHES}</strong><span>Placements</span></p><p><strong>Human</strong><span>Opponents only</span></p></div>
      {!profile?.handle && <p className="status-note">Your Google email is never shown as your public game identity.</p>}
    </main>
  );
}

function InfoScreen({ screen, navigate, authRedirectError, onStartPractice }: { screen: "leaderboard" | "profile" | "how-to"; navigate: (screen: Screen) => void; authRedirectError: string; onStartPractice: () => void }) {
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [firebaseConfig, setFirebaseConfig] = useState<{ apiKey: string; authDomain: string; projectId: string; appId: string } | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState("");
  const [infoLoading, setInfoLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setError("");
    setInfoLoading(true);
    if (screen === "profile") Promise.all([api.getSession(), api.getConfig()])
      .then(([session, config]) => {
        if (!current) return;
        setProfile(session.profile);
        setSignedIn(session.signedIn);
        setFirebaseConfig(config.firebaseConfig);
      })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "Profile unavailable."); })
      .finally(() => { if (current) setInfoLoading(false); });
    if (screen === "leaderboard") {
      Promise.all([api.getLeaderboard(), api.getSession()])
        .then(([board, session]) => {
          if (!current) return;
          setLeaders(board.entries);
          setProfile(session.profile);
        })
        .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "Leaderboard unavailable."); })
        .finally(() => { if (current) setInfoLoading(false); });
    }
    return () => { current = false; };
  }, [screen]);
  useEffect(() => { if (authRedirectError) setError(authRedirectError); }, [authRedirectError]);
  const rename = async () => {
    setRenaming(true); setError("");
    try { setProfile((await api.renameHandle(newHandle.trim())).profile); setNewHandle(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The handle could not be changed."); }
    finally { setRenaming(false); }
  };
  const signInWithGoogle = async () => {
    if (!firebaseConfig || signInBusy) return;
    setSignInBusy(true); setError("");
    try {
      await beginGoogleFirebaseSignIn(firebaseConfig, "profile");
    } catch (reason) {
      const authError = reason as { code?: string; customData?: { originalError?: unknown } };
      const original = authError.customData?.originalError;
      const detail = original instanceof Error ? original.message : typeof original === "string" ? original : "";
      setError(authError.code === "auth/internal-error"
        ? detail ? `Google sign-in failed: ${detail}` : "Google sign-in could not finish in this browser. Open the game in Chrome or Edge and allow the Google sign-in window."
        : reason instanceof Error ? reason.message : "Google sign-in failed.");
    } finally { setSignInBusy(false); }
  };
  if (screen === "how-to") return <HowTo navigate={navigate} onStartPractice={onStartPractice} />;
  return (
    <main className="panel-page info-page">
      <button className="back-link" onClick={() => navigate("home")}>← Home</button>
      <div className="panel-heading">
        {screen === "profile" && <p className="eyebrow">Player profile</p>}
        <h1>{screen === "profile" ? profile?.handle ?? (signedIn ? "Signed in." : "Playing as guest.") : "Leaderboard"}</h1>
        <p>{screen === "profile" ? profile ? profile.rating === undefined ? `Placement ${profile.placementProgress ?? 0}/${PLACEMENT_MATCHES} · Provisional rating hidden` : `${profile.tier} · ${profile.rating} RP` : "Practice and Quick Duel work without an account." : "Placed players and practice bots share one RP ranking. BOT tags identify practice bots; practice matches do not change player records."}</p>
      </div>
      {infoLoading && <p className="status-note" role="status">Loading {screen === "profile" ? "profile" : "leaderboard"}…</p>}
      {screen === "profile" && !infoLoading && !signedIn && <button className="google-button" disabled={!firebaseConfig || signInBusy} onClick={() => void signInWithGoogle()}><span>G</span> {signInBusy ? "Signing in…" : firebaseConfig ? "Sign in with Google for Ranked" : "Google sign-in is not configured"}</button>}
      {screen === "profile" && signedIn && !profile?.handle && <button className="primary-cta full" onClick={() => navigate("ranked")}>Set up Ranked profile <span>→</span></button>}
      {screen === "profile" && profile && <ProfileStats profile={profile} />}
      {screen === "profile" && profile?.handle && <section className="room-form ranked-setup"><label>Change public handle<input value={newHandle} onChange={(event) => setNewHandle(event.target.value)} placeholder="3–16 letters, numbers, or _" maxLength={16} /></label><p className="status-note">After your first rename, you can change your handle once every 30 days.</p><button className="secondary-cta full" disabled={renaming || !/^[A-Za-z0-9_]{3,16}$/.test(newHandle.trim()) || newHandle.trim() === profile.handle} onClick={rename}>{renaming ? "Changing handle…" : "Change handle"}</button></section>}
      {screen === "leaderboard" && leaders.length > 0 && <div className="leaderboard-scroll" role="region" aria-label="Global Ranked leaderboard" tabIndex={0}><LeaderboardList entries={leaders} /></div>}
      {!infoLoading && !error && screen === "profile" && !profile && <div className="empty-state"><span aria-hidden="true">G</span><strong>No persistent profile yet</strong><p>Guest games do not carry into Ranked statistics.</p></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="secondary-cta full" onClick={() => navigate(screen === "profile" ? "quick" : "ranked")}>{screen === "profile" ? "Play Quick Duel" : "View Ranked"}</button>
    </main>
  );
}

export function ProfileStats({ profile }: { profile: RankedProfile }) {
  return <div className="profile-stats">
    {profile.rating !== undefined && <p><strong>{profile.rating}</strong><span>RP</span></p>}
    {profile.peakRating !== undefined && <p><strong>{profile.peakRating}</strong><span>Peak RP</span></p>}
    <p><strong>{profile.placementProgress ?? 0}/{PLACEMENT_MATCHES}</strong><span>Placement</span></p>
    {profile.rating !== undefined && <>
      <p><strong>{profile.rank ? `#${profile.rank}` : "Updating"}</strong><span>Global rank</span></p>
      <p><strong>{profile.ratedMatchCount}</strong><span>Rated matches</span></p>
      <p><strong>{profile.wins}-{profile.losses}-{profile.draws}</strong><span>W-L-D</span></p>
      <p><strong>{profile.streak}</strong><span>Win streak</span></p>
    </>}
  </div>;
}

export function LeaderboardList({ entries }: { entries: LeaderboardEntry[] }) {
  return <table className="leaderboard-table">
    <thead><tr><th scope="col">Rank</th><th scope="col">Username</th><th scope="col">Tier</th><th scope="col">W–L–D</th><th scope="col">RP</th></tr></thead>
    <tbody>{entries.map((entry) => <tr key={`${entry.bot ? "bot" : "player"}:${entry.handle}`}>
      <th scope="row" className="leaderboard-rank">#{entry.rank}</th>
      <td className="leaderboard-player"><span className="leaderboard-handle" title={entry.handle}>{entry.handle}</span>{entry.bot && <small className="bot-tag">BOT</small>}</td>
      <td className="leaderboard-tier">{entry.tier}</td>
      <td className="leaderboard-record" aria-label={`${entry.wins} ${entry.wins === 1 ? "win" : "wins"}, ${entry.losses} ${entry.losses === 1 ? "loss" : "losses"}, ${entry.draws} ${entry.draws === 1 ? "draw" : "draws"}`}>
        {entry.wins}–{entry.losses}–{entry.draws}
      </td>
      <td className="leaderboard-rating">{entry.rating}</td>
    </tr>)}</tbody>
  </table>;
}

export function App() {
  const inviteIntent = rankedInviteFromPath();
  const guestInvite = guestInviteFromPath();
  const quickRematchToken = quickRematchFromPath();
  const [screen, setScreen] = useState<Screen>(() => googleAuthReturnScreenFromLocation() ?? (inviteIntent ? "ranked" : guestInvite ? "room" : quickRematchToken ? "quick-rematch" : "home"));
  const [authLoading, setAuthLoading] = useState(true);
  const [authRedirectError, setAuthRedirectError] = useState("");
  const [gameKey, setGameKey] = useState(0);
  const [solo, setSolo] = useState<{ mode: PlayMode; difficulty: Difficulty }>({ mode: "practice", difficulty: "Normal" });
  const [botMatch, setBotMatch] = useState<PublicMatch | null>(null);
  const [resumedRoom, setResumedRoom] = useState<Room | null>(null);
  const [welcome, setWelcome] = useState(false);
  const welcomeTriggerRef = useRef<HTMLElement | null>(null);
  const [learningReplacement, setLearningReplacement] = useState<PublicMatch | null>(null);
  const [entryError, setEntryError] = useState("");
  const [learningBusy, setLearningBusy] = useState(false);
  const learningKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void finishGoogleAuthRedirect()
      .catch((reason) => { if (active) setAuthRedirectError(reason instanceof Error ? reason.message : "Google sign-in could not finish."); })
      .finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try { if (screen === "game" && botMatch) window.sessionStorage.setItem(CURRENT_MATCH_KEY, botMatch.id); } catch { /* Resume also uses the server. */ }
  }, [screen, botMatch]);

  useEffect(() => {
    if (authLoading) return;
    if (inviteIntent || guestInvite || quickRematchToken) return;
    let active = true;
    const restore = async () => {
      try {
        const { match, room, rankedQueue, rankedChallenge } = await api.getResume();
        if (!active) return;
        let previous: PublicMatch | null = null;
        let previousId: string | null = null;
        try { previousId = window.sessionStorage.getItem(CURRENT_MATCH_KEY); } catch { /* Server resume is sufficient. */ }
        if (!match && previousId) {
          try {
            const response = await api.getMatch<PublicMatch>(previousId);
            previous = response.match.status === "finished" || response.match.status === "voided" ? response.match : null;
          } catch {
            try { window.sessionStorage.removeItem(CURRENT_MATCH_KEY); } catch { /* Storage is optional. */ }
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
  }, [authLoading]);

  const navigate = (next: Screen) => {
    try { if (next !== "game") window.sessionStorage.removeItem(CURRENT_MATCH_KEY); } catch { /* Storage is optional. */ }
    if ((inviteIntent && next !== "ranked") || (guestInvite && next !== "room") || (quickRematchToken && next !== "quick-rematch")) window.history.replaceState(null, "", "/");
    if (next !== "room") setResumedRoom(null);
    if (next === "home") void api.trackEvent("homepage_opened").catch(() => undefined);
    if (next === "practice" || next === "quick" || next === "ranked") void api.trackEvent("mode_selected", next).catch(() => undefined);
    if (next === "room") void api.trackEvent("opponent_selected", "quick-human").catch(() => undefined);
    setScreen(next);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const start = async (mode: SoloMode, difficulty: Difficulty, creationKey: string, parentMatchId?: string, restartMatchId?: string, timed = mode === "quick", learning = false) => {
    if (!parentMatchId) void api.trackEvent("opponent_selected", `${mode}-bot`).catch(() => undefined);
    const response = await api.createBotMatch(mode, difficulty.toLowerCase() as Lowercase<Difficulty>, creationKey, parentMatchId, restartMatchId, timed);
    if (learning) beginLearning(response.match.id);
    setSolo({ mode, difficulty });
    setBotMatch(response.match);
    setGameKey((value) => value + 1);
    navigate("game");
  };
  const closeWelcome = (restore = true) => {
    writeFlag(WELCOME_KEY, "handled"); setWelcome(false);
    if (restore) window.requestAnimationFrame(() => welcomeTriggerRef.current?.focus());
  };
  const genericStart = async () => {
    setEntryError("");
    try {
      const { match, room, rankedQueue, rankedChallenge } = await api.getResume();
      if (match) { setBotMatch(match); setSolo({ mode: match.mode, difficulty: match.botDifficulty ? `${match.botDifficulty[0].toUpperCase()}${match.botDifficulty.slice(1)}` as Difficulty : "Normal" }); navigate("game"); return; }
      if (room) { setResumedRoom(room); navigate("room"); return; }
      if (rankedQueue || rankedChallenge) { navigate("ranked"); return; }
      if (readFlag(WELCOME_KEY)) navigate("quick");
      else { welcomeTriggerRef.current = document.activeElement as HTMLElement; setWelcome(true); }
    } catch (reason) { setEntryError(reason instanceof Error ? reason.message : "Please reconnect and try again."); }
  };
  const launchLearning = async () => {
    learningKeyRef.current ??= crypto.randomUUID();
    await start("practice", "Easy", learningKeyRef.current, undefined, undefined, false, true);
    learningKeyRef.current = null;
  };
  const learn = async () => {
    if (learningBusy) return;
    setLearningBusy(true); setEntryError("");
    try {
      const { match } = await api.getResume();
      if (match) setLearningReplacement(match);
      else await launchLearning();
    } catch (reason) { setEntryError(reason instanceof Error ? reason.message : "Learning could not start."); }
    finally { setLearningBusy(false); }
  };
  const replaceWithLearning = async () => {
    if (!learningReplacement || learningBusy) return;
    setLearningBusy(true); setEntryError("");
    try {
      await api.resignMatch(learningReplacement.id);
      setLearningReplacement(null);
      await launchLearning();
    } catch (reason) { setEntryError(reason instanceof Error ? reason.message : "The active match could not be left."); }
    finally { setLearningBusy(false); }
  };

  if (authLoading) return <div className="app-shell"><main className="panel-page"><p className="status-note" role="status">Checking sign-in…</p></main></div>;

  return (
    <div className="app-shell">
      {screen !== "game" && <AppHeader navigate={navigate} />}
      {entryError && <p className="form-error" role="alert">{entryError}</p>}
      {learningBusy && <p className="status-note" role="status">Starting untimed learning…</p>}
      {screen === "home" && <Home navigate={navigate} onGenericStart={() => void genericStart()} onLearn={() => void learn()} />}
      {screen === "practice" && <ModeSelect kind="practice" onStart={(mode, difficulty, key, timed) => start(mode, difficulty, key, undefined, undefined, timed)} navigate={navigate} />}
      {screen === "quick" && <ModeSelect kind="quick" onStart={(mode, difficulty, key, timed) => start(mode, difficulty, key, undefined, undefined, timed)} navigate={navigate} />}
      {screen === "game" && botMatch && <Game key={gameKey} {...solo} initialMatch={botMatch} onExit={() => navigate("home")} onStartDuel={() => navigate("quick")} onReplayLearning={() => void learn()} onOpenRanked={() => navigate("ranked")} onOpenLeaderboard={() => navigate("leaderboard")} onQuickRematch={(match) => { setBotMatch(match); setGameKey((value) => value + 1); }} onRestart={async (key, current) => { if (solo.mode === "ranked") navigate("ranked"); else if (current.roomId) navigate("room"); else await start(solo.mode, solo.difficulty, key, current.status === "voided" ? undefined : current.id, undefined, current.timed); }} onRestartPractice={(key) => start("practice", solo.difficulty, key, undefined, botMatch.id, botMatch.timed)} />}
      {screen === "room" && <RoomScreen inviteToken={guestInvite} initialRoom={resumedRoom} navigate={navigate} onMatch={(match) => { window.history.replaceState(null, "", "/"); setSolo({ mode: "quick", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {screen === "quick-rematch" && quickRematchToken && <QuickRematchLanding token={quickRematchToken} navigate={navigate} onMatch={(match) => { setSolo({ mode: "quick", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {screen === "ranked" && <RankedScreen inviteIntent={inviteIntent} authRedirectError={authRedirectError} navigate={navigate} onMatch={(match) => { window.history.replaceState(null, "", "/"); setSolo({ mode: "ranked", difficulty: "Normal" }); setBotMatch(match); setGameKey((value) => value + 1); navigate("game"); }} />}
      {(screen === "leaderboard" || screen === "profile" || screen === "how-to") && <InfoScreen screen={screen} authRedirectError={authRedirectError} navigate={navigate}
        onStartPractice={() => void learn()} />}
      {welcome && <WelcomeDialog onClose={() => closeWelcome()} onLearn={() => { closeWelcome(false); void learn(); }} onDuel={() => { closeWelcome(false); navigate("quick"); }} />}
      {learningReplacement && <ResignDialog ranked={learningReplacement.mode === "ranked"} onCancel={() => setLearningReplacement(null)} onConfirm={() => void replaceWithLearning()} />}
    </div>
  );
}
