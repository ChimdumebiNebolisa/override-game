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
