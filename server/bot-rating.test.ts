import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db';
import { botRatingPreview } from './bot-rating';
import { acknowledgeBotRound, activeMatchForSession, createBotMatch, dueMatches, getMatch, lockAction, matchForSession, resignMatch, resignRatedBotMatch, resolveMatch } from './matches';
import { createRankedShell, joinRankedQueue, publicRankedSettlement, settlePendingRankedMatches, settleRankedMatch } from './ranked';
import { createRankedChallenge } from './invitations';
import { pruneExpiredGuestData } from './maintenance';
import { createInitialState, type Player } from '../src/shared/rules';
import { profileView } from './progression';
import type { Session } from './http';

let db: ReturnType<typeof openDatabase>;
const startTime = 1_800_000_000_000;
function session(id = randomUUID(), uid: string | null = 'human'): Session {
  return { id, uid, createdAt: startTime, expiresAt: startTime + 60 * 24 * 60 * 60_000 };
}
function start(actor = session(), parent?: string, key = randomUUID()) {
  return createBotMatch(db, actor, 'Player', 'quick', 'hard', parent, key);
}
function finish(id: string, winner: Player | null, resultType = 'standard') {
  db.prepare(`UPDATE matches SET state_json = ?, status = 'finished', ended_at = ?, deadline = NULL, result_type = ? WHERE id = ?`)
    .run(JSON.stringify({ ...createInitialState(), status: 'finished', winner }), Date.now(), resultType, id);
}
function humanProfile() { return db.prepare('SELECT * FROM profiles WHERE uid = ?').get('human') as Record<string, number>; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(startTime);
  db = openDatabase(':memory:');
  for (const uid of ['human', 'other']) db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)')
    .run(uid, uid, uid, startTime);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Hard bot eligibility and ownership', () => {
  it.each([
    ['quick', 'hard', true, null, true], ['quick', 'easy', true, 'human', true],
    ['quick', 'normal', true, 'human', true], ['practice', 'hard', false, 'human', true],
    ['practice', 'hard', true, 'human', true], ['quick', 'hard', false, 'human', true],
    ['quick', 'hard', true, 'human', false],
  ] as const)('keeps %s/%s timed=%s uid=%s handle=%s unranked', (mode, difficulty, timed, uid, handle) => {
    if (!handle) db.prepare('UPDATE profiles SET handle = NULL WHERE uid = ?').run('human');
    const actor = session(undefined, uid);
    const id = createBotMatch(db, actor, 'Player', mode, difficulty, undefined, undefined, undefined, undefined, timed);
    expect(getMatch(db, id)).toMatchObject({ rated_bot_uid: null, rated_bot_rating: null, competitive_multiplier: null });
    expect(matchForSession(db, id, actor).ratedBot).toBeUndefined();
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
  });

  it('freezes eligibility and handles retries without consuming another start', () => {
    const actor = session(); const key = randomUUID(); const id = start(actor, undefined, key);
    expect(getMatch(db, id)).toMatchObject({ rated_bot_uid: 'human', rated_bot_rating: 1000, competitive_multiplier: 0.5 });
    expect(start(actor, undefined, key)).toBe(id);
    expect(botRatingPreview(db, session())).toEqual({ eligible: true, opponentRating: 1000, multiplier: 0.5 });
    expect(activeMatchForSession(db, actor)?.id).toBe(id);
    expect(() => matchForSession(db, id, session())).toThrow('Match not found');
    expect(() => createBotMatch(db, actor, 'Player', 'quick', 'normal', undefined, key)).toThrow('Creation key');
    const guest = session(undefined, null); const guestId = start(guest);
    expect(matchForSession(db, guestId, { ...guest, uid: 'other' }).ratedBot).toBeUndefined();
    expect(getMatch(db, id)?.rated_bot_uid).toBe('human');
  });

  it('prevents overlapping rated bots, human shells, and challenges across sessions', () => {
    const actor = session(); const id = start(actor);
    expect(() => start(session())).toThrow('Finish your rated match');
    expect(joinRankedQueue(db, 'human').matchId).toBe(id);
    expect(db.prepare('SELECT * FROM ranked_queue').all()).toEqual([]);
    expect(() => createRankedShell(db, 'human', 'other')).toThrow('active Ranked match');
    expect(() => createRankedChallenge(db, 'human')).toThrow();
    resignMatch(db, id, actor); settleRankedMatch(db, id);
    expect(joinRankedQueue(db, 'human').state).toBe('searching');
    expect(() => start(session())).toThrow('leave Ranked matchmaking');
  });

  it('blocks bot creation while a human shell is active', () => {
    createRankedShell(db, 'human', 'other');
    expect(() => start()).toThrow('Finish your rated match');
  });

  it.each([0.5, 0] as const)('recovers an account-owned review from another session with credit %s exactly once', (multiplier) => {
    const original = session(); const replacement = session(); const id = start(original);
    const me = matchForSession(db, id, original).player!;
    db.prepare("UPDATE matches SET status = 'review', deadline = NULL, competitive_multiplier = ? WHERE id = ?").run(multiplier, id);
    expect(joinRankedQueue(db, 'human')).toMatchObject({ matchId: id, ratedBot: { opponentRating: 1000 } });
    expect(() => matchForSession(db, id, replacement)).toThrow('Match not found');
    expect(() => lockAction(db, id, replacement, { type: 'pass' }, 1, 1)).toThrow('Match not found');
    expect(() => resignRatedBotMatch(db, id, session(undefined, 'other'))).toThrow('Rated bot match not found');
    expect(() => resignRatedBotMatch(db, id, session(undefined, null))).toThrow('Rated bot match not found');
    expect(resignRatedBotMatch(db, id, replacement)).toBe(me);
    const settled = settleRankedMatch(db, id);
    expect(resignRatedBotMatch(db, id, replacement)).toBe(me);
    expect(settleRankedMatch(db, id)).toEqual(JSON.parse(JSON.stringify(settled)));
    expect(humanProfile()).toMatchObject({ rating: multiplier ? 984 : 1000, placement_progress: multiplier ? 1 : 0, rated_match_count: multiplier ? 1 : 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(id)).toEqual({ count: 1 });
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
    expect(start(replacement)).not.toBe(id);
  });

  it('retries account recovery after a settlement failure without changing the original outcome', () => {
    const id = start(); const replacement = session();
    resignRatedBotMatch(db, id, replacement);
    db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'temporary failure'); END");
    expect(() => settleRankedMatch(db, id)).toThrow('temporary failure');
    expect(getMatch(db, id)?.result_type).toBe('resignation');
    expect(() => start(replacement)).toThrow('Finish your rated match');
    db.exec('DROP TRIGGER fail_recovery');
    resignRatedBotMatch(db, id, replacement);
    settleRankedMatch(db, id);
    expect(humanProfile()).toMatchObject({ rating: 984, placement_progress: 1 });
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
  });
});

