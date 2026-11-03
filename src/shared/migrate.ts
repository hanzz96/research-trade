import type { Db } from './db.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Applies the migrations not recorded yet, in id order, each one in its own transaction. */
export async function runMigrations(db: Db, migrations: readonly Migration[]): Promise<void> {
  const ids = migrations.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`duplicate migration ids: ${ids.join(', ')}`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: number }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.id));

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ]);
    });
  }
}
