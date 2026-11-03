import { alertsMigrations } from './alerts/migrations.js';
import { forwardTestMigrations } from './forward-test/migrations.js';
import type { Db } from './shared/db.js';
import { runMigrations, type Migration } from './shared/migrate.js';

/** One global, ordered history: ids are unique across features and never reused. */
export const migrations: Migration[] = [...alertsMigrations, ...forwardTestMigrations].sort(
  (a, b) => a.id - b.id,
);

export const migrate = (db: Db): Promise<void> => runMigrations(db, migrations);
