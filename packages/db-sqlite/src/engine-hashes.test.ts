import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { imageFromSql } from './testing/image.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
let engine: SnapshotEngine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

/** Three tables of 10,000 rows (the per-table cap) with 300 bytes of text each. */
const BIG = [1, 2, 3]
  .map(
    (n) => `CREATE TABLE t${n} (id INTEGER PRIMARY KEY, a TEXT, b TEXT);
WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 10000)
INSERT INTO t${n} SELECT x, printf('%.150c', 'a') || x, printf('%.150c', 'b') || x FROM c;`,
  )
  .join('\n');

describe('SnapshotEngine hashes budget (L3)', { timeout: 60_000 }, () => {
  it('gives diff hashes their own budget, separate from the query budget', async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER, budgetMs: 1, hashBudgetMs: 20_000 });
    engine.load(await imageFromSql(BIG));
    const hashes = await engine.hashes();
    expect(hashes.tables.map((t) => ('rows' in t ? t.rows.length : t.error.code))).toEqual([
      10_000, 10_000, 10_000,
    ]);
  });

  it('still stops hashes at their own budget', async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER, hashBudgetMs: 1 });
    engine.load(await imageFromSql(BIG));
    await expect(engine.hashes()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('hashes 30,000 rows of text in well under the query budget', async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER });
    engine.load(await imageFromSql(BIG));
    await engine.query('SELECT 1', [], 1);
    const started = performance.now();
    await engine.hashes();
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
