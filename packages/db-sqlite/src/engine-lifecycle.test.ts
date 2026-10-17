/**
 * Tester probes for the snapshot engine's worker lifecycle (design note, Privacy: the
 * copy lives in daemon memory only and is dropped on close; S2: a runaway read stops).
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { plainDbFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const engines: SnapshotEngine[] = [];

function make(budgetMs = 5000): SnapshotEngine {
  const e = new SnapshotEngine({ workerUrl: BUILT_WORKER, budgetMs });
  engines.push(e);
  return e;
}

/** The engine's live worker, if any (private state, read for the leak check only). */
const workerOf = (e: SnapshotEngine): Worker | undefined =>
  Reflect.get(e, 'worker') as Worker | undefined;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()));
});

describe('SnapshotEngine lifecycle', { timeout: 30_000 }, () => {
  it('DB-5: leaves no worker behind when closed while the worker is still starting', async () => {
    const e = make();
    e.load(plainDbFixture());
    const pending = e.query('SELECT count(*) FROM orders', [], 10).then(
      () => 'answered after close',
      (err: unknown) => (err as { code?: string }).code,
    );
    // Let the call pass its "is a copy open" check and start the worker, then close.
    await tick(20);
    await e.close();
    const outcome = await pending;
    await tick(50);
    expect(workerOf(e), 'a worker holding the copy is still running').toBeUndefined();
    expect(outcome).not.toBe('answered after close');
  });

  it('refuses calls made after close and starts no worker for them', async () => {
    const e = make();
    e.load(plainDbFixture());
    await e.close();
    await expect(e.query('SELECT 1', [], 1)).rejects.toMatchObject({ code: 'internal' });
    expect(workerOf(e)).toBeUndefined();
  });

  it('stops each of several runaway queries in a row, and still answers afterwards', async () => {
    const e = make(300);
    e.load(plainDbFixture());
    const runaway =
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r';
    for (let i = 0; i < 3; i++) {
      await expect(e.query(runaway, [], 1)).rejects.toMatchObject({
        code: 'timeout',
        message: 'That query took too long and was stopped.',
      });
    }
    expect((await e.query('SELECT count(*) FROM orders', [], 1)).rows).toEqual([[2]]);
  });

  it('answers queued calls in order after a runaway query is stopped', async () => {
    const e = make(300);
    e.load(plainDbFixture());
    const runaway = e.query(
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT max(n) FROM r',
      [],
      1,
    );
    const next = e.query('SELECT item FROM orders ORDER BY id', [], 10);
    await expect(runaway).rejects.toMatchObject({ code: 'timeout' });
    expect((await next).rows).toEqual([['Coffee'], ['Tea']]);
  });

  it('refuses a write even when it reaches the engine (second, independent check)', async () => {
    const e = make();
    e.load(plainDbFixture());
    for (const sql of [
      "UPDATE orders SET item = 'x'",
      'DELETE FROM orders',
      "ATTACH 'x.db' AS x",
      "VACUUM INTO 'copy.db'",
    ]) {
      await expect(e.query(sql, [], 1), sql).rejects.toMatchObject({
        code: expect.stringMatching(/^(refused|sql-error)$/) as unknown,
      });
    }
    expect((await e.query('SELECT count(*) FROM orders', [], 1)).rows).toEqual([[2]]);
  });

  it.fails(
    'DB-9: refuses PRAGMA assignments and transaction control as the second check (ADR 0005, S4)',
    async () => {
      const e = make();
      e.load(plainDbFixture());
      const accepted: string[] = [];
      for (const sql of ['PRAGMA query_only = 0', 'PRAGMA writable_schema = 1', 'BEGIN']) {
        const ok = await e.query(sql, [], 1).then(
          () => true,
          () => false,
        );
        if (ok) accepted.push(sql);
      }
      expect(accepted).toEqual([]);
    },
  );

  it('caps a 1 GB value with the length limit, so the worker survives', async () => {
    const e = make();
    e.load(plainDbFixture());
    await expect(
      e.query("SELECT length(replace(hex(zeroblob(20000000)), '0', 'ab'))", [], 1),
    ).rejects.toMatchObject({ code: 'sql-error' });
    expect((await e.query('SELECT 1', [], 1)).rows).toEqual([[1]]);
  });
});
