import type { Db } from './db.js';

/**
 * Records why an inbound request was refused. Never pass a request body or any secret here.
 * The table name is historical (it was created with the alert feature) but every inbound
 * endpoint shares it, so reasons are prefixed by the feature, e.g. `ingest_unauthorized`.
 */
export class RejectionLog {
  constructor(private readonly db: Db) {}

  async record(reason: string, detail?: string): Promise<void> {
    await this.db.query('INSERT INTO webhook_rejections (reason, detail) VALUES ($1, $2)', [
      reason,
      detail ?? null,
    ]);
  }
}
