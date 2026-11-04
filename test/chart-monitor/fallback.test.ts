import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilePendingLog, type PendingEntry } from '../../src/chart-monitor/fallback.js';
import { extractSignals } from '../../src/chart-monitor/signals.js';
import { BUY_A, SELL_C } from './support.js';

const entryOf = (signal: ReturnType<typeof extractSignals>[number], announcedAt: string): PendingEntry => ({
  signal,
  announcedAt,
});
const buyA = entryOf(extractSignals(BUY_A)[0]!, '2026-11-04T09:01:00.000Z');
const sellC = entryOf(extractSignals(SELL_C)[0]!, '2026-11-04T09:31:00.000Z');

describe('FilePendingLog', () => {
  let directory: string;
  let path: string;
  let log: FilePendingLog;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chart-monitor-pending-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    path = join(directory, `pending-${Math.random().toString(36).slice(2)}.jsonl`);
    log = new FilePendingLog(path);
  });

  it('reads as empty and does not create the file when nothing was ever appended', async () => {
    expect(await log.read()).toEqual({ entries: [], skipped: 0 });
    expect(existsSync(path)).toBe(false);
  });

  it('creates the file on the first append and reads entries back in order', async () => {
    await log.append(buyA);
    expect(existsSync(path)).toBe(true);
    await log.append(sellC);

    expect(await log.read()).toEqual({ entries: [buyA, sellC], skipped: 0 });
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('removes entries by key and deletes the file once it is empty', async () => {
    await log.append(buyA);
    await log.append(sellC);

    await log.remove(new Set([buyA.signal.key]));
    expect((await log.read()).entries).toEqual([sellC]);
    expect(existsSync(path)).toBe(true);

    await log.remove(new Set([sellC.signal.key]));
    expect(existsSync(path)).toBe(false);
  });

  it('ignores a remove for keys that are not there', async () => {
    await log.append(buyA);
    await log.remove(new Set(['BUY|1.00|2.00']));
    expect((await log.read()).entries).toEqual([buyA]);
  });

  it('skips damaged lines when reading and keeps them when removing', async () => {
    await log.append(buyA);
    await appendFile(path, 'not json at all\n');
    await appendFile(path, `${JSON.stringify({ signal: { key: 'x' }, announcedAt: 'yesterday' })}\n`);

    expect(await log.read()).toEqual({ entries: [buyA], skipped: 2 });

    await log.remove(new Set([buyA.signal.key]));
    expect(await log.read()).toEqual({ entries: [], skipped: 2 });
    expect(await readFile(path, 'utf8')).toContain('not json at all');
  });
});
