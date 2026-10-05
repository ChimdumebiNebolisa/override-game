import type Database from 'better-sqlite3';

interface SqlCursor {
  rowsRead: number;
  rowsWritten: number;
  next(): IteratorResult<unknown>;
  toArray(): unknown[];
}

interface SqlStorage {
  exec(sql: string, ...bindings: unknown[]): SqlCursor;
}

interface TransactionStorage {
  transactionSync<T>(callback: () => T): T;
}

interface WorkerStatement {
  get(...bindings: unknown[]): unknown;
  all(...bindings: unknown[]): unknown[];
  run(...bindings: unknown[]): { changes: number };
}

/** Synchronous better-sqlite3 subset backed by a SQLite Durable Object. */
export class WorkerSqliteDatabase {
  private transactionDepth = 0;
  private readRows = 0;
  private writtenRows = 0;

  constructor(private readonly sql: SqlStorage, private readonly storage: TransactionStorage) {}

  pragma(statement: string): unknown[] {
    if (statement.startsWith('journal_mode') || statement.startsWith('busy_timeout')) return [];
    return this.sql.exec(`PRAGMA ${statement}`).toArray();
  }

  exec(statement: string): this {
    this.sql.exec(statement);
    return this;
  }

  prepare(statement: string): WorkerStatement {
    return {
      get: (...bindings) => {
        const cursor = this.sql.exec(statement, ...bindings);
        const row = cursor.next();
        this.readRows += cursor.rowsRead;
        this.writtenRows += cursor.rowsWritten;
        return row.done ? undefined : row.value;
      },
      all: (...bindings) => {
        const cursor = this.sql.exec(statement, ...bindings);
        const rows = cursor.toArray();
        this.readRows += cursor.rowsRead;
        this.writtenRows += cursor.rowsWritten;
        return rows;
      },
      run: (...bindings) => {
        const cursor = this.sql.exec(statement, ...bindings);
        this.writtenRows += cursor.rowsWritten;
        const result = this.sql.exec('SELECT changes() AS changes').toArray()[0] as { changes: number } | undefined;
        this.readRows += 1;
        return { changes: result?.changes ?? cursor.rowsWritten };
      },
    };
  }

  transaction<T>(callback: () => T): (() => T) & { immediate: () => T } {
    const run = () => {
      if (this.transactionDepth > 0) return callback();
      return this.storage.transactionSync(() => {
        this.transactionDepth++;
        try { return callback(); }
        finally { this.transactionDepth--; }
      });
    };
    return Object.assign(run, { immediate: run });
  }

  close(): void {
    // Durable Object storage remains open for the lifetime of the instance.
  }

  takeUsage(): { rowsRead: number; rowsWritten: number } {
    const usage = { rowsRead: this.readRows, rowsWritten: this.writtenRows };
    this.readRows = 0;
    this.writtenRows = 0;
    return usage;
  }
}

export function asDomainDatabase(database: WorkerSqliteDatabase): Database.Database {
  return database as unknown as Database.Database;
}
