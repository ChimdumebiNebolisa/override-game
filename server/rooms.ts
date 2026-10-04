import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createInitialState } from '../src/shared/rules';
import { HttpError, type Session } from './http';
import { publicOrigin } from './config';
import { initializeHumanPresence } from './matches';
import { invitationTokenHash, protectInvitationSecret, revealInvitationSecret } from './invitation-secrets';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_LIFETIME = 30 * 60_000;

export interface RoomRow {
  id: string;
  creation_key: string | null;
  code: string;
  invite_token: string;
  invite_token_hash: string;
  mode: 'quick' | 'ranked';
  host_key: string;
  guest_key: string | null;
  host_name: string;
  guest_name: string | null;
  status: 'open' | 'full' | 'readying' | 'active' | 'finished' | 'expired';
  match_id: string | null;
  created_at: number;
  expires_at: number;
}

function roomCode(): string {
  const bytes = randomBytes(6);
  return [...bytes].map((value) => CODE_ALPHABET[value & 31]).join('');
}

function roomView(row: RoomRow) {
  return {
    id: row.id,
    code: row.code,
    inviteUrl: `${publicOrigin}/join/${revealInvitationSecret(row.invite_token)}`,
    status: row.status,
    hostDisplayName: row.host_name,
    guestDisplayName: row.guest_name ?? undefined,
    matchId: row.match_id ?? undefined,
    mode: row.mode,
  };
}

export function getRoom(db: Database.Database, id: string): RoomRow | null {
  return (db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined) ?? null;
}

export function roomForSession(db: Database.Database, id: string, session: Session) {
  const row = getRoom(db, id);
  if (!row || (row.host_key !== session.id && row.guest_key !== session.id)) throw new HttpError(404, 'Room not found');
  return roomView(row);
}

