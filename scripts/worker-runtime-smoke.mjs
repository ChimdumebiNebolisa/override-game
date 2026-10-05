import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

if (process.platform !== 'linux') {
  console.error('The Wrangler Worker runtime smoke test is intended for Linux CI.');
  process.exit(2);
}

const root = process.cwd();
const persistPath = mkdtempSync(join(tmpdir(), 'override-worker-runtime-'));
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let child;
let childExit;
let logs = '';

function remember(chunk) {
  logs = `${logs}${chunk}`.slice(-12_000);
}

function startWorker() {
  child = spawn(process.execPath, [
    wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', '0', '--persist-to', persistPath, '--log-level', 'error',
    '--var', `PUBLIC_ORIGIN:${origin}`,
    '--var', 'INVITATION_ENCRYPTION_KEY:ci-runtime-smoke-only-key-0123456789abcdef',
  ], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  childExit = once(child, 'exit');
}

async function stopWorker() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  const exited = await Promise.race([childExit.then(() => true), delay(5_000).then(() => false)]);
  if (!exited) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group already exited. */ }
    await childExit;
  }
}

async function waitForHealth() {
  const end = Date.now() + 60_000;
  let lastError;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${logs}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status === 200) return;
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(500);
  }
  throw new Error(`Wrangler did not become healthy: ${String(lastError)}\n${logs}`);
}

async function request(path, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') {
    headers.origin = origin;
    headers['x-requested-with'] = 'override-game';
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data };
}

function sessionCookie(response) {
  const value = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!value) throw new Error('Worker did not issue a session cookie');
  return value;
}

function openRoomSocket(roomId, cookie) {
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/live?roomId=${encodeURIComponent(roomId)}`, {
    headers: { Cookie: cookie, Origin: origin },
  });
  socket.runtimeMessages = [];
  socket.on('message', (raw) => {
    try { socket.runtimeMessages.push(JSON.parse(String(raw))); } catch { /* Ignore non-JSON socket messages. */ }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open')), 8_000);
    socket.once('open', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function nextMessage(socket, predicate, afterIndex = 0, timeoutMs = 8_000) {
  const existing = socket.runtimeMessages.slice(afterIndex).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Expected WebSocket presence update did not arrive')); }, timeoutMs);
    const handler = (raw) => {
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }
      if (!predicate(data)) return;
      cleanup();
      resolve(data);
    };
    const cleanup = () => { clearTimeout(timer); socket.off('message', handler); };
    socket.on('message', handler);
  });
}

async function smoke() {
  startWorker();
  await waitForHealth();

  const firstSession = await request('/api/session');
  if (firstSession.response.status !== 200) throw new Error('Worker session creation failed');
  const hostCookie = sessionCookie(firstSession.response);
  const guestSession = await request('/api/session');
  if (guestSession.response.status !== 200) throw new Error('Second Worker session creation failed');
  const guestCookie = sessionCookie(guestSession.response);

  const roomResult = await request('/api/rooms', {
    method: 'POST', cookie: hostCookie,
    body: { displayName: 'Runtime host', creationKey: crypto.randomUUID() },
  });
  if (roomResult.response.status !== 201) throw new Error(`Room creation failed: ${JSON.stringify(roomResult.data)}`);
  const room = roomResult.data.room;
  const hostSocket = await openRoomSocket(room.id, hostCookie);
  await nextMessage(hostSocket, (message) => message.roomId === room.id);
  const hostMessageCount = hostSocket.runtimeMessages.length;
  const nextHostUpdate = nextMessage(hostSocket, (message) => message.roomId === room.id, hostMessageCount);
  const joined = await request('/api/rooms/join', {
    method: 'POST', cookie: guestCookie,
    body: { code: room.code, displayName: 'Runtime guest' },
  });
  if (joined.response.status !== 200) throw new Error(`Room join failed: ${JSON.stringify(joined.data)}`);
  const update = await nextHostUpdate;
  if (!update.roomId) throw new Error('Room WebSocket did not receive the joined-player update');
  const guestSocket = await openRoomSocket(room.id, guestCookie);
  await nextMessage(guestSocket, (message) => message.roomId === room.id);

  const matchResult = await request('/api/bot-matches', {
    method: 'POST', cookie: hostCookie,
    body: { mode: 'practice', difficulty: 'easy', displayName: 'Runtime host', creationKey: crypto.randomUUID() },
  });
  if (matchResult.response.status !== 201) throw new Error(`Match creation failed: ${JSON.stringify(matchResult.data)}`);
  const matchId = matchResult.data.match.id;
  hostSocket.close();
  guestSocket.close();

  await stopWorker();
  startWorker();
  await waitForHealth();
  const resumedSession = await request('/api/session', { cookie: hostCookie });
  if (resumedSession.response.status !== 200 || resumedSession.response.headers.has('set-cookie')) {
    throw new Error('Worker session did not persist across restart');
  }

  const deadline = Date.now() + 12_000;
  let resumedMatch;
  while (Date.now() < deadline) {
    const result = await request(`/api/matches/${encodeURIComponent(matchId)}`, { cookie: hostCookie });
    if (result.response.status !== 200) throw new Error(`Persisted match could not be read: ${JSON.stringify(result.data)}`);
    resumedMatch = result.data.match;
    if (resumedMatch.state.round >= 2) break;
    await delay(500);
  }
  if (resumedMatch?.state.round < 2) throw new Error('Worker alarm did not advance the persisted match deadline');
  console.log('Wrangler Worker runtime smoke passed: session restart, SQLite migrations, alarm deadline, room sockets, and match persistence.');
}

try {
  await smoke();
} catch (error) {
  console.error(`${error instanceof Error ? error.stack : String(error)}\nWrangler output:\n${logs}`);
  process.exitCode = 1;
} finally {
  await stopWorker();
  rmSync(persistPath, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port');
  server.close();
  await once(server, 'close');
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
