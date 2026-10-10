import type Database from 'better-sqlite3';

interface SqlCursor {
  rowsRead: number;
  rowsWritten: number;
  next(): IteratorResult<unknown>;
  toArray(): unknown[];
}

type SqlBinding = string | number | null | ArrayBuffer;

interface SqlStorage {
  exec(sql: string, ...bindings: SqlBinding[]): SqlCursor;
}

interface TransactionStorage {
  transactionSync<T>(callback: () => T): T;
}

interface WorkerStatement {
  get(...bindings: SqlBinding[]): unknown;
  all(...bindings: SqlBinding[]): unknown[];
  run(...bindings: SqlBinding[]): { changes: number };
}

/** Synchronous better-sqlite3 subset backed by a SQLite Durable Object. */
export class WorkerSqliteDatabase {
  private transactionDepth = 0;
  private readRows = 0;
  private writtenRows = 0;

  constructor(private readonly sql: SqlStorage, private readonly storage: TransactionStorage) {}

  pragma(statement: string): unknown[] {
    if (statement.startsWith('journal_mode') || statement.startsWith('busy_timeout')) return [];
    return this.consume(this.sql.exec(`PRAGMA ${statement}`));
  }

  exec(statement: string): this {
    this.consume(this.sql.exec(statement));
    return this;
  }

  prepare(statement: string): WorkerStatement {
    return {
      get: (...bindings) => {
        return this.consume(this.sql.exec(statement, ...bindings))[0];
      },
      all: (...bindings) => {
        return this.consume(this.sql.exec(statement, ...bindings));
      },
      run: (...bindings) => {
        const cursor = this.sql.exec(statement, ...bindings);
        this.consume(cursor);
        const result = this.consume(this.sql.exec('SELECT changes() AS changes'))[0] as { changes: number } | undefined;
        return { changes: result?.changes ?? cursor.rowsWritten };
      },
    };
  }

  private consume(cursor: SqlCursor): unknown[] {
    const rows = cursor.toArray();
    this.readRows += cursor.rowsRead;
    this.writtenRows += cursor.rowsWritten;
    return rows;
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
