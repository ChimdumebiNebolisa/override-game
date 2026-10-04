import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './db.js';
import { acceptRankedChallenge, acceptRankedChallengeByCode } from './invitations.js';

const data = workerData as { path: string; method: 'token' | 'code'; value: string; uid: string; now: number };
const db = openDatabase(data.path);
try {
  const shell = data.method === 'token'
    ? acceptRankedChallenge(db, data.value, data.uid, data.now)
    : acceptRankedChallengeByCode(db, data.value, data.uid, data.now);
  parentPort?.postMessage({ ok: true, matchId: shell.matchId });
} catch (error) {
  parentPort?.postMessage({ ok: false, status: typeof error === 'object' && error && 'status' in error ? error.status : null });
} finally {
  db.close();
}
