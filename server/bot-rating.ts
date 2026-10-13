import type Database from 'better-sqlite3';
import type { Session } from './http';
import { HARD_BOT_RATING, hardBotCredit, type BotRatingPreview } from '../src/shared/bot-rating';

export function botRatingPreview(db: Database.Database, session: Session, now = Date.now()): BotRatingPreview {
  const eligible = Boolean(session.uid && db.prepare('SELECT 1 FROM profiles WHERE uid = ? AND handle IS NOT NULL').get(session.uid));
  const prior = eligible ? db.prepare(`SELECT COUNT(*) AS count FROM matches
    WHERE rated_bot_uid = ? AND started_at > ? AND started_at <= ? AND status <> 'voided'`)
    .get(session.uid, now - 24 * 60 * 60_000, now) as { count: number } : null;
  return { eligible, opponentRating: HARD_BOT_RATING, multiplier: prior ? hardBotCredit(prior.count) : 0 };
}
