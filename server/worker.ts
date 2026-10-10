import { WorkerSqliteDatabase, asDomainDatabase } from './worker-sqlite.js';
import { initializeDatabase } from './schema-initializer.js';
import { HttpError } from './errors.js';

interface SqlStorage {
  exec(sql: string, ...bindings: unknown[]): { rowsWritten: number; rowsRead: number; next(): IteratorResult<unknown>; toArray(): unknown[] };
}
interface Storage {
  sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  sync(): Promise<void>;
  getCurrentBookmark?(): Promise<string>;
  getBookmarkForTime?(timestamp: number): Promise<string>;
  onNextSessionRestoreBookmark?(bookmark: string): Promise<string>;
}
interface SocketState {
  storage: Storage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: WorkerWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerWebSocket[];
  abort?(message?: string, options?: { retryAlarm: boolean }): void;
}
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Environment {
  GAME: Namespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  PUBLIC_ORIGIN?: string;
  FIREBASE_WEB_CONFIG: string;
  INVITATION_ENCRYPTION_KEY: string;
  RECOVERY_CONTROL_TOKEN?: string;
}
interface SocketAttachment {
  roomId: string | null;
  matchId: string | null;
  sessionId: string;
  key: string;
}
interface NodeRequestLike {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

const REQUEST_BUDGET = 200_000;
const DURATION_BUDGET_GB_SECONDS = 200_000;
const READ_ROW_BUDGET = 18_000_000_000;
const WRITE_ROW_BUDGET = 35_000_000;
const ACTIVE_MEMORY_GB = 0.128;
const MONTHLY_UNITS = REQUEST_BUDGET * 20;
const MAX_SOCKET_MESSAGE_BYTES = 1_024;
const MAX_JSON_BODY_BYTES = 16_384;
const MATCH_RESERVE_UNITS = 20_000;
const SAFE_USAGE_FRACTION = 0.8;
const DAILY_REQUEST_UNITS = 100_000 * 20;
const DAILY_DURATION_GB_SECONDS = 13_000;
const DAILY_READ_ROW_BUDGET = 5_000_000;
const DAILY_WRITE_ROW_BUDGET = 100_000;
const MATCH_RESERVE_DURATION_GB_SECONDS = 25;
const MATCH_RESERVE_READ_ROWS = 25_000;
const MATCH_RESERVE_WRITE_ROWS = 1_000;

function setProcessEnvironment(env: Environment, requestOrigin?: string): void {
  process.env.PUBLIC_ORIGIN = env.PUBLIC_ORIGIN ?? requestOrigin ?? '';
  process.env.FIREBASE_WEB_CONFIG = env.FIREBASE_WEB_CONFIG;
  process.env.INVITATION_ENCRYPTION_KEY = env.INVITATION_ENCRYPTION_KEY;
  process.env.RENDER = 'false';
}

function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

function requestLike(request: Request): NodeRequestLike {
  const url = new URL(request.url);
  const headers: Record<string, string> = Object.fromEntries(request.headers.entries());
  headers.host = url.host;
  return {
    url: request.url,
    method: request.method,
    headers,
    socket: { remoteAddress: request.headers.get('CF-Connecting-IP') ?? 'unknown' },
    async *[Symbol.asyncIterator]() {
      if (!request.body) return;
      const contentLength = headers['content-length'];
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_JSON_BODY_BYTES) {
        throw new HttpError(413, 'Request is too large');
      }
      const reader = request.body.getReader();
      let size = 0;
      let complete = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { complete = true; break; }
          size += value.byteLength;
          if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'Request is too large');
          yield value;
        }
      } finally {
        if (!complete) {
          try { await reader.cancel(); } catch { /* The client may already have closed the stream. */ }
        }
        reader.releaseLock();
      }
    },
  };
}

class ResponseCollector {
  status = 200;
  readonly headers = new Headers();
  body: string | null = null;

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers ?? {})) this.headers.set(name, value);
    return this;
  }

  end(body?: string): this {
    this.body = body ?? null;
    return this;
  }

  toResponse(): Response {
    return new Response(this.body, { status: this.status, headers: this.headers });
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__/auth/')) return proxyFirebaseAuth(request, env);
    if (!path.startsWith('/api/') && !path.startsWith('/__ops/recovery/')) return env.ASSETS.fetch(request);
    const id = env.GAME.idFromName('override-game-global');
    return env.GAME.get(id).fetch(request);
  },
};

