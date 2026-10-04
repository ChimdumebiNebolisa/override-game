import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { openDatabase } from './db';
import { port, publicOrigin } from './config';
import { attachGoogleIdentity, claimHandle, getPublicProfile, renameHandle } from './auth';
import { HttpError, displayName, existingSession, json, parseCreationKey, readJson, requireSession } from './http';
import { activeMatchForSession, createBotMatch, dueMatches, getMatch, lockAction, markConnected, markDisconnected, matchForSession, parseAction, reconcilePresenceOnStartup, resignMatch } from './matches';
import { closeQuickRoom, createQuickRoom, getRoom, joinQuickRoom, openRoomForSession, roomForSession } from './rooms';
import { acknowledgeRankedReady, clearRankedReadyPresenceOnStartup, expireRankedLeases, getRankedSettlement, joinRankedQueue, leaveRankedQueue, markRankedReadyPresence, rankedQueueStatus, settlePendingRankedMatches, settleRankedMatch } from './ranked';
import { leaderboard, profileView } from './progression';
import { acceptRankedChallenge, acceptRankedRematch, createRankedChallenge, expireRankedInvitations, pendingRankedChallenge, pendingRankedRematch, requestRankedRematch } from './invitations';
import { acceptQuickRematch, expireQuickRematches, pendingQuickRematch, requestQuickRematch } from './quick-rematch';
import { recordClientTelemetry, recordTelemetryEvent } from './metrics';
import { pruneExpiredGuestData } from './maintenance';

const db = openDatabase();
clearRankedReadyPresenceOnStartup(db);
reconcilePresenceOnStartup(db);
pruneExpiredGuestData(db);
const sockets = new Set<{ ws: WebSocket; roomId: string | null; matchId: string | null; sessionId: string; key: string; alive: boolean }>();
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

function logMatchEvent(event: string, matchId: string): void {
  const match = getMatch(db, matchId);
  if (!match) return;
  console.info(JSON.stringify({ at: new Date().toISOString(), event, matchId, status: match.status, revision: match.revision }));
}

function notifyRoom(roomId: string): void {
  for (const connection of sockets) {
    if (connection.roomId === roomId && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify({ type: 'updated', roomId }));
    }
  }
}

function notifyMatch(matchId: string): void {
  for (const connection of sockets) {
    if (connection.matchId === matchId && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify({ type: 'updated', matchId }));
    }
  }
}

function sideForMatch(matchId: string, key: string): 'A' | 'B' | null {
  const match = getMatch(db, matchId);
  if (match?.player_a_key === key) return 'A';
  if (match?.player_b_key === key) return 'B';
  return null;
}

function hasLiveMatchConnection(matchId: string, roomId: string | null, key: string): boolean {
  return [...sockets].some((item) => item.key === key && item.ws.readyState === WebSocket.OPEN &&
    (item.matchId === matchId || (roomId !== null && item.roomId === roomId)));
}

function connectLiveParticipants(matchId: string): void {
  const match = getMatch(db, matchId);
  if (!match) return;
  if (hasLiveMatchConnection(matchId, match.room_id, match.player_a_key)) markConnected(db, matchId, 'A');
  if (hasLiveMatchConnection(matchId, match.room_id, match.player_b_key)) markConnected(db, matchId, 'B');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const root = resolve('dist');
  const target = resolve(root, `.${pathname}`);
  const relativePath = relative(root, target);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new HttpError(404, 'Not found');
  let file = target;
  try {
    if (!(await stat(file)).isFile()) file = join(root, 'index.html');
  } catch {
    file = join(root, 'index.html');
  }
  try {
    const body = await readFile(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Build the web client first');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && req.headers.origin && req.headers.origin !== publicOrigin) {
      throw new HttpError(403, 'Request origin is not allowed');
    }

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
    if (path === '/api/config' && method === 'GET') return json(res, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID ?? null });
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
      return json(res, 201, { room: createQuickRoom(db, session, displayName(body.displayName), parseCreationKey(body.creationKey)) });
    }
    if (path === '/api/rooms/join' && method === 'POST') {
      const session = requireSession(req, res, db);
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim() : undefined;
      const token = typeof body.token === 'string' ? body.token.trim() : undefined;
      if (!code && !token) throw new HttpError(400, 'Enter a room code or use an invite link');
      const room = joinQuickRoom(db, session, { code, token }, displayName(body.displayName));
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
      const id = createBotMatch(db, session, displayName(body.displayName ?? 'Player'), mode, difficulty, parentMatchId, parseCreationKey(body.creationKey));
      logMatchEvent('match_started', id);
      return json(res, 201, { match: matchForSession(db, id, session) });
    }
    if (path === '/api/ranked/queue') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      if (method === 'GET') return json(res, 200, { queue: rankedQueueStatus(db, session.uid) });
      if (method === 'POST') {
        const queue = joinRankedQueue(db, session.uid);
        recordTelemetryEvent(db, session.id, 'matchmaking_started', 'ranked-queue');
        return json(res, 200, { queue });
      }
      if (method === 'DELETE') return json(res, 200, { left: leaveRankedQueue(db, session.uid) });
    }
    if (path === '/api/ranked/challenges' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      return json(res, 201, { invitation: createRankedChallenge(db, session.uid) });
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
      return json(res, 200, { shell: acceptRankedChallenge(db, body.token, session.uid) });
    }
    if (path === '/api/ranked/rematches/accept' && method === 'POST') {
      const session = requireSession(req, res, db);
      if (!session.uid) throw new HttpError(401, 'Sign in with Google first');
      const body = await readJson(req);
      if (typeof body.token !== 'string') throw new HttpError(400, 'Rematch token required');
      return json(res, 200, { shell: acceptRankedRematch(db, body.token, session.uid) });
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
      const invitation = requestRankedRematch(db, rankedRematch[1], session.uid);
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
      if (match.mode !== 'ranked') throw new HttpError(404, 'Settlement not found');
      const settlement = getRankedSettlement(db, settlementMatch[1]);
      if (!settlement) return json(res, 200, { settlement: null });
      const { id: _idA, ...playerA } = settlement.playerA;
      const { id: _idB, ...playerB } = settlement.playerB;
      return json(res, 200, { settlement: { multiplier: settlement.multiplier, playerA, playerB } });
    }
    const quickRematch = path.match(/^\/api\/matches\/([a-f0-9-]{36})\/rematch$/);
    if (quickRematch && (method === 'GET' || method === 'POST')) {
      const session = requireSession(req, res, db);
      if (method === 'POST') {
        const invitation = requestQuickRematch(db, quickRematch[1], session.id);
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
      const accepted = acceptQuickRematch(db, body.token, session.id);
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
      const accepted = acceptQuickRematch(db, body.token, session.id);
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
      const identity = await attachGoogleIdentity(db, session.id, body.idToken);
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
    await serveStatic(req, res, path);
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error(error);
    json(res, 500, { error: 'Internal server error' });
  }
}

