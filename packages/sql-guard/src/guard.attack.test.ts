/** Tester probes of the guard's worker handling: crashes, timeouts, close and order. */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlGuard, SqlGuardOptions } from './guard.js';
import { createSqlGuard } from './guard.js';
import type { GuardResult } from './types.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const SCRIPTED = new URL('./testing/scripted-worker.mjs', import.meta.url);
const schemaSql = ['CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT)'];
const read = { schemaSql, mode: 'read' } as const;

let guard: SqlGuard | undefined;
afterEach(async () => {
  await guard?.close();
  guard = undefined;
});

function make(opts: SqlGuardOptions): SqlGuard {
  guard = createSqlGuard(opts);
  return guard;
}

const tablesOf = (r: GuardResult) => (r.ok ? r.tables : r.code);

describe('createSqlGuard under stress', () => {
  it('answers the next check from a fresh worker right after a timeout', async () => {
    const g = make({ workerUrl: SCRIPTED, checkTimeoutMs: 50 });
    expect(await g.check('HANG', read)).toMatchObject({ ok: false, code: 'timeout' });
    expect(tablesOf(await g.check('after', read))).toEqual(['after']);
  });

  it('answers the checks queued behind a hung one, each with its own verdict', async () => {
    const g = make({ workerUrl: SCRIPTED, checkTimeoutMs: 50 });
    const results = await Promise.all(['a', 'HANG', 'b', 'c'].map((sql) => g.check(sql, read)));
    expect(results.map(tablesOf)).toEqual([['a'], 'timeout', ['b'], ['c']]);
  });

  it('refuses a check whose worker crashes mid-check, then recovers', async () => {
    const g = make({ workerUrl: SCRIPTED });
    expect(await g.check('CRASH', read)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(tablesOf(await g.check('next', read))).toEqual(['next']);
  });

  it('never takes a late answer from a timed-out worker as the next verdict', async () => {
    const g = make({ workerUrl: SCRIPTED, checkTimeoutMs: 50 });
    expect(await g.check('LATE', read)).toMatchObject({ ok: false, code: 'timeout' });
    const next = g.check('second', read);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(tablesOf(await next)).toEqual(['second']);
  });

  it('settles a pending check and the queue behind it when closed', async () => {
    const g = make({ workerUrl: SCRIPTED, checkTimeoutMs: 60_000 });
    const pending = g.check('HANG', read);
    const queued = g.check('queued', read);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await g.close();
    expect(await pending).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await queued).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('settles a check started while the worker is still starting, when closed', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    const pending = g.check('SELECT 1', read);
    await g.close();
    expect(await pending).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('keeps each verdict tied to its own schema when schemas alternate', async () => {
    const g = make({ workerUrl: BUILT_WORKER, maxSchemas: 1 });
    const other = ['CREATE TABLE things(id INTEGER PRIMARY KEY)'];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        g.check('SELECT id FROM orders', {
          schemaSql: i % 2 === 0 ? schemaSql : other,
          mode: 'read',
        }),
      ),
    );
    expect(results.map((r) => r.ok)).toEqual(Array.from({ length: 10 }, (_, i) => i % 2 === 0));
  });

  it('applies hidden columns and write mode through the real worker', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    const hiddenColumns = [{ table: 'orders', column: 'status' }];
    expect(await g.check('SELECT * FROM orders', { ...read, hiddenColumns })).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
    expect(
      await g.check("UPDATE orders SET status = 'x'", { schemaSql, mode: 'write' }),
    ).toMatchObject({
      ok: true,
      kind: 'write',
    });
    expect(await g.check('DROP TABLE orders', { schemaSql, mode: 'write' })).toMatchObject({
      ok: false,
      code: 'not-an-edit',
    });
  });

  it('refuses over-long SQL in bytes before it reaches the worker', async () => {
    const g = make({ workerUrl: SCRIPTED });
    expect(await g.check(`SELECT '${'é'.repeat(50_000)}'`, read)).toMatchObject({
      ok: false,
      code: 'too-long',
    });
  });
});
