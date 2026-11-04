import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ChartSignal } from './signals.js';

/** A signal whose Discord message went out but whose database record failed. */
export interface PendingEntry {
  signal: ChartSignal;
  /** When the message was sent; becomes created_at once the entry reaches the database. */
  announcedAt: string;
}

export interface PendingLog {
  /** Valid entries, plus how many damaged lines were skipped. */
  read(): Promise<{ entries: PendingEntry[]; skipped: number }>;
  append(entry: PendingEntry): Promise<void>;
  /** Drops the entries with these keys. Damaged lines are kept so nothing is lost silently. */
  remove(keys: ReadonlySet<string>): Promise<void>;
}

const entrySchema = z.object({
  signal: z.object({
    direction: z.enum(['BUY', 'SELL']),
    entry: z.number().nullable(),
    stop: z.number(),
    target: z.number(),
    hit: z.enum(['SL', 'TP']).nullable(),
    key: z.string().min(1),
  }),
  announcedAt: z.iso.datetime(),
});

function parseLine(line: string): PendingEntry | null {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Safety net for the database: one JSON object per line. The file only exists while at least one
 * announced signal is waiting to be copied into PostgreSQL.
 */
export class FilePendingLog implements PendingLog {
  constructor(private readonly path: string) {}

  private async lines(): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return text.split('\n').filter((line) => line.trim() !== '');
  }

  async read(): Promise<{ entries: PendingEntry[]; skipped: number }> {
    const entries: PendingEntry[] = [];
    let skipped = 0;
    for (const line of await this.lines()) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
      else skipped += 1;
    }
    return { entries, skipped };
  }

  async append(entry: PendingEntry): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }

  async remove(keys: ReadonlySet<string>): Promise<void> {
    const kept = (await this.lines()).filter((line) => {
      const entry = parseLine(line);
      return !entry || !keys.has(entry.signal.key);
    });
    if (kept.length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${kept.join('\n')}\n`);
    await rename(temporary, this.path);
  }
}
