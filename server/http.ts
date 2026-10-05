import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { publicOrigin } from './config.js';
import { sessionTokenId } from './invitation-secrets.js';
import { HttpError } from './errors.js';
export { HttpError } from './errors.js';

export function assertMutationOrigin(req: Pick<IncomingMessage, 'headers'>): void {
  if (req.headers.origin !== publicOrigin || req.headers['x-requested-with'] !== 'override-game') {
    throw new HttpError(403, 'Request origin is not allowed');
  }
}

export function applySecurityHeaders(res: Pick<ServerResponse, 'setHeader'>): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://accounts.google.com",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.firebaseapp.com",
    'frame-src https://*.firebaseapp.com https://accounts.google.com',
  ].join('; '));
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  applySecurityHeaders(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new HttpError(413, 'Request is too large');
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Expected a JSON object');
  }
}

export interface Session {
  id: string;
  uid: string | null;
  createdAt: number;
  expiresAt: number;
}

function limitNewSession(req: IncomingMessage, now: number, db: Database.Database): void {
  const address = rateLimitAddress(req);
  const current = db.prepare('SELECT window_started_at, count FROM new_session_limits WHERE address = ?')
    .get(address) as { window_started_at: number; count: number } | undefined;
  if (!current || current.window_started_at <= now - 5 * 60_000) {
    db.prepare(`INSERT INTO new_session_limits (address, window_started_at, count) VALUES (?, ?, 1)
      ON CONFLICT(address) DO UPDATE SET window_started_at = excluded.window_started_at, count = 1`)
      .run(address, now);
  } else {
    if (current.count >= 60) throw new HttpError(429, 'Too many new sessions. Try again later');
    db.prepare('UPDATE new_session_limits SET count = count + 1 WHERE address = ?').run(address);
  }
  db.prepare('DELETE FROM new_session_limits WHERE window_started_at <= ?').run(now - 10 * 60_000);
}

function rateLimitAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (process.env.RENDER !== 'true') return peer;
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first && isIP(first) ? first : peer;
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie ?? '';
  const pair = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

export function existingSession(req: IncomingMessage, db: Database.Database): Session | null {
  const token = cookieValue(req, 'override_session');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const id = sessionTokenId(token);
  const row = db.prepare('SELECT id, uid, created_at, expires_at FROM sessions WHERE id = ? AND expires_at > ?')
    .get(id, Date.now()) as { id: string; uid: string | null; created_at: number; expires_at: number } | undefined;
  return row ? { id: row.id, uid: row.uid, createdAt: row.created_at, expiresAt: row.expires_at } : null;
}

export function requireSession(req: IncomingMessage, res: ServerResponse, db: Database.Database): Session {
  const found = existingSession(req, db);
  if (found) return found;
  const now = Date.now();
  limitNewSession(req, now, db);
  const token = randomBytes(32).toString('hex');
  const session: Session = { id: sessionTokenId(token), uid: null, createdAt: now, expiresAt: now + 30 * 24 * 60 * 60_000 };
  db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(session.id, now, session.expiresAt);
  res.setHeader('set-cookie', `override_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return session;
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a display name');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) throw new HttpError(400, 'Display name must be 1–24 characters');
  return name;
}

export function parseCreationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'Expected a creation request ID');
  }
  return value.toLowerCase();
}