describe('Hard bot settlement and allowances', () => {
  it('settles wins for both sides, completes placements, and saves the result once', () => {
    const actor = session(); let id = start(actor); const sides = new Set<Player>();
    for (let game = 0; game < 2; game++) {
      const me = matchForSession(db, id, actor).player!; sides.add(me); finish(id, me);
      const settled = settleRankedMatch(db, id);
      expect(settleRankedMatch(db, id)).toEqual(settled);
      expect(db.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(id)).toEqual({ count: 1 });
      const visible = publicRankedSettlement(settled, me);
      expect(visible.player.placementProgress).toBe(game + 1);
      if (game === 0) { expect(visible.player.ratingAfter).toBeUndefined(); expect(humanProfile().rating).toBe(1016); id = start(actor, id); }
      else expect(visible.player.ratingAfter).toBe(1031);
    }
    expect(sides.size).toBe(2);
    expect(humanProfile()).toMatchObject({ placement_progress: 2, rated_match_count: 2, wins: 0, losses: 0, draws: 0, streak: 0, peak_rating: 1031 });
    expect(profileView(db, 'human')).toHaveProperty('rank', expect.any(Number));
    expect(db.prepare('SELECT COUNT(*) AS count FROM profiles').get()).toEqual({ count: 2 });
  });

  it.each(['resignation', 'forfeit', 'draw'] as const)('handles %s using the existing Elo calculation', (kind) => {
    const actor = session(); const id = start(actor); const me = matchForSession(db, id, actor).player!;
    if (kind === 'resignation') resignMatch(db, id, actor);
    else finish(id, kind === 'draw' ? null : me === 'A' ? 'B' : 'A', kind);
    settleRankedMatch(db, id);
    expect(humanProfile()).toMatchObject({ rating: kind === 'draw' ? 1000 : 984, placement_progress: 1, rated_match_count: 1, wins: 0, losses: 0, draws: 0 });
  });

  it('settles a real final-round lock without changing the bot profile', () => {
    const actor = session(); const id = start(actor); const me = matchForSession(db, id, actor).player!;
    const state = { ...createInitialState(), round: 12, energy: { A: 0, B: 0 }, board: Array(25).fill(me) };
    db.prepare('UPDATE matches SET state_json = ? WHERE id = ?').run(JSON.stringify(state), id);
    lockAction(db, id, actor, { type: 'pass' }, 12, getMatch(db, id)!.revision);
    expect(getMatch(db, id)?.status).toBe('finished');
    expect(settlePendingRankedMatches(db)).toEqual([id]);
    expect(humanProfile().rating).toBe(1016);
  });

  it('keeps no-contests unchanged and applies the rating floor to a loss', () => {
    const actor = session(); const id = start(actor); finish(id, null, 'no-contest');
    const before = humanProfile(); settleRankedMatch(db, id); expect(humanProfile()).toEqual(before);
    db.prepare('UPDATE profiles SET rating = 0 WHERE uid = ?').run('human');
    const loss = start(actor, id); resignMatch(db, loss, actor); settleRankedMatch(db, loss);
    expect(humanProfile()).toMatchObject({ rating: 0, placement_progress: 1, rated_match_count: 1 });
  });

  it('applies account-wide starts, excludes voids, and freezes credit until settlement', () => {
    const credits = [0.5, 0.5, 0.5, 0.375, 0.25, 0, 0];
    for (const expected of credits) {
      const actor = session(); expect(botRatingPreview(db, actor).multiplier).toBe(expected);
      const id = start(actor); const before = humanProfile();
      expect(getMatch(db, id)?.competitive_multiplier).toBe(expected);
      vi.setSystemTime(Date.now() + 1000);
      finish(id, matchForSession(db, id, actor).player!); settleRankedMatch(db, id);
      if (expected === 0) expect(humanProfile()).toEqual(before);
    }
    const id = db.prepare('SELECT id FROM matches ORDER BY started_at LIMIT 1').get() as { id: string };
    db.prepare("UPDATE matches SET status = 'voided' WHERE id = ?").run(id.id);
    db.prepare("UPDATE matches SET status = 'voided' WHERE competitive_multiplier = 0").run();
    expect(botRatingPreview(db, session()).multiplier).toBe(0.25);
  });

  it('uses a strict rolling 24-hour window and excludes future timestamps', () => {
    const actor = session(); const id = start(actor); finish(id, null); settleRankedMatch(db, id);
    for (let game = 0; game < 2; game++) { const next = start(session()); finish(next, null); settleRankedMatch(db, next); }
    expect(botRatingPreview(db, actor).multiplier).toBe(0.375);
    vi.setSystemTime(startTime + 24 * 60 * 60_000 - 1);
    expect(botRatingPreview(db, actor).multiplier).toBe(0.375);
    vi.setSystemTime(startTime + 24 * 60 * 60_000);
    expect(botRatingPreview(db, actor).multiplier).toBe(0.5);
    db.prepare('UPDATE matches SET started_at = ?').run(Date.now() + 1);
    expect(botRatingPreview(db, actor).multiplier).toBe(0.5);
  });

  it('settles missed-turn forfeits and releases ownership', () => {
    const actor = session(); const id = start(actor);
    for (let round = 1; round <= 3; round++) {
      const row = getMatch(db, id)!; vi.setSystemTime(row.deadline!); resolveMatch(db, id);
      if (round < 3) acknowledgeBotRound(db, id, actor, round, randomUUID(), getMatch(db, id)!.revision);
    }
    expect(getMatch(db, id)?.result_type).toBe('forfeit');
    settleRankedMatch(db, id);
    expect(humanProfile().rating).toBe(984);
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
  });

  it('voids corrupt games without credit and releases their ownership', () => {
    const id = start(); db.prepare("UPDATE matches SET state_json = '{}' WHERE id = ?").run(id);
    vi.setSystemTime(getMatch(db, id)!.deadline!); dueMatches(db);
    expect(getMatch(db, id)?.status).toBe('voided');
    expect(settlePendingRankedMatches(db)).toEqual([]);
    expect(humanProfile().rating).toBe(1000);
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
    expect(botRatingPreview(db, session()).multiplier).toBe(0.5);
  });

  it('rolls back a failed profile write and recovers through the retry worker', () => {
    const id = start(); finish(id, 'A');
    db.exec("CREATE TRIGGER fail_bot_write BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'temporary write failure'); END");
    expect(settlePendingRankedMatches(db)).toEqual([]);
    expect(humanProfile().rating).toBe(1000);
    expect(db.prepare('SELECT * FROM rating_settlements').all()).toEqual([]);
    db.exec('DROP TRIGGER fail_bot_write');
    expect(settlePendingRankedMatches(db)).toEqual([id]);
    expect(settlePendingRankedMatches(db)).toEqual([]);
    expect(humanProfile().rated_match_count).toBe(1);
  });

  it('retains rated audits and voids expired-session games without leaking ownership', () => {
    const actor = session(); const id = start(actor); finish(id, null); settleRankedMatch(db, id);
    const abandoned = start(session());
    vi.setSystemTime(startTime + 31 * 24 * 60 * 60_000);
    pruneExpiredGuestData(db);
    expect(getMatch(db, id)).not.toBeNull();
    expect(getMatch(db, abandoned)?.status).toBe('voided');
    expect(db.prepare('SELECT * FROM ranked_ownership').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
