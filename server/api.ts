import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { firebaseWebConfig as configuredFirebaseWebConfig, publicOrigin as configuredPublicOrigin } from './config.js';
import { attachFirebaseIdentity, claimHandle, getPublicProfile, renameHandle } from './auth.js';
import { HttpError, assertMutationOrigin, displayName, existingSession, json, parseCreationKey, readJson, requireSession } from './http.js';
import { activeMatchForSession, createBotMatch, dueMatches, getMatch, lockAction, markConnected, markDisconnected, matchForSession, parseAction, resignMatch } from './matches.js';
import { closeQuickRoom, createQuickRoom, getRoom, joinQuickRoom, openRoomForSession, roomForSession } from './rooms.js';
import { acknowledgeRankedReady, expireRankedLeases, getRankedSettlement, joinRankedQueue, leaveRankedQueue, markRankedReadyPresence, publicRankedSettlement, rankedQueueStatus, settlePendingRankedMatches, settleRankedMatch } from './ranked.js';
import { leaderboard, profileView } from './progression.js';
import { acceptRankedChallenge, acceptRankedChallengeByCode, acceptRankedRematch, createRankedChallenge, expireRankedInvitations, pendingRankedChallenge, pendingRankedRematch, requestRankedRematch } from './invitations.js';
import { acceptQuickRematch, expireQuickRematches, pendingQuickRematch, requestQuickRematch } from './quick-rematch.js';
import { recordClientTelemetry, recordTelemetryEvent } from './metrics.js';
import { pruneExpiredGuestData } from './maintenance.js';

export const workerServices = {
  existingSession,
  dueMatches,
  getMatch,
  markConnected,
  markDisconnected,
  matchForSession,
  getRoom,
  roomForSession,
  expireRankedLeases,
  markRankedReadyPresence,
  settlePendingRankedMatches,
  settleRankedMatch,
  expireRankedInvitations,
  expireQuickRematches,
  pruneExpiredGuestData,
};
export interface ApiContext {
  db: Database.Database;
  publicOrigin?: string;
  firebaseWebConfig?: unknown;
  allowNewGame?: () => boolean;
  logMatchEvent(event: string, matchId: string): void;
  notifyRoom(roomId: string): void;
  notifyMatch(matchId: string): void;
  connectLiveParticipants(matchId: string): void;
}

