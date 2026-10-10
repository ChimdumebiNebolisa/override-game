import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createInitialState } from '../src/shared/rules.js';
import { HttpError } from './http.js';
import { publicOrigin } from './config.js';
import { initializeHumanPresence } from './matches.js';
import { invitationTokenHash, protectInvitationSecret, revealInvitationSecret } from './invitation-secrets.js';

const OFFER_LIFETIME_MS = 30_000;
const DECISION_DURATION_MS = 5_000;

interface ParentMatch {
  id: string;
  room_id: string;
  mode: string;
  player_a_key: string;
  player_b_key: string;
  player_a_name: string;
  player_b_name: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
}

interface Room {
  id: string;
  mode: string;
  host_key: string;
  guest_key: string | null;
  status: string;
  match_id: string | null;
}

interface OfferRow {
  id: string;
  token: string;
  token_hash: string;
  parent_match_id: string;
  room_id: string;
  creator_session_id: string;
  invitee_session_id: string;
  status: 'open' | 'accepted' | 'expired' | 'cancelled';
  new_match_id: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}

export interface QuickRematchOffer {
  id: string;
  parentMatchId: string;
  token: string;
  inviteUrl: string;
  expiresAt: number;
  status: 'open' | 'accepted';
  newMatchId: string | null;
}

export interface AcceptedQuickRematch {
  matchId: string;
  roomId: string;
}

function getParentMatch(db: Database.Database, matchId: string): ParentMatch {
  const match = db.prepare(`SELECT id, room_id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      status, started_at, ended_at FROM matches WHERE id = ?`).get(matchId) as ParentMatch | undefined;
  if (!match || match.mode !== 'quick' || !match.room_id || match.status !== 'finished' ||
      match.started_at === null || match.ended_at === null) {
    throw new HttpError(409, 'Rematches are available only after a completed Quick friend match');
  }
  return match;
}

function getRoom(db: Database.Database, roomId: string): Room {
  const room = db.prepare('SELECT id, mode, host_key, guest_key, status, match_id FROM rooms WHERE id = ?')
    .get(roomId) as Room | undefined;
  if (!room || room.mode !== 'quick') throw new HttpError(409, 'Quick friend room is unavailable');
  return room;
}

function assertRoomOwnsCompletedMatch(db: Database.Database, match: ParentMatch): Room {
  const room = getRoom(db, match.room_id);
  if (room.match_id !== match.id || room.status !== 'finished') {
    throw new HttpError(409, 'This Quick match is no longer the room’s completed match');
  }
  const players = new Set([match.player_a_key, match.player_b_key]);
  if (!room.guest_key || !players.has(room.host_key) || !players.has(room.guest_key) || players.size !== 2) {
    throw new HttpError(409, 'Quick room players do not match the completed game');
  }
  return room;
}

function assertSession(db: Database.Database, sessionId: string, now: number): void {
  const active = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, now);
  if (!active) throw new HttpError(401, 'Session expired');
}

function view(row: OfferRow): QuickRematchOffer {
  return {
    id: row.id,
    parentMatchId: row.parent_match_id,
    token: revealInvitationSecret(row.token),
    inviteUrl: `${publicOrigin}/quick/rematch/${revealInvitationSecret(row.token)}`,
    expiresAt: row.expires_at,
    status: row.status === 'accepted' ? 'accepted' : 'open',
    newMatchId: row.new_match_id,
  };
}

function offerForToken(db: Database.Database, token: string): OfferRow | undefined {
  return db.prepare('SELECT * FROM quick_rematch_invitations WHERE token_hash = ?').get(invitationTokenHash(token)) as OfferRow | undefined;
}

function acceptedMatch(offer: OfferRow): AcceptedQuickRematch {
  if (!offer.new_match_id) throw new HttpError(409, 'Rematch result is unavailable');
  return { matchId: offer.new_match_id, roomId: offer.room_id };
}