async function proxyFirebaseAuth(request: Request, env: Environment): Promise<Response> {
  let projectId: unknown;
  try { projectId = (JSON.parse(env.FIREBASE_WEB_CONFIG) as Record<string, unknown>).projectId; }
  catch { return new Response('Firebase auth is not configured', { status: 503 }); }
  if (typeof projectId !== 'string' || !/^[a-z0-9-]{1,128}$/.test(projectId)) {
    return new Response('Firebase auth is not configured', { status: 503 });
  }
  const upstreamUrl = new URL(request.url);
  upstreamUrl.protocol = 'https:';
  upstreamUrl.hostname = `${projectId}.firebaseapp.com`;
  upstreamUrl.port = '';
  return fetch(new Request(upstreamUrl, request), { redirect: 'manual' });
}

export class GameDurableObject {
  private readonly database: WorkerSqliteDatabase;
  private readonly db;
  private services?: typeof import('./api.js')['workerServices'];
  private apiHandler?: ReturnType<typeof import('./api.js')['createApiHandler']>;
  private readonly ctx: SocketState;
  private readonly env: Environment;

  constructor(ctx: SocketState, env: Environment) {
    this.ctx = ctx;
    this.env = env;
    setProcessEnvironment(env);
    this.database = new WorkerSqliteDatabase(ctx.storage.sql as SqlStorage, ctx.storage);
    this.db = asDomainDatabase(this.database);
    initializeDatabase(this.db, { workerBaseline: true });
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_socket_closures (
      id TEXT PRIMARY KEY, attachment_json TEXT NOT NULL, due_at INTEGER NOT NULL
    );`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_usage (
      month TEXT PRIMARY KEY, request_units INTEGER NOT NULL DEFAULT 0,
      active_ms INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0
    );`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_daily_usage (
      day TEXT PRIMARY KEY, request_units INTEGER NOT NULL DEFAULT 0,
      active_ms INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0
    );`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_maintenance (
      id INTEGER PRIMARY KEY CHECK(id = 1), last_pruned_at INTEGER NOT NULL
    );`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_recovery_control (
      id INTEGER PRIMARY KEY CHECK(id = 1), requested_at INTEGER NOT NULL,
      target_bookmark TEXT NOT NULL, undo_bookmark TEXT NOT NULL
    );`);
    if (this.recoveryPending()) {
      ctx.blockConcurrencyWhile(async () => { await ctx.storage.setAlarm(Date.now() + 250); });
    }
  }

  private async api(requestOrigin?: string) {
    if (!this.apiHandler) {
      const api = await import('./api.js');
      this.services = api.workerServices;
      let firebaseWebConfig: unknown = null;
      try {
        const config = JSON.parse(this.env.FIREBASE_WEB_CONFIG) as Record<string, unknown>;
        const authDomain = new URL(this.env.PUBLIC_ORIGIN ?? requestOrigin ?? 'https://invalid.example').host;
        if (typeof config.apiKey === 'string' && typeof config.projectId === 'string' && typeof config.appId === 'string') {
          firebaseWebConfig = { ...config, authDomain };
        }
      } catch { /* The API returns no browser auth config when the setting is invalid. */ }
      this.apiHandler = api.createApiHandler({
        db: this.db,
        publicOrigin: this.env.PUBLIC_ORIGIN,
        firebaseWebConfig,
        allowNewGame: () => this.allowNewGame(),
        logMatchEvent: (event, matchId) => this.logMatchEvent(event, matchId),
        notifyRoom: (roomId) => this.notify('room', roomId),
        notifyMatch: (matchId) => this.notify('match', matchId),
        connectLiveParticipants: (matchId) => this.connectLiveParticipants(matchId),
      });
    }
    return this.apiHandler;
  }

  private async core() {
    await this.api();
    return this.services!;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    setProcessEnvironment(this.env, url.origin);
    if (url.pathname.startsWith('/__ops/recovery/')) {
      const recoveryStart = performance.now();
      try {
        try { return await this.recoveryControl(request, url); }
        catch (error) {
          if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers: { 'cache-control': 'no-store' } });
          console.error('Recovery control request failed');
          return Response.json({ error: 'Recovery control request failed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
        }
      } finally {
        try { this.recordUsage(20, performance.now() - recoveryStart); } catch { /* Recovery must not fail because its usage counter failed. */ }
      }
    }
    if (url.pathname.startsWith('/api/') && this.recoveryPending()) {
      return Response.json({ error: 'Recovery is in progress' }, { status: 503, headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
    }
    const start = performance.now();
    try {
      await this.api(url.origin);
      if (url.pathname === '/api/live' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return await this.connectSocket(request, url);
      }
      const response = new ResponseCollector();
      await (await this.api())(requestLike(request) as never, response as never);
      return response.toResponse();
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      console.error(error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    } finally {
      this.recordUsage(20, performance.now() - start);
      await this.scheduleAlarm();
    }
  }

  async webSocketMessage(socket: WorkerWebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_SOCKET_MESSAGE_BYTES) {
      socket.close(1009, 'Message limit exceeded');
      this.recordUsage(1, 0);
      return;
    }
    this.recordUsage(1, 0);
  }

  async webSocketClose(socket: WorkerWebSocket): Promise<void> {
    await this.api();
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    this.database.prepare('INSERT INTO worker_socket_closures (id, attachment_json, due_at) VALUES (?, ?, ?)')
      .run(crypto.randomUUID(), JSON.stringify(attachment), Date.now() + 1_500);
    this.recordUsage(1, 0);
    await this.scheduleAlarm();
  }

  async webSocketError(socket: WorkerWebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    const start = performance.now();
    if (this.recoveryPending()) {
      return this.ctx.blockConcurrencyWhile(async () => {
        this.database.prepare('DELETE FROM worker_recovery_control WHERE id = 1').run();
        await this.ctx.storage.sync();
        this.ctx.abort?.('Recovery restart', { retryAlarm: false });
      });
    }
    try {
      const core = await this.core();
      const now = Date.now();
      this.processSocketClosures(now, core);
      for (const id of core.dueMatches(this.db, now)) {
        try {
          const match = core.getMatch(this.db, id);
          this.logMatchEvent(match?.status === 'voided' ? 'match_voided' : match?.status === 'finished' ? 'match_finished' : match?.status === 'decision' ? 'round_opened' : 'round_resolved', id);
          if (match?.room_id) this.notify('room', match.room_id);
          this.notify('match', id);
          if (match?.mode === 'ranked' && match.status === 'finished') {
            core.settleRankedMatch(this.db, id);
            this.logMatchEvent('ranked_settled', id);
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'match_deadline_followup_failed', matchId: id, message: String(error) }));
        }
      }
      for (const id of core.expireRankedLeases(this.db, now)) this.notify('match', id);
      core.expireRankedInvitations(this.db, now);
      core.expireQuickRematches(this.db, now);
      this.database.prepare("UPDATE rooms SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(now);
      for (const id of core.settlePendingRankedMatches(this.db, now)) {
        this.logMatchEvent(core.getMatch(this.db, id)?.status === 'voided' ? 'ranked_voided' : 'ranked_settled', id);
        this.notify('match', id);
      }
      const hourly = this.database.prepare('SELECT last_pruned_at FROM worker_maintenance WHERE id = 1').get() as { last_pruned_at: number } | undefined;
      if (!hourly || hourly.last_pruned_at <= now - 60 * 60_000) {
        core.pruneExpiredGuestData(this.db, now);
        this.database.prepare(`INSERT INTO worker_maintenance (id, last_pruned_at) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET last_pruned_at = excluded.last_pruned_at`).run(now);
      }
    } finally {
      this.recordUsage(20, performance.now() - start);
      await this.scheduleAlarm();
    }
  }

  private async connectSocket(request: Request, url: URL): Promise<Response> {
    const core = await this.core();
    if (request.headers.get('origin') !== (this.env.PUBLIC_ORIGIN ?? new URL(request.url).origin)) throw new HttpError(403, 'Channel origin is not allowed');
    const roomId = url.searchParams.get('roomId');
    const directMatchId = url.searchParams.get('matchId');
    const requestState = requestLike(request) as never;
    const session = core.existingSession(requestState as never, this.db);
    if (!session || Boolean(roomId) === Boolean(directMatchId)) throw new HttpError(401, 'Session required');
    if (roomId) core.roomForSession(this.db, roomId, session);
    if (directMatchId) core.matchForSession(this.db, directMatchId, session);
    const match = directMatchId ? core.getMatch(this.db, directMatchId) : null;
    const key = match?.mode === 'ranked' ? session.uid : session.id;
    if (!key) throw new HttpError(401, 'Identity required');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { roomId, matchId: directMatchId, sessionId: session.id, key };
    this.ctx.acceptWebSocket(server, [roomId ? `room:${roomId}` : `match:${directMatchId}`]);
    server.serializeAttachment(attachment);

    const room = roomId ? core.getRoom(this.db, roomId) : null;
    const activeMatchId = directMatchId ?? room?.match_id ?? null;
    const side = activeMatchId ? this.sideForMatch(activeMatchId, key, core) : null;
    if (activeMatchId && side) {
      const bound = match?.mode === 'ranked' && match.status === 'readying'
        ? core.markRankedReadyPresence(this.db, activeMatchId, key, true)
        : false;
      if (bound) this.connectLiveParticipants(activeMatchId);
      core.markConnected(this.db, activeMatchId, side);
      if (roomId) this.notify('room', roomId);
      this.notify('match', activeMatchId);
    }
    server.send(JSON.stringify({ type: 'updated', roomId, matchId: activeMatchId }));
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private processSocketClosures(now: number, core: NonNullable<GameDurableObject['services']>): void {
    const pending = this.database.prepare('SELECT id, attachment_json FROM worker_socket_closures WHERE due_at <= ?').all(now) as Array<{ id: string; attachment_json: string }>;
    for (const row of pending) {
      this.database.prepare('DELETE FROM worker_socket_closures WHERE id = ?').run(row.id);
      const attachment = JSON.parse(row.attachment_json) as SocketAttachment;
      const room = attachment.roomId ? core.getRoom(this.db, attachment.roomId) : null;
      const matchId = attachment.matchId ?? room?.match_id ?? null;
      const stillConnected = this.ctx.getWebSockets().some((socket) => {
        const current = socket.deserializeAttachment() as SocketAttachment | null;
        if (current?.key !== attachment.key) return false;
        const currentMatchId = current.matchId ?? (current.roomId ? core.getRoom(this.db, current.roomId)?.match_id : null) ?? null;
        return (matchId !== null && currentMatchId === matchId) ||
          (matchId === null && currentMatchId === null && attachment.roomId !== null && current.roomId === attachment.roomId);
      });
      if (stillConnected) continue;
      if (!matchId) continue;
      const match = core.getMatch(this.db, matchId);
      const side = this.sideForMatch(matchId, attachment.key, core);
      if (!side) continue;
      if (match?.mode === 'ranked' && match.status === 'readying') core.markRankedReadyPresence(this.db, matchId, attachment.key, false);
      core.markDisconnected(this.db, matchId, side);
      if (attachment.roomId) this.notify('room', attachment.roomId);
      this.notify('match', matchId);
    }
  }

  private sideForMatch(matchId: string, key: string, core: NonNullable<GameDurableObject['services']>): 'A' | 'B' | null {
    const match = core.getMatch(this.db, matchId);
    if (match?.player_a_key === key) return 'A';
    if (match?.player_b_key === key) return 'B';
    return null;
  }

  private connectLiveParticipants(matchId: string): void {
    const core = this.services!;
    const match = core.getMatch(this.db, matchId);
    if (!match) return;
    for (const player of [match.player_a_key, match.player_b_key]) {
      const connected = this.ctx.getWebSockets().some((socket) => {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        return attachment?.key === player && (attachment.matchId === matchId ||
          (match.room_id !== null && attachment.roomId === match.room_id));
      });
      if (connected) core.markConnected(this.db, matchId, player === match.player_a_key ? 'A' : 'B');
    }
  }

  private notify(kind: 'room' | 'match', id: string): void {
    const data = JSON.stringify(kind === 'room' ? { type: 'updated', roomId: id } : { type: 'updated', matchId: id });
    for (const socket of this.ctx.getWebSockets(`${kind}:${id}`)) {
      try { socket.send(data); } catch { /* Closed sockets are removed by the runtime. */ }
    }
  }

  private logMatchEvent(event: string, matchId: string): void {
    const match = this.services?.getMatch(this.db, matchId);
    if (match) console.info(JSON.stringify({ at: new Date().toISOString(), event, matchId, status: match.status, revision: match.revision }));
  }

  private allowNewGame(): boolean {
    const month = monthKey();
    const row = this.database.prepare('SELECT request_units, active_ms, rows_read, rows_written FROM worker_usage WHERE month = ?')
      .get(month) as { request_units: number; active_ms: number; rows_read: number; rows_written: number } | undefined;
    const day = new Date().toISOString().slice(0, 10);
    const daily = this.database.prepare('SELECT request_units, active_ms, rows_read, rows_written FROM worker_daily_usage WHERE day = ?')
      .get(day) as { request_units: number; active_ms: number; rows_read: number; rows_written: number } | undefined;
    const live = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM matches WHERE status IN ('readying', 'decision', 'transition', 'grace')) +
      (SELECT COUNT(*) FROM rooms WHERE status = 'open') +
      (SELECT COUNT(*) FROM ranked_ownership WHERE state = 'searching') +
      (SELECT COUNT(*) FROM ranked_invitations WHERE status = 'open') +
      (SELECT COUNT(*) FROM quick_rematch_invitations WHERE status = 'open') +
      (SELECT COUNT(*) FROM matches m LEFT JOIN rating_settlements s ON s.match_id = m.id
        WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL AND s.match_id IS NULL) AS count`).get() as { count: number };
    const requestUnits = row?.request_units ?? 0;
    const activeSeconds = (row?.active_ms ?? 0) * ACTIVE_MEMORY_GB / 1_000;
    const reads = row?.rows_read ?? 0;
    const writes = row?.rows_written ?? 0;
    const dailyUnits = daily?.request_units ?? 0;
    const dailyActiveSeconds = (daily?.active_ms ?? 0) * ACTIVE_MEMORY_GB / 1_000;
    const dailyReads = daily?.rows_read ?? 0;
    const dailyWrites = daily?.rows_written ?? 0;
    return requestUnits + (live.count + 1) * MATCH_RESERVE_UNITS <= MONTHLY_UNITS * SAFE_USAGE_FRACTION &&
      activeSeconds <= DURATION_BUDGET_GB_SECONDS * SAFE_USAGE_FRACTION &&
      reads <= READ_ROW_BUDGET * SAFE_USAGE_FRACTION && writes <= WRITE_ROW_BUDGET * SAFE_USAGE_FRACTION &&
      dailyUnits + (live.count + 1) * MATCH_RESERVE_UNITS <= DAILY_REQUEST_UNITS * SAFE_USAGE_FRACTION &&
      dailyActiveSeconds + (live.count + 1) * MATCH_RESERVE_DURATION_GB_SECONDS <= DAILY_DURATION_GB_SECONDS * SAFE_USAGE_FRACTION &&
      dailyReads + (live.count + 1) * MATCH_RESERVE_READ_ROWS <= DAILY_READ_ROW_BUDGET * SAFE_USAGE_FRACTION &&
      dailyWrites + (live.count + 1) * MATCH_RESERVE_WRITE_ROWS <= DAILY_WRITE_ROW_BUDGET * SAFE_USAGE_FRACTION;
  }

  private recordUsage(units: number, activeMs: number): void {
    const sqlUsage = this.database.takeUsage();
    const month = monthKey();
    const day = new Date().toISOString().slice(0, 10);
    const measuredReads = sqlUsage.rowsRead + 1;
    const measuredWrites = sqlUsage.rowsWritten * 2 + 2;
    this.database.prepare(`INSERT INTO worker_usage (month, request_units, active_ms, rows_read, rows_written)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(month) DO UPDATE SET
        request_units = request_units + excluded.request_units,
        active_ms = active_ms + excluded.active_ms,
        rows_read = rows_read + excluded.rows_read,
        rows_written = rows_written + excluded.rows_written`)
      .run(month, units, Math.ceil(activeMs + 5), measuredReads, measuredWrites);
    this.database.prepare(`INSERT INTO worker_daily_usage (day, request_units, active_ms, rows_read, rows_written)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET
        request_units = request_units + excluded.request_units,
        active_ms = active_ms + excluded.active_ms,
        rows_read = rows_read + excluded.rows_read,
        rows_written = rows_written + excluded.rows_written`)
      .run(day, units, Math.ceil(activeMs + 5), measuredReads, measuredWrites);
  }

  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const next = this.database.prepare(`SELECT MIN(column1) AS due_at FROM (VALUES
      ((SELECT MIN(deadline) FROM matches WHERE status = 'decision' AND deadline IS NOT NULL)),
      ((SELECT MIN(transition_at) FROM matches WHERE status = 'transition' AND transition_at IS NOT NULL)),
      ((SELECT MIN(grace_until) FROM matches WHERE status = 'grace' AND grace_until IS NOT NULL)),
      ((SELECT MIN(ready_deadline) FROM matches WHERE status = 'readying' AND ready_deadline IS NOT NULL)),
      ((SELECT MIN(lease_expires_at) FROM ranked_ownership WHERE state = 'searching' AND lease_expires_at IS NOT NULL)),
      ((SELECT MIN(expires_at) FROM ranked_invitations WHERE status = 'open')),
      ((SELECT MIN(expires_at) FROM quick_rematch_invitations WHERE status = 'open')),
      ((SELECT MIN(expires_at) FROM rooms WHERE status = 'open')),
      ((SELECT MIN(due_at) FROM worker_socket_closures)),
      (CASE WHEN EXISTS (
        SELECT 1 FROM matches m LEFT JOIN rating_settlements s ON s.match_id = m.id
        WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL
          AND m.ended_at < ? AND s.match_id IS NULL
      ) THEN ? ELSE ? END)
    )`).get(now, now + 1_000, now + 60 * 60_000) as { due_at: number | null };
    const alarm = Math.max(now + 50, next.due_at ?? now + 60 * 60_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || alarm < current) await this.ctx.storage.setAlarm(alarm);
  }

  private recoveryPending(): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM worker_recovery_control WHERE id = 1').get());
  }

  private async recoveryControl(request: Request, url: URL): Promise<Response> {
    const noStore = { 'cache-control': 'no-store' };
    const token = this.env.RECOVERY_CONTROL_TOKEN;
    if (!token || token.length < 32) return Response.json({ error: 'Not found' }, { status: 404, headers: noStore });
    const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
    if (!constantTimeEqual(supplied, token)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: noStore });
    if (url.pathname === '/__ops/recovery/bookmark') {
      if (!this.ctx.storage.getCurrentBookmark) return Response.json({ error: 'PITR is unavailable in this runtime' }, { status: 501, headers: noStore });
      return Response.json({ bookmark: await this.ctx.storage.getCurrentBookmark() }, { headers: noStore });
    }
    if (url.pathname !== '/__ops/recovery/restore') return Response.json({ error: 'Not found' }, { status: 404, headers: noStore });
    if (!this.ctx.storage.getBookmarkForTime || !this.ctx.storage.onNextSessionRestoreBookmark || !this.ctx.abort) {
      return Response.json({ error: 'PITR restore is unavailable in this runtime' }, { status: 501, headers: noStore });
    }
    const body = await limitedJson(request, 1_024);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.recoveryPending()) return Response.json({ error: 'A recovery is already in progress' }, { status: 409, headers: noStore });
      let targetBookmark: string;
      if (typeof body.bookmark === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(body.bookmark)) {
        targetBookmark = body.bookmark;
      } else if (typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) &&
        body.timestamp <= Date.now() && body.timestamp >= Date.now() - 30 * 24 * 60 * 60_000) {
        try { targetBookmark = await this.ctx.storage.getBookmarkForTime!(body.timestamp); }
        catch { return Response.json({ error: 'The requested time is outside the available recovery window' }, { status: 400, headers: noStore }); }
      } else {
        return Response.json({ error: 'Provide a bookmark or a timestamp within the last 30 days' }, { status: 400, headers: noStore });
      }
      let undoBookmark: string;
      // Arm first: a failed alarm write must not leave a platform restore scheduled.
      await this.ctx.storage.setAlarm(Date.now() + 250);
      try { undoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark!(targetBookmark); }
      catch { return Response.json({ error: 'Cloudflare could not schedule this restore' }, { status: 400, headers: noStore }); }
      this.database.prepare(`INSERT INTO worker_recovery_control (id, requested_at, target_bookmark, undo_bookmark)
        VALUES (1, ?, ?, ?)`).run(Date.now(), targetBookmark, undoBookmark);
      return Response.json({ status: 'restore-scheduled', targetBookmark, undoBookmark, restartAfterMs: 250 }, { status: 202, headers: noStore });
    });
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function limitedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new HttpError(413, 'Request is too large');
  }
  if (!request.body) throw new HttpError(400, 'Expected a JSON object');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(413, 'Request is too large');
      chunks.push(value);
    }
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* The client may already have closed the stream. */ }
    }
    reader.releaseLock();
  }
  try {
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Expected a JSON object'); }
}
