import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApiHandler } from './api.js';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { openDatabase } from './db';
import { firebaseWebConfig, port, publicOrigin } from './config';
import { attachFirebaseIdentity, claimHandle, getPublicProfile, renameHandle } from './auth';
import { HttpError, applySecurityHeaders, assertMutationOrigin, displayName, existingSession, json, parseCreationKey, readJson, requireSession } from './http';
import { activeMatchForSession, createBotMatch, dueMatches, getMatch, lockAction, markConnected, markDisconnected, matchForSession, parseAction, reconcilePresenceOnStartup, resignMatch } from './matches';
import { closeQuickRoom, createQuickRoom, getRoom, joinQuickRoom, openRoomForSession, roomForSession } from './rooms';
import { acknowledgeRankedReady, clearRankedReadyPresenceOnStartup, expireRankedLeases, getRankedSettlement, joinRankedQueue, leaveRankedQueue, markRankedReadyPresence, publicRankedSettlement, rankedQueueStatus, settlePendingRankedMatches, settleRankedMatch } from './ranked';
import { leaderboard, profileView } from './progression';
import { acceptRankedChallenge, acceptRankedChallengeByCode, acceptRankedRematch, createRankedChallenge, expireRankedInvitations, pendingRankedChallenge, pendingRankedRematch, requestRankedRematch } from './invitations';
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
    applySecurityHeaders(res);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Build the web client first');
  }
}

const apiHandle = createApiHandler({ db, logMatchEvent, notifyRoom, notifyMatch, connectLiveParticipants });

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api')) return apiHandle(req, res);
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try { await serveStatic(req, res, url.pathname); }
  catch (error) {
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
      try {
        const match = getMatch(db, id);
        logMatchEvent(match?.status === 'voided' ? 'match_voided' : match?.status === 'finished' ? 'match_finished' : match?.status === 'decision' ? 'round_opened' : 'round_resolved', id);
        if (match?.room_id) notifyRoom(match.room_id);
        notifyMatch(id);
        if (match?.mode === 'ranked' && match.status === 'finished') {
          settleRankedMatch(db, id);
          logMatchEvent('ranked_settled', id);
        }
      } catch {
        // Terminal settlements have their own retry worker; polling also recovers a missed notification.
        console.error(JSON.stringify({ event: 'match_deadline_followup_failed', matchId: id }));
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
