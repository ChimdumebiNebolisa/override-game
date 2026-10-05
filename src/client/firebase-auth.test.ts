import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getApp: vi.fn(() => ({ name: 'app' })),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: 'app' })),
  getAuth: vi.fn(() => ({ name: 'auth' })),
  GoogleAuthProvider: vi.fn(function GoogleAuthProvider() { return { name: 'google' }; }),
  signInWithRedirect: vi.fn(async () => undefined),
  getRedirectResult: vi.fn(async () => ({ user: { getIdToken: async () => 'firebase-id-token' } })),
}));

vi.mock('firebase/app', () => ({ getApp: mocks.getApp, getApps: mocks.getApps, initializeApp: mocks.initializeApp }));
vi.mock('firebase/auth', () => ({
  getAuth: mocks.getAuth,
  GoogleAuthProvider: mocks.GoogleAuthProvider,
  signInWithRedirect: mocks.signInWithRedirect,
  getRedirectResult: mocks.getRedirectResult,
}));

const originalWindow = globalThis.window;

beforeEach(() => {
  mocks.getApps.mockReturnValue([]);
  mocks.initializeApp.mockClear();
  mocks.getAuth.mockClear();
  mocks.signInWithRedirect.mockClear();
  mocks.getRedirectResult.mockClear();
  const location = { href: 'https://override-game.example/ranked/challenge/secret?from=friend#arena' };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location, history: { replaceState: vi.fn((_state, _title, next) => { location.href = new URL(String(next), location.href).href; }) } },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

it('starts redirect sign-in without dropping a Ranked invite or its return destination', async () => {
  const { beginGoogleFirebaseSignIn } = await import('./firebase-auth');
  await beginGoogleFirebaseSignIn({ apiKey: 'key', authDomain: 'game.example', projectId: 'game', appId: 'app' }, 'ranked');

  expect(window.location.href).toBe('https://override-game.example/ranked/challenge/secret?from=friend&overrideAuthReturn=ranked#arena');
  expect(mocks.signInWithRedirect).toHaveBeenCalledOnce();
});

it('completes redirect sign-in as a Firebase ID token for the shared account-binding flow', async () => {
  const { completeGoogleFirebaseRedirect } = await import('./firebase-auth');
  const config = { apiKey: 'key', authDomain: 'game.example', projectId: 'game', appId: 'app' };

  await expect(completeGoogleFirebaseRedirect(config)).resolves.toBe('firebase-id-token');
  expect(mocks.getRedirectResult).toHaveBeenCalledOnce();
  expect(mocks.getAuth).toHaveBeenCalledOnce();
});

it('removes only its return marker after redirect processing', async () => {
  const { clearGoogleAuthReturnFromLocation } = await import('./firebase-auth');
  clearGoogleAuthReturnFromLocation();
  expect(window.location.href).toBe('https://override-game.example/ranked/challenge/secret?from=friend#arena');
});