export function openRoomForSession(db: Database.Database, session: Session) {
  const row = db.prepare(`SELECT * FROM rooms WHERE mode = 'quick' AND status = 'open'
    AND host_key = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(session.id, Date.now()) as RoomRow | undefined;
  return row ? roomView(row) : null;
}

export function createQuickRoom(db: Database.Database, session: Session, name: string, creationKey?: string) {
  return db.transaction(() => {
    if (creationKey) {
      const existing = db.prepare('SELECT * FROM rooms WHERE host_key = ? AND creation_key = ?')
        .get(session.id, creationKey) as RoomRow | undefined;
      if (existing) {
        if (existing.host_name !== name) throw new HttpError(409, 'Creation key was used for another room');
        return roomView(existing);
      }
    }
    const now = Date.now();
    const count = db.prepare("SELECT count(*) AS count FROM rooms WHERE host_key = ? AND status IN ('open', 'full', 'active') AND expires_at > ?")
      .get(session.id, now) as { count: number };
    if (count.count >= 3) throw new HttpError(429, 'Close an existing room before creating another');
    for (let attempt = 0; attempt < 5; attempt++) {
      const rawInviteToken = randomBytes(24).toString('base64url');
      const row: RoomRow = {
        id: randomUUID(), creation_key: creationKey ?? null, code: roomCode(),
        invite_token: protectInvitationSecret(rawInviteToken), invite_token_hash: invitationTokenHash(rawInviteToken),
        mode: 'quick', host_key: session.id, guest_key: null, host_name: name, guest_name: null,
        status: 'open', match_id: null, created_at: now, expires_at: now + ROOM_LIFETIME,
      };
      try {
        db.prepare(`INSERT INTO rooms
          (id, creation_key, code, invite_token, invite_token_hash, mode, host_key, guest_key, host_name, guest_name, status, match_id, created_at, expires_at)
          VALUES (@id, @creation_key, @code, @invite_token, @invite_token_hash, @mode, @host_key, @guest_key, @host_name, @guest_name, @status, @match_id, @created_at, @expires_at)`)
          .run(row);
        return roomView(row);
      } catch (error) {
        if (String(error).includes('UNIQUE constraint')) continue;
        throw error;
      }
    }
    throw new HttpError(503, 'Could not create a room');
  }).immediate();
}

export function closeQuickRoom(db: Database.Database, id: string, session: Session): void {
  const row = getRoom(db, id);
  if (!row || row.host_key !== session.id) throw new HttpError(404, 'Room not found');
  if (row.status !== 'open') throw new HttpError(409, 'A started room cannot be closed here');
  const closed = db.prepare("UPDATE rooms SET status = 'expired' WHERE id = ? AND status = 'open' AND host_key = ?")
    .run(id, session.id);
  if (closed.changes !== 1) throw new HttpError(409, 'Room is no longer open');
}

function checkJoinRate(db: Database.Database, session: Session, now: number): void {
  const prior = db.prepare('SELECT window_started_at, attempts FROM join_attempts WHERE session_id = ?')
    .get(session.id) as { window_started_at: number; attempts: number } | undefined;
  if (!prior || prior.window_started_at <= now - 5 * 60_000) {
    db.prepare('INSERT INTO join_attempts (session_id, window_started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 1')
      .run(session.id, now);
  } else {
    if (prior.attempts >= 10) throw new HttpError(429, 'Too many join attempts. Try again later');
    db.prepare('UPDATE join_attempts SET attempts = attempts + 1 WHERE session_id = ?').run(session.id);
  }
}

export function joinQuickRoom(db: Database.Database, session: Session, lookup: { code?: string; token?: string }, name: string) {
  const previouslyJoined = (lookup.token
    ? db.prepare('SELECT * FROM rooms WHERE invite_token_hash = ?').get(invitationTokenHash(lookup.token))
    : db.prepare('SELECT * FROM rooms WHERE code = ?').get(lookup.code?.toUpperCase())) as RoomRow | undefined;
  if (previouslyJoined?.mode === 'quick' && previouslyJoined.guest_key === session.id &&
      previouslyJoined.expires_at > Date.now()) return roomView(previouslyJoined);
  // A failed lookup still counts toward the guess limit; keep this write outside
  // the room-claim transaction so an expected 404 cannot roll it back.
  checkJoinRate(db, session, Date.now());
  return db.transaction(() => {
    const now = Date.now();
    const row = (lookup.token
      ? db.prepare('SELECT * FROM rooms WHERE invite_token_hash = ?').get(invitationTokenHash(lookup.token))
      : db.prepare('SELECT * FROM rooms WHERE code = ?').get(lookup.code?.toUpperCase())) as RoomRow | undefined;
    if (!row || row.mode !== 'quick' || row.expires_at <= now) throw new HttpError(404, 'Room not found or expired');
    if (row.host_key === session.id) throw new HttpError(400, 'You already host this room');
    if (row.guest_key === session.id) return roomView(row);
    if (row.guest_key) throw new HttpError(409, 'Room is full');
    const claimed = db.prepare("UPDATE rooms SET guest_key = ?, guest_name = ?, status = 'full' WHERE id = ? AND guest_key IS NULL AND status = 'open' AND expires_at > ?")
      .run(session.id, name, row.id, now);
    if (claimed.changes !== 1) throw new HttpError(409, 'Room is no longer available');

    const hostIsA = randomBytes(1)[0] % 2 === 0;
    const matchId = randomUUID();
    const state = createInitialState();
    db.prepare(`INSERT INTO matches
      (id, room_id, mode, player_a_key, player_b_key, player_a_name, player_b_name, state_json, status, deadline, started_at, revision)
      VALUES (?, ?, 'quick', ?, ?, ?, ?, ?, 'decision', ?, ?, 1)`)
      .run(matchId, row.id,
        hostIsA ? row.host_key : session.id, hostIsA ? session.id : row.host_key,
        hostIsA ? row.host_name : name, hostIsA ? name : row.host_name,
        JSON.stringify(state), now + 5_000, now);
    initializeHumanPresence(db, matchId, now);
    db.prepare("UPDATE rooms SET match_id = ?, status = 'active' WHERE id = ?").run(matchId, row.id);
    const updated = getRoom(db, row.id);
    if (!updated) throw new Error('Room disappeared during join');
    return roomView(updated);
  }).immediate();
}
