import { afterEach, expect, it, vi } from 'vitest';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;
const originalInvitationKey = process.env.INVITATION_ENCRYPTION_KEY;
const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = originalOrigin;
  if (originalInvitationKey === undefined) delete process.env.INVITATION_ENCRYPTION_KEY;
  else process.env.INVITATION_ENCRYPTION_KEY = originalInvitationKey;
  if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
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
  process.env.GOOGLE_CLIENT_ID = 'game.apps.googleusercontent.com';
  vi.resetModules();
  await expect(import('./config')).resolves.toMatchObject({ publicOrigin: 'https://game.example' });
});

it('requires Google OAuth configuration in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://game.example';
  process.env.INVITATION_ENCRYPTION_KEY = 'test-production-encryption-key';
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
  await expect(import('./config')).rejects.toThrow('GOOGLE_CLIENT_ID is required in production');
});