const server = createServer((req, res) => { void handle(req, res); });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/live') throw new Error('Unknown channel');
    if (req.headers.origin !== publicOrigin) throw new Error('Channel origin is not allowed');
    const roomId = url.searchParams.get('roomId');
    const directMatchId = url.searchParams.get('matchId');
    const session = existingSession(req, db);
    if (!session || Boolean(roomId) === Boolean(directMatchId)) throw new Error('Session required');
    if (roomId) roomForSession(db, roomId, session);
    if (directMatchId) matchForSession(db, directMatchId, session);
    const match = directMatchId ? getMatch(db, directMatchId) : null;
    const key = match?.mode === 'ranked' ? session.uid : session.id;
    if (!key) throw new Error('Identity required');
    websocketServer.handleUpgrade(req, socket, head, (ws) => {
      const connection = { ws, roomId, matchId: directMatchId, sessionId: session.id, key, alive: true };
      sockets.add(connection);
      const room = roomId ? getRoom(db, roomId) : null;
      const activeMatchId = directMatchId ?? room?.match_id;
      const side = activeMatchId ? sideForMatch(activeMatchId, key) : null;
      if (activeMatchId && side) {
        const bound = match?.mode === 'ranked' && match.status === 'readying'
          ? markRankedReadyPresence(db, activeMatchId, key, true)
          : false;
        if (bound) connectLiveParticipants(activeMatchId);
        markConnected(db, activeMatchId, side);
        if (roomId) notifyRoom(roomId);
        notifyMatch(activeMatchId);
      }
      ws.send(JSON.stringify({ type: 'updated', roomId, matchId: activeMatchId }));
      ws.on('pong', () => { connection.alive = true; });
      ws.on('close', () => {
        sockets.delete(connection);
        setTimeout(() => {
          const latestRoom = roomId ? getRoom(db, roomId) : null;
          const latestMatchId = directMatchId ?? latestRoom?.match_id;
          if (!latestMatchId) return;
          const latestMatch = getMatch(db, latestMatchId);
          if (hasLiveMatchConnection(latestMatchId, latestMatch?.room_id ?? null, key)) return;
          const latestSide = latestMatchId ? sideForMatch(latestMatchId, key) : null;
          if (latestMatchId && latestSide) {
            if (latestMatch?.mode === 'ranked' && latestMatch.status === 'readying') markRankedReadyPresence(db, latestMatchId, key, false);
            markDisconnected(db, latestMatchId, latestSide);
            if (roomId) notifyRoom(roomId);
            notifyMatch(latestMatchId);
          }
        }, 1_500);
      });
    });
  } catch {
    socket.destroy();
  }
});

setInterval(() => {
  for (const connection of sockets) {
    if (!connection.alive) { connection.ws.terminate(); continue; }
    connection.alive = false;
    connection.ws.ping();
  }
}, 15_000);

setInterval(() => {
  try {
    for (const id of dueMatches(db)) {
      const match = getMatch(db, id);
      logMatchEvent(match?.status === 'finished' ? 'match_finished' : match?.status === 'decision' ? 'round_opened' : 'round_resolved', id);
      if (match?.room_id) notifyRoom(match.room_id);
      notifyMatch(id);
      if (match?.mode === 'ranked' && match.status === 'finished') {
        settleRankedMatch(db, id);
        logMatchEvent('ranked_settled', id);
      }
    }
    for (const id of expireRankedLeases(db)) notifyMatch(id);
    expireRankedInvitations(db);
    expireQuickRematches(db);
    db.prepare("UPDATE rooms SET status = 'expired' WHERE status = 'open' AND expires_at <= ?")
      .run(Date.now());
  } catch (error) {
    console.error('Deadline worker failed', error);
  }
}, 100);

setInterval(() => {
  try {
    for (const id of settlePendingRankedMatches(db)) {
      logMatchEvent(getMatch(db, id)?.status === 'voided' ? 'ranked_voided' : 'ranked_settled', id);
      notifyMatch(id);
    }
  } catch (error) {
    console.error('Settlement worker failed', error);
  }
}, 1_000);

setInterval(() => {
  try { pruneExpiredGuestData(db); }
  catch (error) { console.error('Guest retention failed', error); }
}, 60 * 60_000);

server.listen(port, () => console.log(`OVERRIDE server listening on http://localhost:${port}`));
