import { BOARD_SIZE, legalActions, legalTargets, type Action, type Board, type MatchState, type Player } from "./rules";

export type BotDifficulty = "easy" | "normal" | "hard";

const opponent = (player: Player): Player => player === "A" ? "B" : "A";
const distance = (left: number, right: number): number =>
  Math.abs(Math.floor(left / BOARD_SIZE) - Math.floor(right / BOARD_SIZE)) +
  Math.abs(left % BOARD_SIZE - right % BOARD_SIZE);

function frontier(board: Board, target: number): number {
  return board.reduce((count, cell, index) =>
    count + (cell === "neutral" && index !== target && distance(index, target) === 1 ? 1 : 0), 0);
}

function pick(actions: readonly Action[], seed: number): Action {
  return actions[seed % actions.length];
}

/** `revealedOpponentActions` contains only completed rounds, oldest to newest. */
export function chooseBotAction(
  state: MatchState,
  player: Player,
  difficulty: BotDifficulty,
  revealedOpponentActions: readonly Action[] = [],
  seed = 0,
): Action {
  const actions = legalActions(state, player);
  if (actions.length === 0) throw new Error("Cannot choose an action for a finished match");
  const turnSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
  const candidates = actions.filter((action): action is Exclude<Action, { type: "pass" }> => action.type !== "pass");
  if (candidates.length === 0) return { type: "pass" };

  if (difficulty === "easy") {
    const preferred = turnSeed % 10 === 8 ? "ambush" : turnSeed % 10 === 9 ? "surge" : "expand";
    const pool = candidates.filter((action) => action.type === preferred);
    const fallback = preferred === "surge" ? candidates.filter((action) => action.type === "ambush") : [];
    return { ...pick(pool.length ? pool : fallback.length ? fallback : candidates, turnSeed) };
  }

  const opponentExpand = new Set(legalTargets(state, opponent(player), "expand"));
  const ownExpand = new Set(legalTargets(state, player, "expand"));
  const recent = revealedOpponentActions.slice(-3);
  const recentExpands = recent.filter((action) => action.type === "expand");
  const lastExpand = recentExpands.at(-1);
  const scored = candidates.map((action) => {
    const target = action.target;
    const openNeighbors = frontier(state.board, target);
    let value: number;
    switch (action.type) {
      case "expand":
        value = 14 + openNeighbors * 2 - (opponentExpand.has(target) ? 4 : 0);
        break;
      case "surge":
        value = 9 + openNeighbors * 2 + (ownExpand.has(target) ? 0 : 3) +
          (state.energy[player] >= 2 ? 1 : 0) - (opponentExpand.has(target) ? 2 : 0);
        break;
      case "override":
        value = 18 + openNeighbors - (state.energy[player] === 3 ? 2 : 0);
        break;
      case "ambush":
        value = 6 + (ownExpand.has(target) ? 4 : 0) +
          (state.energy[player] === 0 ? 3 : 0) - opponentExpand.size / 2;
        if (difficulty === "hard" && recent.length > 0) {
          value += 12 * recentExpands.length / recent.length;
          if (lastExpand && lastExpand.type === "expand" && distance(lastExpand.target, target) === 1) {
            value += 4;
          }
        }
        break;
    }
    return { action, value };
  });
  const best = Math.max(...scored.map(({ value }) => value));
  return { ...pick(scored.filter(({ value }) => value === best).map(({ action }) => action), turnSeed) };
}
