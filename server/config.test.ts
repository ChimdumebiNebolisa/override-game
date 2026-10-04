import { afterEach, expect, it, vi } from 'vitest';

const originalEnvironment = process.env.NODE_ENV;
const originalOrigin = process.env.PUBLIC_ORIGIN;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = originalOrigin;
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
  vi.resetModules();
  await expect(import('./config')).resolves.toMatchObject({ publicOrigin: 'https://game.example' });
});
