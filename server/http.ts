import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
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

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie ?? '';
  const pair = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

export function existingSession(req: IncomingMessage, db: Database.Database): Session | null {
  const id = cookieValue(req, 'override_session');
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = db.prepare('SELECT id, uid, created_at, expires_at FROM sessions WHERE id = ? AND expires_at > ?')
    .get(id, Date.now()) as { id: string; uid: string | null; created_at: number; expires_at: number } | undefined;
  return row ? { id: row.id, uid: row.uid, createdAt: row.created_at, expiresAt: row.expires_at } : null;
}

export function requireSession(req: IncomingMessage, res: ServerResponse, db: Database.Database): Session {
  const found = existingSession(req, db);
  if (found) return found;
  const now = Date.now();
  const session: Session = { id: randomBytes(32).toString('hex'), uid: null, createdAt: now, expiresAt: now + 30 * 24 * 60 * 60_000 };
  db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(session.id, now, session.expiresAt);
  res.setHeader('set-cookie', `override_session=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return session;
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a display name');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) throw new HttpError(400, 'Display name must be 1–24 characters');
  return name;
}
