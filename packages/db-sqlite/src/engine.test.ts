import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';
import { mergeWal } from './wal.js';

// The real worker runs from the build, like sql-guard's.
const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
let engine: SnapshotEngine | undefined;

function make(budgetMs = 5000): SnapshotEngine {
  engine = new SnapshotEngine({ workerUrl: BUILT_WORKER, budgetMs });
  return engine;
}

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

describe('SnapshotEngine', { timeout: 20_000 }, () => {
  it('opens an image in a worker and serves schema, queries, hashes and rows', async () => {
    const e = make();
    e.load(mergeWal(walDbFixture(), walFixture(), 1e9));
    const { tables, sqlSchema } = await e.schema();
    expect(tables.map((t) => t.name)).toContain('orders');
    expect(sqlSchema.length).toBeGreaterThan(3);
    expect((await e.query('SELECT item FROM orders ORDER BY id', [], 10)).rows).toEqual([
      ['Coffee'],
      ['Tea'],
      ['Cake'],
    ]);
    expect((await e.hashes()).tables.map((t) => t.name)).toEqual(['lines', 'orders', 'raw']);
    expect((await e.rowsByKey('orders', [2])).rows).toEqual([
      [2, [2, 'Tea', 'pending', 1760000001000]],
    ]);
  });

  it('stops a runaway query at its budget, then answers again from the same copy', async () => {
    const e = make(300);
    e.load(plainDbFixture());
    const started = Date.now();
    await expect(
      e.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        [],
        1,
      ),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: 'That query took too long and was stopped.',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await e.query('SELECT count(*) FROM orders', [], 1)).rows).toEqual([[2]]);
  });

  it('refuses huge values instead of running out of memory', async () => {
    const e = make();
    e.load(plainDbFixture());
    for (const sql of [
      'SELECT randomblob(1000000000)',
      'SELECT zeroblob(1000000000)',
      "SELECT printf('%.*c', 1000000000, 'x')",
    ]) {
      await expect(e.query(sql, [], 1), sql).rejects.toMatchObject({ code: 'sql-error' });
    }
  });

  it('passes on refusals and SQL errors as DbErrors', async () => {
    const e = make();
    e.load(plainDbFixture());
    await expect(e.query('DELETE FROM orders', [], 1)).rejects.toMatchObject({ code: 'refused' });
    await expect(e.query('SELECT nope', [], 1)).rejects.toMatchObject({ code: 'sql-error' });
  });

  it('refuses calls before a copy is loaded and after close', async () => {
    const e = make();
    await expect(e.schema()).rejects.toMatchObject({ code: 'internal' });
    e.load(plainDbFixture());
    await e.close();
    await expect(e.schema()).rejects.toMatchObject({ code: 'internal' });
  });

  it('refuses a file that is not a database', async () => {
    const e = make();
    e.load(Buffer.from('SQLite format 3\0'.padEnd(4096, 'x')));
    await expect(e.schema()).rejects.toMatchObject({ code: 'unsupported' });
  });
});
