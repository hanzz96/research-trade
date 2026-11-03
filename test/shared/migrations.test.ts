import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, migrations } from '../../src/migrations.js';
import { runMigrations } from '../../src/shared/migrate.js';
import { PgliteDb } from '../support/pglite-db.js';

describe('migrations', () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await PgliteDb.create();
  });
  afterAll(async () => {
    await db.close();
  });

  it('keeps ids unique and ascending across features', () => {
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('applies every migration once and is safe to run again', async () => {
    await migrate(db);
    await migrate(db);

    const applied = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations',
    );
    expect(applied.rows[0]?.n).toBe(migrations.length);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'alert_deliveries',
        'bars',
        'schema_migrations',
        'signals',
        'webhook_rejections',
      ]),
    );
  });

  it('refuses a history with duplicate ids', async () => {
    await expect(
      runMigrations(db, [
        { id: 1, name: 'a', sql: 'SELECT 1' },
        { id: 1, name: 'b', sql: 'SELECT 1' },
      ]),
    ).rejects.toThrow(/duplicate migration ids/);
  });
});