/** Create or resume a 30-second offer for the other participant in a completed Quick friend match. */
export function requestQuickRematch(db: Database.Database, matchId: string, sessionId: string, now = Date.now(), admitNewWork?: () => void): QuickRematchOffer {
  return db.transaction(() => {
    assertSession(db, sessionId, now);
    const match = getParentMatch(db, matchId);
    const room = assertRoomOwnsCompletedMatch(db, match);
    const inviteeSessionId = match.player_a_key === sessionId ? match.player_b_key
      : match.player_b_key === sessionId ? match.player_a_key : null;
    if (!inviteeSessionId) throw new HttpError(404, 'Match not found');
    assertSession(db, inviteeSessionId, now);

    db.prepare(`UPDATE quick_rematch_invitations SET status = 'expired'
      WHERE parent_match_id = ? AND status = 'open' AND expires_at <= ?`).run(matchId, now);
    const pending = db.prepare(`SELECT * FROM quick_rematch_invitations
      WHERE parent_match_id = ? AND status = 'open' AND expires_at > ?`).get(matchId, now) as OfferRow | undefined;
    if (pending) return view(pending);
    admitNewWork?.();

    const rawToken = randomBytes(32).toString('base64url');
    const row: OfferRow = {
      id: randomUUID(), token: protectInvitationSecret(rawToken), token_hash: invitationTokenHash(rawToken), parent_match_id: match.id,
      room_id: room.id, creator_session_id: sessionId, invitee_session_id: inviteeSessionId,
      status: 'open', new_match_id: null, created_at: now, expires_at: now + OFFER_LIFETIME_MS,
      accepted_at: null,
    };
    db.prepare(`INSERT INTO quick_rematch_invitations
      (id, token, token_hash, parent_match_id, room_id, creator_session_id, invitee_session_id, status, new_match_id,
       created_at, expires_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.token, row.token_hash, row.parent_match_id,
        row.room_id, row.creator_session_id, row.invitee_session_id, row.status, row.new_match_id,
        row.created_at, row.expires_at, row.accepted_at);
    return view(row);
  }).immediate();
}

/** Read a live offer after verifying that the caller was in the completed Quick match. */
export function pendingQuickRematch(
  db: Database.Database,
  matchId: string,
  sessionId: string,
  now = Date.now(),
): QuickRematchOffer | null {
  const match = getParentMatch(db, matchId);
  const room = getRoom(db, match.room_id);
  const players = new Set([match.player_a_key, match.player_b_key]);
  if (!room.guest_key || !players.has(room.host_key) || !players.has(room.guest_key) || players.size !== 2) {
    throw new HttpError(409, 'Quick room players do not match the completed game');
  }
  if (match.player_a_key !== sessionId && match.player_b_key !== sessionId) throw new HttpError(404, 'Match not found');
  const row = db.prepare(`SELECT * FROM quick_rematch_invitations WHERE parent_match_id = ?
    AND ((status = 'open' AND expires_at > ?) OR status = 'accepted')`)
    .get(matchId, now) as OfferRow | undefined;
  if (!row) return null;
  if (row.status === 'open' && (room.match_id !== match.id || room.status !== 'finished')) return null;
  if (row.status === 'accepted' && (room.match_id !== row.new_match_id || !row.new_match_id)) return null;
  return row ? view(row) : null;
}

/** Expire open offers; acceptance also checks the timestamp directly at its transaction boundary. */
export function expireQuickRematches(db: Database.Database, now = Date.now()): number {
  return db.prepare("UPDATE quick_rematch_invitations SET status = 'expired' WHERE status = 'open' AND expires_at <= ?")
    .run(now).changes;
}

/** Accept for the invited session and atomically create a fresh, side-swapped authoritative match. */
export function acceptQuickRematch(
  db: Database.Database,
  token: string,
  sessionId: string,
  now = Date.now(),
  admitNewWork?: () => void,
): AcceptedQuickRematch {
  return db.transaction(() => {
    const offer = offerForToken(db, token);
    if (!offer) throw new HttpError(404, 'Rematch invitation not found');
    if (offer.status === 'accepted' && offer.invitee_session_id === sessionId) return acceptedMatch(offer);
    if (offer.status !== 'open' || offer.expires_at <= now) throw new HttpError(410, 'Rematch invitation expired or was used');
    if (offer.invitee_session_id !== sessionId) throw new HttpError(404, 'Rematch invitation not found');
    assertSession(db, sessionId, now);

    const parent = getParentMatch(db, offer.parent_match_id);
    const room = assertRoomOwnsCompletedMatch(db, parent);
    if (room.id !== offer.room_id) throw new HttpError(409, 'Rematch room changed');
    admitNewWork?.();

    const matchId = randomUUID();
    db.prepare(`INSERT INTO matches (id, room_id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
        state_json, decision_duration_ms, status, deadline, started_at, revision)
      VALUES (?, ?, 'quick', ?, ?, ?, ?, ?, ?, 'decision', ?, ?, 1)`)
      .run(matchId, room.id, parent.player_b_key, parent.player_a_key, parent.player_b_name, parent.player_a_name,
        JSON.stringify(createInitialState()), DECISION_DURATION_MS, now + DECISION_DURATION_MS, now);
    initializeHumanPresence(db, matchId, now);

    const roomChanged = db.prepare(`UPDATE rooms SET match_id = ?, status = 'active'
      WHERE id = ? AND mode = 'quick' AND match_id = ? AND status = 'finished'`)
      .run(matchId, room.id, parent.id);
    if (roomChanged.changes !== 1) throw new HttpError(409, 'Quick rematch was already started');
    const offerChanged = db.prepare(`UPDATE quick_rematch_invitations SET status = 'accepted', new_match_id = ?, accepted_at = ?
      WHERE id = ? AND status = 'open' AND expires_at > ?`)
      .run(matchId, now, offer.id, now);
    if (offerChanged.changes !== 1) throw new HttpError(409, 'Rematch invitation was already used');
    return { matchId, roomId: room.id };
  }).immediate();
}

export function quickRematchOfferLifetimeMs(): number {
  return OFFER_LIFETIME_MS;
}
