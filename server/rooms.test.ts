import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db';
import { createQuickRoom, getRoom, joinQuickRoom, roomForSession } from './rooms';
import { invitationTokenHash, revealInvitationSecret } from './invitation-secrets';
import type { Session } from './http';

const session = (id: string): Session => ({ id, uid: null, createdAt: 0, expiresAt: 1_000_000 });
function expectStatus(run: () => unknown, status: number): void {
  try {
    run();
    throw new Error('Expected an HTTP error');
  } catch (error) {
    expect(error).toMatchObject({ status });
  }
}

describe('guest rooms', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('claims exactly one distinct guest seat and creates one match', () => {
    const host = session('host');
    const guest = session('guest');
    const other = session('other');
    const room = createQuickRoom(db, host, 'Host');
    const storedInvite = db.prepare('SELECT invite_token, invite_token_hash FROM rooms WHERE id = ?').get(room.id) as { invite_token: string; invite_token_hash: string };
    const rawInviteToken = room.inviteUrl.split('/join/')[1];
    expect(storedInvite.invite_token).not.toBe(rawInviteToken);
    expect(storedInvite.invite_token_hash).toBe(invitationTokenHash(rawInviteToken));
    expect(revealInvitationSecret(storedInvite.invite_token)).toBe(rawInviteToken);
    expect(room.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(room.inviteUrl).toContain('/join/');
    expectStatus(() => joinQuickRoom(db, host, { code: room.code }, 'Host again'), 400);

    const joined = joinQuickRoom(db, guest, { code: room.code }, 'Guest');
    expect(joined.status).toBe('active');
    expect(joined.matchId).toBeTruthy();
    expectStatus(() => joinQuickRoom(db, other, { code: room.code }, 'Other'), 409);
    const row = getRoom(db, room.id);
    expect(row?.guest_key).toBe(guest.id);
    expect(row?.host_key).not.toBe(row?.guest_key);
    expect(db.prepare('SELECT count(*) AS count FROM matches WHERE room_id = ?').get(room.id))
      .toEqual({ count: 1 });
    expect(roomForSession(db, room.id, guest).matchId).toBe(joined.matchId);
    expectStatus(() => roomForSession(db, room.id, other), 404);
  });

  it('joins by the opaque invite token', () => {
    const room = createQuickRoom(db, session('host'), 'Host');
    const token = room.inviteUrl.split('/join/')[1];
    expect(joinQuickRoom(db, session('guest'), { token }, 'Guest').matchId).toBeTruthy();
  });

  it('returns the original room for a repeated creation request', () => {
    const host = session('host');
    const key = 'a3db6d39-159d-4ff3-965c-d8969bd318e8';
    const first = createQuickRoom(db, host, 'Host', key);
    createQuickRoom(db, host, 'Host');
    createQuickRoom(db, host, 'Host');
    expect(createQuickRoom(db, host, 'Host', key)).toEqual(first);
    expectStatus(() => createQuickRoom(db, host, 'Changed', key), 409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE host_key = ?').get(host.id)).toEqual({ count: 3 });
  });

  it('returns the existing seat and match when a guest retries joining', () => {
    const room = createQuickRoom(db, session('host'), 'Host');
    const guest = session('guest');
    const joined = joinQuickRoom(db, guest, { code: room.code }, 'Guest');
    expect(joinQuickRoom(db, guest, { code: room.code }, 'Guest')).toEqual(joined);
    expect(db.prepare('SELECT COUNT(*) AS count FROM matches WHERE room_id = ?').get(room.id)).toEqual({ count: 1 });
  });

  it('throttles repeated invalid room-code guesses', () => {
    const guesser = session('guesser');
    for (let attempt = 0; attempt < 10; attempt++) {
      expectStatus(() => joinQuickRoom(db, guesser, { code: 'ZZZZZZ' }, 'Guesser'), 404);
    }
    expectStatus(() => joinQuickRoom(db, guesser, { code: 'ZZZZZZ' }, 'Guesser'), 429);
  });
});
