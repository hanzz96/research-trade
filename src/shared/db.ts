import pg from 'pg';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** Minimal async database surface the app depends on (implemented by pg here and PGlite in tests). */
export interface Db {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  /** Runs one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgTransaction implements Db {
  constructor(private readonly client: pg.PoolClient) {}

  async query<R extends object>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const result = await this.client.query(text, params);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  // Already inside a transaction: reuse it instead of nesting.
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    // An idle client erroring must not crash the process.
    this.pool.on('error', (err) => {
      console.error('postgres pool error:', err.message);
    });
  }

  async query<R extends object>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const result = await this.pool.query(text, params);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
