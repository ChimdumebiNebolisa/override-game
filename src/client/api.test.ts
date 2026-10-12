import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  private listeners = new Map<string, Array<() => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }

  addEventListener(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

describe('live subscriptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.sockets = [];
    vi.stubGlobal('window', { location: { protocol: 'https:', host: 'game.example' }, setTimeout, clearTimeout });
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects a match after an unexpected close and reports each connection state', () => {
    const invalidate = vi.fn();
    const opened = vi.fn();
    const closed = vi.fn();
    const unsubscribe = api.subscribeMatch('match-1', invalidate, opened, closed);
    const first = FakeWebSocket.sockets[0];
    expect(first.url).toBe('wss://game.example/api/live?matchId=match-1');
    expect(opened).not.toHaveBeenCalled();

    first.emit('open');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    first.close();
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.sockets).toHaveLength(2);

    const second = FakeWebSocket.sockets[1];
    second.emit('open');
    second.emit('message');
    expect(opened).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(3);
    unsubscribe();
    expect(second.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it('cancels a room reconnect when its view unmounts', () => {
    const unsubscribe = api.subscribe('room-1', vi.fn());
    FakeWebSocket.sockets[0].close();
    unsubscribe();
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
  });
});

it('marks API requests as same-origin JSON requests', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"recorded":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  await api.trackEvent('homepage_opened');
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
    'Content-Type': 'application/json',
    'X-Requested-With': 'override-game',
  });
});

describe('guest session and creation recovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function freshApi() {
    vi.resetModules();
    return (await import('./api')).api;
  }

  it('establishes one session before concurrent resume, telemetry, and match creation', async () => {
    let release!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (path: string) => path === '/api/session'
      ? bootstrap : new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = await freshApi();
    const requests = [client.getResume(), client.trackEvent('homepage_opened'), client.createBotMatch('practice', 'easy', 'same-key')];
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
    release(new Response('{"signedIn":false,"profile":null}'));
    await Promise.all(requests);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/resume', '/api/telemetry', '/api/bot-matches']);
  });

  it('retries session initialization after a connection failure without sending dependent requests', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = await freshApi();
    await expect(client.getResume()).rejects.toThrow('unavailable');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
    await client.getResume();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/session', '/api/resume']);
  });

  it('recovers a lost creation response by repeating the identical creation intent', async () => {
    let creations = 0;
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === '/api/bot-matches' && creations++ === 0) throw new TypeError('response lost');
      return new Response(path === '/api/session' ? '{}' : '{"match":{"id":"accepted-match"}}');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = await freshApi();
    expect((await client.createBotMatch('practice', 'easy', 'same-key', undefined, undefined, false)).match.id).toBe('accepted-match');
    const attempts = fetchMock.mock.calls.filter(([path]) => path === '/api/bot-matches');
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1]?.body).toBe(attempts[1][1]?.body);
    expect(JSON.parse(String(attempts[1][1]?.body))).toMatchObject({ creationKey: 'same-key', timed: false });
  });

  it('does not retry a rejected creation intent', async () => {
    const fetchMock = vi.fn(async (path: string) => new Response(path === '/api/session' ? '{}' : '{"error":"Finish an existing match"}', { status: path === '/api/session' ? 200 : 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await freshApi();
    await expect(client.createBotMatch('practice', 'easy', 'same-key')).rejects.toThrow('Finish an existing match');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/bot-matches')).toHaveLength(1);
  });
});
