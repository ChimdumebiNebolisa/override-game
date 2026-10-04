import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { openDatabase } from './db';

test('operations report shows failed settlement retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'override-ops-'));
  const path = join(directory, 'game.sqlite');
  try {
    const db = openDatabase(path);
    try {
      db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key,
        player_a_name, player_b_name, state_json, status)
        VALUES ('failed-match', 'ranked', 'a', 'b', 'A', 'B', '{}', 'voided')`).run();
      db.prepare(`INSERT INTO settlement_failures (match_id, attempts, first_failed_at, last_failed_at)
        VALUES ('failed-match', 3, 100, 200)`).run();
      db.prepare(`INSERT INTO settlement_duplicate_attempts (match_id, attempts, first_attempt_at, last_attempt_at)
        VALUES ('failed-match', 2, 300, 400)`).run();
    } finally {
      db.close();
    }
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'server/ops.ts'], {
      cwd: process.cwd(), env: { ...process.env, DB_PATH: path }, encoding: 'utf8',
    });
    const report = JSON.parse(output) as { settlementRetryFailures: unknown[]; duplicateSettlementAttempts: unknown[] };
    assert.deepEqual(report.settlementRetryFailures, [{
      matchId: 'failed-match', attempts: 3, firstFailedAt: 100, lastFailedAt: 200, status: 'voided',
    }]);
    assert.deepEqual(report.duplicateSettlementAttempts, [{
      matchId: 'failed-match', attempts: 2, firstAttemptAt: 300, lastAttemptAt: 400,
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('health reports database failure instead of success', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'override-health-'));
  const path = join(directory, 'game.sqlite');
  const listener = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, DB_PATH: path, PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  try {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`);
        break;
      } catch {
        if (child.exitCode !== null) throw new Error('Server exited before the health check');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, 'server started');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const db = openDatabase(path);
    try { db.exec('DROP TABLE rating_settlements'); }
    finally { db.close(); }

    const failed = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false });
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
