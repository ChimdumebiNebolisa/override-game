import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { publicOrigin } from './config';
import { assertMutationOrigin } from './http';

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
