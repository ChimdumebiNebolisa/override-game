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
}
interface SocketState {
  storage: Storage;
  acceptWebSocket(socket: WorkerWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerWebSocket[];
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
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length) yield bytes;
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
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const id = env.GAME.idFromName('override-game-global');
    return env.GAME.get(id).fetch(request);
  },
};

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
    this.database.exec(`CREATE TABLE IF NOT EXISTS worker_maintenance (
      id INTEGER PRIMARY KEY CHECK(id = 1), last_pruned_at INTEGER NOT NULL
    );`);
  }

  private async api() {
    if (!this.apiHandler) {
      const api = await import('./api.js');
      this.services = api.workerServices;
      this.apiHandler = api.createApiHandler({
        db: this.db,
        publicOrigin: this.env.PUBLIC_ORIGIN,
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
    setProcessEnvironment(this.env, new URL(request.url).origin);
    const start = performance.now();
    const event = this.consumeBudget(20);
    if (!event) {
      this.recordUsage(20, performance.now() - start);
      return this.pausedResponse();
    }
    try {
      await this.api();
      const url = new URL(request.url);
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
    if (size > MAX_SOCKET_MESSAGE_BYTES || !this.consumeBudget(1)) {
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
    const event = this.consumeBudget(20);
    if (!event) {
      await this.ctx.storage.setAlarm(this.nextMonthStart());
      return;
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
      const hourly = this.ctx.storage.sql.exec('SELECT last_pruned_at FROM worker_maintenance WHERE id = 1').toArray()[0] as { last_pruned_at: number } | undefined;
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
      const stillConnected = this.ctx.getWebSockets().some((socket) => {
        const current = socket.deserializeAttachment() as SocketAttachment | null;
        return current?.key === attachment.key && (current.matchId === attachment.matchId ||
          (attachment.roomId !== null && current.roomId === attachment.roomId));
      });
      if (stillConnected) continue;
      const room = attachment.roomId ? core.getRoom(this.db, attachment.roomId) : null;
      const matchId = attachment.matchId ?? room?.match_id ?? null;
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

  private consumeBudget(units: number): boolean {
    const month = monthKey();
    const row = this.database.prepare('SELECT request_units, active_ms, rows_read, rows_written FROM worker_usage WHERE month = ?')
      .get(month) as { request_units: number; active_ms: number; rows_read: number; rows_written: number } | undefined;
    return (!row || row.request_units + units <= MONTHLY_UNITS) &&
      (!row || row.active_ms * ACTIVE_MEMORY_GB / 1_000 <= DURATION_BUDGET_GB_SECONDS) &&
      (!row || row.rows_read <= READ_ROW_BUDGET) && (!row || row.rows_written <= WRITE_ROW_BUDGET);
  }

  private recordUsage(units: number, activeMs: number): void {
    const sqlUsage = this.database.takeUsage();
    const month = monthKey();
    this.database.prepare(`INSERT INTO worker_usage (month, request_units, active_ms, rows_read, rows_written)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(month) DO UPDATE SET
        request_units = request_units + excluded.request_units,
        active_ms = active_ms + excluded.active_ms,
        rows_read = rows_read + excluded.rows_read,
        rows_written = rows_written + excluded.rows_written`)
      .run(month, units, Math.ceil(activeMs + 5), sqlUsage.rowsRead + 1, sqlUsage.rowsWritten * 2 + 2);
  }

  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const next = this.database.prepare(`SELECT MIN(due_at) AS due_at FROM (
      SELECT deadline AS due_at FROM matches WHERE status = 'decision' AND deadline IS NOT NULL
      UNION ALL SELECT transition_at FROM matches WHERE status = 'transition' AND transition_at IS NOT NULL
      UNION ALL SELECT grace_until FROM matches WHERE status = 'grace' AND grace_until IS NOT NULL
      UNION ALL SELECT ready_deadline FROM matches WHERE status = 'readying' AND ready_deadline IS NOT NULL
      UNION ALL SELECT lease_expires_at FROM ranked_ownership WHERE state = 'searching' AND lease_expires_at IS NOT NULL
      UNION ALL SELECT expires_at FROM ranked_invitations WHERE status = 'open'
      UNION ALL SELECT expires_at FROM quick_rematch_invitations WHERE status = 'open'
      UNION ALL SELECT expires_at FROM rooms WHERE status = 'open'
      UNION ALL SELECT due_at FROM worker_socket_closures
      UNION ALL SELECT ?
      UNION ALL SELECT ? WHERE EXISTS (
        SELECT 1 FROM matches m LEFT JOIN rating_settlements s ON s.match_id = m.id
        WHERE m.mode = 'ranked' AND m.status = 'finished' AND m.started_at IS NOT NULL
          AND m.ended_at < ? AND s.match_id IS NULL
      )
    )`).get(now + 60 * 60_000, now + 1_000, now) as { due_at: number | null };
    const alarm = Math.max(now + 50, next.due_at ?? now + 60 * 60_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || alarm < current) await this.ctx.storage.setAlarm(alarm);
  }

  private nextMonthStart(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 5);
  }

  private pausedResponse(): Response {
    return Response.json({ error: 'Service paused to stay within the monthly usage budget' }, {
      status: 503,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((this.nextMonthStart() - Date.now()) / 1_000))) },
    });
  }
}