export function createApiHandler(context: ApiContext) {
  const { db, logMatchEvent, notifyRoom, notifyMatch, connectLiveParticipants } = context;
  const publicOrigin = context.publicOrigin ?? configuredPublicOrigin;
  const firebaseWebConfig = context.firebaseWebConfig ?? configuredFirebaseWebConfig;
  const requireNewGameAdmission = () => {
    if (context.allowNewGame && !context.allowNewGame()) {
      throw new HttpError(503, 'New games are paused to preserve capacity for matches already in progress');
    }
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') assertMutationOrigin(req);

    if (path === '/api/health' && method === 'GET') {
      try {
        const cutoff = Date.now() - 5_000;
        const stalled = db.prepare(`SELECT
          EXISTS(SELECT 1 FROM matches WHERE status = 'decision' AND deadline < ?) OR
          EXISTS(SELECT 1 FROM matches WHERE status = 'transition' AND transition_at < ?) OR
          EXISTS(SELECT 1 FROM matches WHERE status = 'grace' AND grace_until < ?) OR
          EXISTS(SELECT 1 FROM matches WHERE status = 'readying' AND ready_deadline < ?) OR
          EXISTS(SELECT 1 FROM ranked_ownership WHERE state = 'searching' AND lease_expires_at < ?) OR
          EXISTS(SELECT 1 FROM matches m LEFT JOIN rating_settlements s ON s.match_id = m.id
            WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL
              AND m.ended_at < ? AND s.match_id IS NULL) AS stalled`)
          .get(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff) as { stalled: number };
        return json(res, stalled.stalled ? 503 : 200, { ok: !stalled.stalled });
      } catch {
        return json(res, 503, { ok: false });
      }
    }
    if (path === '/api/session' && method === 'GET') {
      const session = requireSession(req, res, db);
      return json(res, 200, { signedIn: Boolean(session.uid), profile: session.uid ? profileView(db, session.uid) : null });
    }
    if (path === '/api/config' && method === 'GET') return json(res, 200, { firebaseConfig: firebaseWebConfig });
    if (path === '/api/telemetry' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      recordClientTelemetry(db, session.id, body.name, body.mode);
      return json(res, 200, { recorded: true });
    }
    if (path === '/api/resume' && method === 'GET') {
      const session = requireSession(req, res, db);
      const match = activeMatchForSession(db, session);
      return json(res, 200, {
        match,
        room: match ? null : openRoomForSession(db, session),
        rankedQueue: session.uid && !match ? rankedQueueStatus(db, session.uid) : null,
        rankedChallenge: session.uid && !match ? pendingRankedChallenge(db, session.uid) : null,
      });
    }

    if (path === '/api/rooms' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      return json(res, 201, { room: createQuickRoom(db, session, displayName(body.displayName), parseCreationKey(body.creationKey), requireNewGameAdmission) });
    }
    if (path === '/api/rooms/join' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim() : undefined;
      const token = typeof body.token === 'string' ? body.token.trim() : undefined;
      if (!code && !token) throw new HttpError(400, 'Enter a room code or use an invite link');
      const room = joinQuickRoom(db, session, { code, token }, displayName(body.displayName), requireNewGameAdmission);
      if (room.matchId) {
        connectLiveParticipants(room.matchId);
        logMatchEvent('match_started', room.matchId);
      }
      notifyRoom(room.id);
      return json(res, 200, { room });
    }
    const roomMatch = path.match(/^\/api\/rooms\/([a-f0-9-]{36})$/);
    if (roomMatch && method === 'GET') {
      const session = requireSession(req, res, db);
      const room = roomForSession(db, roomMatch[1], session);
      return json(res, 200, { room, match: room.matchId ? matchForSession(db, room.matchId, session) : null });
    }
    if (roomMatch && method === 'DELETE') {
      const session = requireSession(req, res, db);
      closeQuickRoom(db, roomMatch[1], session);
      notifyRoom(roomMatch[1]);
      return json(res, 200, { closed: true });
    }
    const readyMatch = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/ready$/);
    if (readyMatch && method === 'POST') {
      const session = requireSession(req, res, db);
      const room = roomForSession(db, readyMatch[1], session);
      return json(res, 200, { room, match: room.matchId ? matchForSession(db, room.matchId, session) : null });
    }
    if (path === '/api/bot-matches' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      const mode = body.mode === 'practice' ? 'practice' : 'quick';
      const difficulty = body.difficulty === 'normal' || body.difficulty === 'hard' ? body.difficulty : 'easy';
      const parentMatchId = typeof body.parentMatchId === 'string' ? body.parentMatchId : undefined;
      const restartMatchId = typeof body.restartMatchId === 'string' ? body.restartMatchId : undefined;
      const id = createBotMatch(db, session, displayName(body.displayName ?? 'Player'), mode, difficulty, parentMatchId, parseCreationKey(body.creationKey), restartMatchId, requireNewGameAdmission);
      logMatchEvent('match_started', id);
      return json(res, 201, { match: matchForSession(db, id, session) });
    }
    if (path === '/api/ranked/queue') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      if (method === 'GET') return json(res, 200, { queue: rankedQueueStatus(db, session.uid) });
      if (method === 'POST') {
        const queue = joinRankedQueue(db, session.uid, undefined, requireNewGameAdmission);
        recordTelemetryEvent(db, session.id, 'matchmaking_started', 'ranked-queue');
        return json(res, 200, { queue });
      }
      if (method === 'DELETE') return json(res, 200, { left: leaveRankedQueue(db, session.uid) });
    }
    if (path === '/api/ranked/challenges' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      return json(res, 201, { invitation: createRankedChallenge(db, session.uid, undefined, requireNewGameAdmission) });
    }
    if (path === '/api/ranked/challenges/current' && method === 'GET') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      return json(res, 200, { invitation: pendingRankedChallenge(db, session.uid) });
    }
    if (path === '/api/ranked/challenges/accept' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const body = await readJson(req);
      if (typeof body.token !== 'string') throw new HttpError(400, 'Challenge token required');
      return json(res, 200, { shell: acceptRankedChallenge(db, body.token, session.uid, undefined, requireNewGameAdmission) });
    }
    if (path === '/api/ranked/challenges/accept-code' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const body = await readJson(req);
      if (typeof body.code !== 'string') throw new HttpError(400, 'Challenge code required');
      return json(res, 200, { shell: acceptRankedChallengeByCode(db, body.code, session.uid, undefined, requireNewGameAdmission) });
    }
    if (path === '/api/ranked/rematches/accept' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const body = await readJson(req);
      if (typeof body.token !== 'string') throw new HttpError(400, 'Rematch token required');
      return json(res, 200, { shell: acceptRankedRematch(db, body.token, session.uid, undefined, requireNewGameAdmission) });
    }
    const rankedRematch = path.match(/^\/api\/ranked\/matches\/([a-f0-9-]{36})\/rematch$/);
    if (rankedRematch && (method === 'POST' || method === 'GET')) {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      if (method === 'GET') {
        const invitation = pendingRankedRematch(db, rankedRematch[1], session.uid);
        const owner = invitation ? db.prepare('SELECT creator_uid FROM ranked_invitations WHERE id = ?')
          .get(invitation.id) as { creator_uid: string } | undefined : null;
        return json(res, 200, { invitation, requestedByYou: owner?.creator_uid === session.uid });
      }
      const invitation = requestRankedRematch(db, rankedRematch[1], session.uid, undefined, requireNewGameAdmission);
      notifyMatch(rankedRematch[1]);
      return json(res, 201, { invitation });
    }
    const rankedReady = path.match(/^\/api\/ranked\/matches\/([a-f0-9-]{36})\/ready$/);
    if (rankedReady && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const queue = acknowledgeRankedReady(db, rankedReady[1], session.uid);
      if (queue.state === 'active') {
        connectLiveParticipants(rankedReady[1]);
        logMatchEvent('match_started', rankedReady[1]);
      }
      notifyMatch(rankedReady[1]);
      return json(res, 200, { queue });
    }
    if (path === '/api/leaderboard' && method === 'GET') {
      const session = existingSession(req, db);
      return json(res, 200, leaderboard(db, session?.uid ?? null));
    }
    const actionMatch = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/actions$/);
    if (actionMatch && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      lockAction(db, actionMatch[1], session, parseAction(body.action), body.round as number, body.revision as number);
      const match = matchForSession(db, actionMatch[1], session);
      if (match.roomId && match.status !== 'decision') notifyRoom(match.roomId);
      if (match.status !== 'decision') notifyMatch(actionMatch[1]);
      return json(res, 200, { match });
    }
    const resign = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/resign$/);
    if (resign && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, 'Confirm resignation to end the match');
      resignMatch(db, resign[1], session);
      const match = getMatch(db, resign[1]);
      if (match?.mode === 'ranked') {
        settleRankedMatch(db, resign[1]);
        logMatchEvent('ranked_settled', resign[1]);
      }
      logMatchEvent('match_finished', resign[1]);
      if (match?.room_id) notifyRoom(match.room_id);
      notifyMatch(resign[1]);
      return json(res, 200, { match: matchForSession(db, resign[1], session) });
    }
    const settlementMatch = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/settlement$/);
    if (settlementMatch && method === 'GET') {
      const session = requireSession(req, res, db);
      const match = matchForSession(db, settlementMatch[1], session);
      if (match.mode !== 'ranked' || !match.player) throw new HttpError(404, 'Settlement not found');
      const settlement = getRankedSettlement(db, settlementMatch[1]);
      if (!settlement) return json(res, 200, { settlement: null });
      return json(res, 200, { settlement: publicRankedSettlement(settlement, match.player) });
    }
    const quickRematch = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/rematch$/);
    if (quickRematch && (method === 'GET' || method === 'POST')) {
      const session = requireSession(req, res, db);
      if (method === 'POST') {
        const invitation = requestQuickRematch(db, quickRematch[1], session.id, undefined, requireNewGameAdmission);
        notifyMatch(quickRematch[1]);
        const parent = getMatch(db, quickRematch[1]);
        if (parent?.room_id) notifyRoom(parent.room_id);
        return json(res, 201, { invitation });
      }
      const invitation = pendingQuickRematch(db, quickRematch[1], session.id);
      const match = invitation?.newMatchId ? matchForSession(db, invitation.newMatchId, session) : null;
      const owner = invitation ? db.prepare('SELECT creator_session_id FROM quick_rematch_invitations WHERE id = ?')
        .get(invitation.id) as { creator_session_id: string } | undefined : null;
      return json(res, 200, { invitation, match, requestedByYou: owner?.creator_session_id === session.id });
    }
    if (path === '/api/quick/rematches/accept' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      if (typeof body.token !== 'string') throw new HttpError(400, 'Rematch token required');
      const accepted = acceptQuickRematch(db, body.token, session.id, undefined, requireNewGameAdmission);
      connectLiveParticipants(accepted.matchId);
      notifyRoom(accepted.roomId);
      notifyMatch(accepted.matchId);
      return json(res, 200, { match: matchForSession(db, accepted.matchId, session) });
    }
    const quickRematchAccept = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/rematch\/accept$/);
    if (quickRematchAccept && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      if (typeof body.token !== 'string') throw new HttpError(400, 'Rematch token required');
      const offer = pendingQuickRematch(db, quickRematchAccept[1], session.id);
      if (!offer || offer.token !== body.token) throw new HttpError(404, 'Rematch invitation not found');
      const accepted = acceptQuickRematch(db, body.token, session.id, undefined, requireNewGameAdmission);
      connectLiveParticipants(accepted.matchId);
      notifyRoom(accepted.roomId);
      notifyMatch(accepted.matchId);
      return json(res, 200, { match: matchForSession(db, accepted.matchId, session) });
    }
    const matchMatch = path.match(/^\/api\/matches\/([a-f0-9-]{36})$/);
    if (matchMatch && method === 'GET') {
      const session = requireSession(req, res, db);
      return json(res, 200, { match: matchForSession(db, matchMatch[1], session) });
    }

    if (path === '/api/auth/google' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      const identity = await attachFirebaseIdentity(db, session.id, body.idToken);
      recordTelemetryEvent(db, session.id, 'ranked_auth_completed', 'ranked');
      return json(res, 200, { profile: profileView(db, identity.uid) });
    }
    if (path === '/api/profile/me' && method === 'GET') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      return json(res, 200, { profile: profileView(db, session.uid) });
    }
    if ((path === '/api/profile/handle' || path === '/api/profile/rename') && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const body = await readJson(req);
      path.endsWith('/rename')
        ? renameHandle(db, session.uid, body.handle)
        : claimHandle(db, session.uid, body.handle);
      return json(res, 200, { profile: profileView(db, session.uid) });
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'Unknown endpoint');
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (path.startsWith('/api/')) throw new HttpError(404, 'Unknown endpoint');
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error(error);
    json(res, 500, { error: 'Internal server error' });
  }
}
  return handle;
}
