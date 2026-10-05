import Database from 'better-sqlite3';
import { initializeDatabase } from './schema-initializer.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const databasePath = process.env.DB_PATH ?? resolve('data/override.sqlite');

export function openDatabase(path = databasePath): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  return initializeDatabase(db);
}
