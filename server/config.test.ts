import { afterEach, expect, it, vi } from 'vitest';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;
const originalInvitationKey = process.env.INVITATION_ENCRYPTION_KEY;
const originalFirebaseWeb = process.env.FIREBASE_WEB_CONFIG;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = originalOrigin;
  if (originalInvitationKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
  else process.env.INVITATION_ENCRYPTION_KEY = originalInvitationKey;
  if (originalFirebaseWeb === undefined) delete process.env.FIREBASE_WEB_CONFIG;
  else process.env.FIREBASE_WEB_CONFIG = originalFirebaseWeb;
  vi.resetModules();
});

it('requires an explicit public origin in production', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.PUBLIC_ORIGIN;
  vi.resetModules();
  await expect(import('./config')).rejects.toThrow('PUBLIC_ORIGIN is required in production');
});

it('rejects an HTTP public origin in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'http://game.example';
  vi.resetModules();
  await expect(import('./config')).rejects.toThrow('PUBLIC_ORIGIN must use HTTPS in production');
});

it('accepts an explicit HTTPS public origin in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://game.example';
  process.env.INVITATION_ENCRYPTION_KEY = 'test-production-encryption-key';
  process.env.FIREBASE_WEB_CONFIG = '{"apiKey":"test","authDomain":"test.firebaseapp.com","projectId":"test","appId":"test"}';
  vi.resetModules();
  await expect(import('./config')).resolves.toMatchObject({ publicOrigin: 'https://game.example' });
});

it('requires Firebase Authentication configuration in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://game.example';
  process.env.INVITATION_ENCRYPTION_KEY = 'test-production-encryption-key';
  delete process.env.FIREBASE_WEB_CONFIG;
  vi.resetModules();
  await expect(import('./config')).rejects.toThrow('FIREBASE_WEB_CONFIG is required in production');
});

it('does not require private Firebase Admin credentials in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://game.example';
  process.env.INVITATION_ENCRYPTION_KEY = 'test-production-encryption-key';
  process.env.FIREBASE_WEB_CONFIG = '{"apiKey":"test","authDomain":"test.firebaseapp.com","projectId":"test","appId":"test"}';
  vi.resetModules();
  await expect(import('./config')).resolves.toMatchObject({ publicOrigin: 'https://game.example' });
});
