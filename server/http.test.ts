import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicOrigin } from './config';
import { applySecurityHeaders, assertMutationOrigin } from './http';

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

it('sets browser security headers including the Google identity origins', () => {
  const headers = new Map<string, string>();
  const response = ({
    setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, String(value)),
  } as unknown) as Pick<ServerResponse, 'setHeader'>;
  applySecurityHeaders(response);
  expect(headers.get('content-security-policy')).toContain("object-src 'none'");
  expect(headers.get('content-security-policy')).toContain('https://accounts.google.com');
  expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers.get('x-frame-options')).toBe('DENY');
});
