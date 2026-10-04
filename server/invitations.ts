import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RankedShell } from './ranked.js';
import { createRankedShell } from './ranked.js';
import { HttpError } from './http.js';
import { publicOrigin } from './config.js';

const CHALLENGE_LIFETIME_MS = 30 * 60 * 1000;
const REMATCH_LIFETIME_MS = 30 * 1000;

type InvitationKind = 'challenge' | 'rematch';
type InvitationStatus = 'open' | 'accepted' | 'expired' | 'cancelled';

interface InvitationRow {
  id: string;
  token: string;
  kind: InvitationKind;
  creator_uid: string;
  invitee_uid: string | null;
  parent_match_id: string | null;
  status: InvitationStatus;
  match_id: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}

interface ParentMatchRow {
  id: string;
  mode: string;
  player_a_key: string;
  player_b_key: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
}

export interface CreatedRankedInvitation {
  id: string;
  token: string;
  inviteUrl: string;
  kind: InvitationKind;
  expiresAt: number;
}

export interface AcceptedRankedInvitation {
  matchId: string;
  competitiveMultiplier: number;
  creditAssessedAt: number;
  readyDeadline: number | null;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function invitationView(row: InvitationRow): CreatedRankedInvitation {
  const path = row.kind === 'challenge' ? 'challenge' : 'rematch';
  return {
    id: row.id,
    token: row.token,
    inviteUrl: `${publicOrigin}/ranked/${path}/${row.token}`,
    kind: row.kind,
    expiresAt: row.expires_at,
  };
}

function getInvitationByToken(db: Database.Database, value: string): InvitationRow | undefined {
  return db.prepare('SELECT * FROM ranked_invitations WHERE token = ?').get(value) as InvitationRow | undefined;
}

function assertHandle(db: Database.Database, uid: string): void {
  const row = db.prepare('SELECT handle FROM profiles WHERE uid = ?').get(uid) as { handle: string | null } | undefined;
  if (!row) throw new HttpError(401, 'Sign in with Google first');
  if (!row.handle) throw new HttpError(409, 'Choose a handle before Ranked');
}

function assertNoRankedOwnership(db: Database.Database, uids: readonly string[]): void {
  const query = db.prepare('SELECT state FROM ranked_ownership WHERE uid = ?');
  for (const uid of uids) {
    if (query.get(uid)) throw new HttpError(409, 'Leave the Ranked queue or finish your active match first');
  }
}

function currentShell(db: Database.Database, matchId: string): AcceptedRankedInvitation {
  const row = db.prepare(`SELECT id, competitive_multiplier, credit_assessed_at, ready_deadline
    FROM matches WHERE id = ? AND mode = 'ranked'`).get(matchId) as
    { id: string; competitive_multiplier: number | null; credit_assessed_at: number | null; ready_deadline: number | null } | undefined;
  if (!row || row.competitive_multiplier === null || row.credit_assessed_at === null) {
    throw new HttpError(409, 'Ranked invitation match is unavailable');
  }
  return {
    matchId: row.id,
    competitiveMultiplier: row.competitive_multiplier,
    creditAssessedAt: row.credit_assessed_at,
    readyDeadline: row.ready_deadline,
  };
}

/** Create a private, high-entropy Ranked challenge link that expires after 30 minutes. */
export function createRankedChallenge(db: Database.Database, creatorUid: string, now = Date.now()): CreatedRankedInvitation {
  return db.transaction(() => {
    assertHandle(db, creatorUid);
    assertNoRankedOwnership(db, [creatorUid]);
    const existing = pendingRankedChallenge(db, creatorUid, now);
    if (existing) return existing;
    const row: InvitationRow = {
      id: randomUUID(), token: token(), kind: 'challenge', creator_uid: creatorUid, invitee_uid: null,
      parent_match_id: null, status: 'open', match_id: null, created_at: now,
      expires_at: now + CHALLENGE_LIFETIME_MS, accepted_at: null,
    };
    db.prepare(`INSERT INTO ranked_invitations
      (id, token, kind, creator_uid, invitee_uid, parent_match_id, status, match_id, created_at, expires_at, accepted_at)
      VALUES (@id, @token, @kind, @creator_uid, @invitee_uid, @parent_match_id, @status, @match_id, @created_at, @expires_at, @accepted_at)`)
      .run(row);
    return invitationView(row);
  }).immediate();
}

/** Recover the creator's still-open challenge link after a page refresh. */
export function pendingRankedChallenge(db: Database.Database, creatorUid: string, now = Date.now()): CreatedRankedInvitation | null {
  const row = db.prepare(`SELECT * FROM ranked_invitations WHERE kind = 'challenge'
    AND creator_uid = ? AND status = 'open' AND expires_at > ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(creatorUid, now) as InvitationRow | undefined;
  return row ? invitationView(row) : null;
}

function shellResult(shell: RankedShell): AcceptedRankedInvitation {
  return {
    matchId: shell.matchId,
    competitiveMultiplier: shell.competitiveMultiplier,
    creditAssessedAt: shell.creditAssessedAt,
    readyDeadline: shell.readyDeadline,
  };
}

/** Redeem a challenge once; the 15-second ready window begins with its Ranked shell. */
export function acceptRankedChallenge(
  db: Database.Database,
  inviteToken: string,
  inviteeUid: string,
  now = Date.now(),
): AcceptedRankedInvitation {
  return db.transaction(() => {
    const invite = getInvitationByToken(db, inviteToken);
    if (!invite || invite.kind !== 'challenge') throw new HttpError(404, 'Ranked challenge not found');
    if (invite.status === 'accepted' && invite.invitee_uid === inviteeUid && invite.match_id) return currentShell(db, invite.match_id);
    if (invite.status !== 'open' || invite.expires_at <= now) throw new HttpError(410, 'Ranked challenge expired or was already used');
    if (invite.creator_uid === inviteeUid) throw new HttpError(400, 'You cannot accept your own challenge');
    assertHandle(db, inviteeUid);
    assertNoRankedOwnership(db, [invite.creator_uid, inviteeUid]);

    const shell = createRankedShell(db, invite.creator_uid, inviteeUid, now);
    const changed = db.prepare(`UPDATE ranked_invitations SET invitee_uid = ?, status = 'accepted', match_id = ?, accepted_at = ?
      WHERE id = ? AND status = 'open' AND expires_at > ?`)
      .run(inviteeUid, shell.matchId, now, invite.id, now);
    if (changed.changes !== 1) throw new HttpError(409, 'Ranked challenge was already used');
    return shellResult(shell);
  }).immediate();
}

/** Expire unused challenge and rematch tokens; accepted shells have their own ready deadline. */
export function expireRankedInvitations(db: Database.Database, now = Date.now()): number {
  return db.prepare("UPDATE ranked_invitations SET status = 'expired' WHERE status = 'open' AND expires_at <= ?")
    .run(now).changes;
}

function parentMatch(db: Database.Database, matchId: string): ParentMatchRow {
  const match = db.prepare(`SELECT id, mode, player_a_key, player_b_key, status, started_at, ended_at
    FROM matches WHERE id = ?`).get(matchId) as ParentMatchRow | undefined;
  if (!match || match.mode !== 'ranked') throw new HttpError(404, 'Ranked match not found');
  if (match.status !== 'finished' || match.started_at === null || match.ended_at === null) {
    throw new HttpError(409, 'Rematches are available after a completed Ranked match');
  }
  if (!db.prepare('SELECT 1 FROM rating_settlements WHERE match_id = ?').get(matchId)) {
    throw new HttpError(409, 'Ranked match settlement is pending');
  }
  return match;
}

/** Request a one-use rematch invitation for the other player, valid for 30 seconds. */
export function requestRankedRematch(
  db: Database.Database,
  matchId: string,
  creatorUid: string,
  now = Date.now(),
): CreatedRankedInvitation {
  return db.transaction(() => {
    const match = parentMatch(db, matchId);
    const inviteeUid = match.player_a_key === creatorUid ? match.player_b_key
      : match.player_b_key === creatorUid ? match.player_a_key : null;
    if (!inviteeUid) throw new HttpError(404, 'Ranked match not found');
    assertNoRankedOwnership(db, [creatorUid, inviteeUid]);
    db.prepare(`UPDATE ranked_invitations SET status = 'expired'
      WHERE parent_match_id = ? AND kind = 'rematch' AND status = 'open' AND expires_at <= ?`)
      .run(matchId, now);
    const existing = db.prepare(`SELECT * FROM ranked_invitations WHERE parent_match_id = ? AND kind = 'rematch'
      AND status = 'open' AND expires_at > ?`).get(matchId, now) as InvitationRow | undefined;
    if (existing) {
      if (existing.creator_uid === creatorUid || existing.invitee_uid === creatorUid) return invitationView(existing);
      throw new HttpError(409, 'A rematch invitation is already pending');
    }
    const row: InvitationRow = {
      id: randomUUID(), token: token(), kind: 'rematch', creator_uid: creatorUid, invitee_uid: inviteeUid,
      parent_match_id: matchId, status: 'open', match_id: null, created_at: now,
      expires_at: now + REMATCH_LIFETIME_MS, accepted_at: null,
    };
    db.prepare(`INSERT INTO ranked_invitations
      (id, token, kind, creator_uid, invitee_uid, parent_match_id, status, match_id, created_at, expires_at, accepted_at)
      VALUES (@id, @token, @kind, @creator_uid, @invitee_uid, @parent_match_id, @status, @match_id, @created_at, @expires_at, @accepted_at)`)
      .run(row);
    return invitationView(row);
  }).immediate();
}

/** Read an open rematch invitation for either participant in its settled parent match. */
export function pendingRankedRematch(
  db: Database.Database,
  matchId: string,
  uid: string,
  now = Date.now(),
): CreatedRankedInvitation | null {
  const match = parentMatch(db, matchId);
  if (match.player_a_key !== uid && match.player_b_key !== uid) throw new HttpError(404, 'Ranked match not found');
  const row = db.prepare(`SELECT * FROM ranked_invitations WHERE parent_match_id = ? AND kind = 'rematch'
    AND status = 'open' AND expires_at > ?`).get(matchId, now) as InvitationRow | undefined;
  return row ? invitationView(row) : null;
}

/** Accept a pending rematch and atomically create a fresh shell with the prior sides reversed. */
export function acceptRankedRematch(
  db: Database.Database,
  inviteToken: string,
  inviteeUid: string,
  now = Date.now(),
): AcceptedRankedInvitation {
  return db.transaction(() => {
    const invite = getInvitationByToken(db, inviteToken);
    if (!invite || invite.kind !== 'rematch') throw new HttpError(404, 'Ranked rematch not found');
    if (invite.status === 'accepted' && invite.invitee_uid === inviteeUid && invite.match_id) return currentShell(db, invite.match_id);
    if (invite.status !== 'open' || invite.expires_at <= now) throw new HttpError(410, 'Ranked rematch expired or was already used');
    if (invite.invitee_uid !== inviteeUid || !invite.parent_match_id) throw new HttpError(404, 'Ranked rematch not found');
    const prior = parentMatch(db, invite.parent_match_id);
    assertNoRankedOwnership(db, [invite.creator_uid, inviteeUid]);
    const shell = createRankedShell(db, prior.player_a_key, prior.player_b_key, now);
    const swapped = db.prepare(`UPDATE matches SET player_a_key = ?, player_b_key = ?
      WHERE id = ? AND mode = 'ranked' AND status = 'readying' AND started_at IS NULL`)
      .run(prior.player_b_key, prior.player_a_key, shell.matchId);
    if (swapped.changes !== 1) throw new HttpError(409, 'Could not swap rematch sides');
    const changed = db.prepare(`UPDATE ranked_invitations SET status = 'accepted', match_id = ?, accepted_at = ?
      WHERE id = ? AND status = 'open' AND expires_at > ?`)
      .run(shell.matchId, now, invite.id, now);
    if (changed.changes !== 1) throw new HttpError(409, 'Ranked rematch was already used');
    return shellResult(shell);
  }).immediate();
}

export function rankedChallengeLifetimeMs(): number {
  return CHALLENGE_LIFETIME_MS;
}

export function rankedRematchLifetimeMs(): number {
  return REMATCH_LIFETIME_MS;
}
