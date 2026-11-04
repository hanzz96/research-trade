import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

/** Remembered signal keys beyond this many are dropped, oldest first. */
export const MAX_SEEN = 200;

const stateSchema = z.object({
  /** False until the first successful read, which only records what is already on the chart. */
  baselined: z.boolean(),
  seen: z.array(z.string()),
  /** Consecutive failed checks, and whether a "monitor is down" notice has been sent for them. */
  failures: z.number().int().min(0),
  alerted: z.boolean(),
});

export type MonitorState = z.infer<typeof stateSchema>;

export const emptyState = (): MonitorState => ({
  baselined: false,
  seen: [],
  failures: 0,
  alerted: false,
});

export interface StateStore {
  load(): Promise<MonitorState>;
  save(state: MonitorState): Promise<void>;
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MonitorState> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
    // A damaged file must not silently reset: that would re-announce every old signal.
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`state file ${this.path} is not valid; delete it to start over`);
    return parsed.data;
  }

  async save(state: MonitorState): Promise<void> {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, this.path);
  }
}
