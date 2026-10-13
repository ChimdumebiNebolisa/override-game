export const HARD_BOT_RATING = 1000;

/** Starts against the Hard bot share one rolling account-wide allowance. */
export function hardBotCredit(priorStarts: number): number {
  return priorStarts < 3 ? 0.5 : priorStarts === 3 ? 0.375 : priorStarts === 4 ? 0.25 : 0;
}

export interface BotRatingPreview {
  eligible: boolean;
  opponentRating: number;
  multiplier: number;
}
