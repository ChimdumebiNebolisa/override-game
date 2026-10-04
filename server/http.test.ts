import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicOrigin } from './config';
import { applySecurityHeaders, assertMutationOrigin, existingSession, requireSession } from './http';
import { openDatabase } from './db';
import { createQuickRoom, joinQuickRoom } from './rooms';

function request(headers: Record<string, string>) {
  return { headers } as unknown as Pick<IncomingMessage, 'headers'>;
}

describe('mutation request origin', () => {
  const invalidRequests: Array<{ name: string; headers: Record<string, string> }> = [
    { name: 'missing origin', headers: {} },
    { name: 'wrong origin', headers: { origin: 'https://attacker.example', 'x-requested-with': 'override-game' } },
    { name: 'missing request marker', headers: { origin: publicOrigin } },
  ];

  it.each(invalidRequests)('rejects $name', ({ headers }) => {
    let failure: unknown;
    try { assertMutationOrigin(request(headers)); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 403 });
  });

  it('accepts a same-origin JSON client request', () => {
    expect(() => assertMutationOrigin(request({
      origin: publicOrigin,
      'x-requested-with': 'override-game',
    }))).not.toThrow();
  });
});

it('sets browser security headers including Firebase Authentication origins', () => {
  const headers = new Map<string, string>();
  const response = ({
    setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, String(value)),
  } as unknown) as Pick<ServerResponse, 'setHeader'>;
  applySecurityHeaders(response);
  expect(headers.get('content-security-policy')).toContain("object-src 'none'");
  expect(headers.get('content-security-policy')).toContain('https://identitytoolkit.googleapis.com');
  expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers.get('x-frame-options')).toBe('DENY');
});

it('sets HSTS only when responses are served in production', () => {
  const prior = process.env.NODE_ENV;
  const headers = new Map<string, string>();
  const response = ({ setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, String(value)) } as unknown) as Pick<ServerResponse, 'setHeader'>;
  try {
    process.env.NODE_ENV = 'production';
    applySecurityHeaders(response);
    expect(headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
    process.env.NODE_ENV = 'test';
    headers.clear();
    applySecurityHeaders(response);
    expect(headers.has('strict-transport-security')).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

it('keeps the bearer cookie out of session, room, and match records while restoring the same session', () => {
  const db = openDatabase(':memory:');
  const makeSession = () => {
    const responseHeaders = new Map<string, string>();
    const response = { setHeader: (name: string, value: string | number | readonly string[]) => responseHeaders.set(name, String(value)) } as unknown as ServerResponse;
    const session = requireSession({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage, response, db);
    const cookie = responseHeaders.get('set-cookie') ?? '';
    const token = /override_session=([a-f0-9]{64})/.exec(cookie)?.[1];
    expect(token).toBeDefined();
    expect(token).not.toBe(session.id);
    expect(existingSession({ headers: { cookie: `override_session=${token}` } } as IncomingMessage, db)).toEqual(session);
    return { session, token: token as string };
  };
  try {
    const host = makeSession();
    const guest = makeSession();
    const room = createQuickRoom(db, host.session, 'Host');
    joinQuickRoom(db, guest.session, { code: room.code }, 'Guest');
    const records = JSON.stringify({
      sessions: db.prepare('SELECT * FROM sessions').all(),
      rooms: db.prepare('SELECT * FROM rooms').all(),
      matches: db.prepare('SELECT * FROM matches').all(),
    });
    expect(records).not.toContain(host.token);
    expect(records).not.toContain(guest.token);
    expect(db.prepare('SELECT COUNT(*) AS count FROM matches WHERE player_a_key IN (?, ?) OR player_b_key IN (?, ?)')
      .get(host.session.id, guest.session.id, host.session.id, guest.session.id)).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
