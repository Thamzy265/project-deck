import { describe, expect, it } from 'vitest';
import type { SqlGuard } from '../guard.js';
import { FakeSqlGuard } from './index.js';

const opts = { schemaSql: ['CREATE TABLE t(a)'], mode: 'read' } as const;

describe('FakeSqlGuard', () => {
  it('passes anything by default and records each call', async () => {
    const guard: SqlGuard = new FakeSqlGuard();
    expect(await guard.check('SELECT a FROM t', opts)).toEqual({
      ok: true,
      kind: 'select',
      tables: [],
      functions: [],
      recursive: false,
    });
    expect((guard as FakeSqlGuard).calls).toEqual([{ sql: 'SELECT a FROM t', opts }]);
  });

  it('passes a plain edit of one table in write mode and names it as written', async () => {
    const guard = new FakeSqlGuard();
    const write = { ...opts, mode: 'write' } as const;
    expect(await guard.check('UPDATE "t" SET a = 1', write)).toEqual({
      ok: true,
      kind: 'write',
      tables: ['t'],
      written: ['t'],
      functions: [],
      recursive: false,
    });
    expect(await guard.check('SELECT a FROM t', write)).toMatchObject({
      ok: false,
      code: 'not-an-edit',
    });
  });

  it('answers programmed refusals and verdicts for exact SQL', async () => {
    const guard = new FakeSqlGuard()
      .refuse('DELETE FROM t', 'writes-data', 'Only reading is allowed here.')
      .answer('UPDATE t SET a = 1', {
        ok: true,
        kind: 'write',
        tables: ['t'],
        functions: [],
        recursive: false,
      });
    expect(await guard.check('DELETE FROM t', opts)).toEqual({
      ok: false,
      code: 'writes-data',
      reason: 'Only reading is allowed here.',
    });
    expect(await guard.check('UPDATE t SET a = 1', opts)).toMatchObject({ kind: 'write' });
  });

  it('takes a fallback for everything else, and refuses after close', async () => {
    const guard = new FakeSqlGuard(() => ({ ok: false, code: 'timeout', reason: 'slow' }));
    expect(await guard.check('SELECT 1', opts)).toMatchObject({ code: 'timeout' });
    await guard.close();
    expect(guard.closed).toBe(true);
    expect(await guard.check('SELECT 1', opts)).toMatchObject({ code: 'unavailable' });
  });
});
