import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { databasePath, openDatabase } from './db';

const source = resolve(databasePath);
const destination = resolve(process.argv[2] ?? join(dirname(source), 'backups',
  `override-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
if (!existsSync(source)) throw new Error(`Database does not exist: ${source}`);
if (source === destination || existsSync(destination)) throw new Error('Choose a new backup destination');
mkdirSync(dirname(destination), { recursive: true });
const db = openDatabase(source);
try {
  await db.backup(destination);
} finally {
  db.close();
}
const backup = new Database(destination, { readonly: true });
try {
  const integrity = backup.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${String(integrity)}`);
  process.stdout.write(`${destination}\n`);
} finally {
  backup.close();
}
