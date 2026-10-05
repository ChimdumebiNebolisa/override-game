import Database from 'better-sqlite3';

export function createWorkerTestStorage() {
  const sqlite = new Database(':memory:');
  const sql = {
    exec(statement: string, ...bindings: unknown[]) {
      const trimmed = statement.trim();
      if (trimmed.includes(';') || /^CREATE\s|^ALTER\s|^DROP\s|^PRAGMA\s+foreign_keys\s*=/i.test(trimmed)) {
        if (/^PRAGMA\s+foreign_keys\s*=/i.test(trimmed)) sqlite.pragma('foreign_keys = ON');
        else sqlite.exec(statement);
        return cursor([], 0, 0);
      }
      const prepared = sqlite.prepare(statement);
      if (prepared.reader) {
        const rows = prepared.all(...bindings) as unknown[];
        return cursor(rows, rows.length, 0);
      }
      const result = prepared.run(...bindings);
      return cursor([], 0, Number(result.changes));
    },
  };
  let alarm: number | null = null;
  const storage = {
    sql,
    transactionSync<T>(callback: () => T): T { return sqlite.transaction(callback)(); },
    async getAlarm() { return alarm; },
    async setAlarm(timestamp: number) { alarm = timestamp; },
  };
  return { sqlite, storage };
}

function cursor(rows: unknown[], rowsRead: number, rowsWritten: number) {
  let index = 0;
  return {
    rowsRead,
    rowsWritten,
    next() {
      return index < rows.length ? { done: false as const, value: rows[index++] } : { done: true as const, value: undefined };
    },
    toArray() { return rows.slice(); },
  };
}
