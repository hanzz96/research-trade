import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from '../../src/shared/db.js';

interface Runner {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

/** `Db` implementation backed by PGlite: a real in-process PostgreSQL, so tests need no server. */
export class PgliteDb implements Db {
  private constructor(
    private readonly runner: Runner,
    private readonly root?: PGlite,
  ) {}

  static async create(): Promise<PgliteDb> {
    const pglite = new PGlite();
    await pglite.waitReady;
    return new PgliteDb(pglite, pglite);
  }

  async query<R extends object>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const result = await this.runner.query(text, params);
    return { rows: result.rows as R[], rowCount: result.affectedRows ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.runner.exec(sql);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Inside a transaction already: reuse it.
    if (!this.root) return fn(this);
    return this.root.transaction((tx) => fn(new PgliteDb(tx)));
  }

  async close(): Promise<void> {
    await this.root?.close();
  }
}
