import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlGuard, SqlGuardOptions } from './guard.js';
import { createSqlGuard } from './guard.js';

// The real worker runs from the build, like the other packages' process tests.
const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const fixture = (mode: string) => new URL(`./testing/${mode}-worker.mjs`, import.meta.url);
const schemaSql = ['CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT)'];

let guard: SqlGuard | undefined;
afterEach(async () => {
  await guard?.close();
  guard = undefined;
});

function make(opts: SqlGuardOptions): SqlGuard {
  guard = createSqlGuard(opts);
  return guard;
}

describe('createSqlGuard', () => {
  it('judges statements in its worker', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    expect(await g.check('SELECT * FROM orders', { schemaSql, mode: 'read' })).toMatchObject({
      ok: true,
      kind: 'select',
    });
    expect(await g.check('DELETE FROM orders', { schemaSql, mode: 'read' })).toMatchObject({
      ok: false,
      code: 'writes-data',
    });
    expect(
      await g.check('SELECT status FROM orders', {
        schemaSql,
        mode: 'read',
        hiddenColumns: [{ table: 'orders', column: 'status' }],
      }),
    ).toMatchObject({ ok: false, code: 'hidden-column' });
  });

  it('answers concurrent checks each with its own verdict', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    const sqls = ['SELECT 1', 'DELETE FROM orders', 'SELECT id FROM orders', 'BEGIN'];
    const results = await Promise.all(sqls.map((sql) => g.check(sql, { schemaSql, mode: 'read' })));
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false]);
  });

  it('refuses too-long SQL without involving the worker', async () => {
    const g = make({ workerUrl: fixture('crash') });
    const result = await g.check(`SELECT '${'x'.repeat(100_001)}'`, { schemaSql, mode: 'read' });
    expect(result).toMatchObject({ ok: false, code: 'too-long' });
  });

  it('refuses with timeout when a check runs over budget, and starts a fresh worker', async () => {
    const g = make({ workerUrl: fixture('hang'), checkTimeoutMs: 50 });
    for (let i = 0; i < 2; i++) {
      expect(await g.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({
        ok: false,
        code: 'timeout',
      });
    }
  });

  it('refuses with unavailable when the worker never gets ready or crashes', async () => {
    const silent = make({ workerUrl: fixture('silent'), initTimeoutMs: 50 });
    expect(await silent.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({
      code: 'unavailable',
    });
    await silent.close();
    const crash = make({ workerUrl: fixture('crash') });
    expect(await crash.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({
      code: 'unavailable',
    });
  });

  it('gives loading a schema its own budget, apart from the check budget', async () => {
    const g = make({ workerUrl: fixture('slow-schema'), checkTimeoutMs: 50 });
    expect(await g.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({ ok: true });
  });

  it('refuses with timeout when loading the schema runs over its budget', async () => {
    const g = make({ workerUrl: fixture('schema-hang'), schemaTimeoutMs: 50 });
    const result = await g.check('SELECT 1', { schemaSql, mode: 'read' });
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(result.ok ? '' : result.reason).toMatch(/schema/i);
  });

  it('refuses a schema over 2,000 statements as too large', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    const big = Array.from({ length: 2001 }, (_, i) => `CREATE TABLE t${i}(a)`);
    expect(await g.check('SELECT 1', { schemaSql: big, mode: 'read' })).toMatchObject({
      ok: false,
      code: 'schema',
    });
  });

  it('never trusts a malformed answer from the worker', async () => {
    const g = make({ workerUrl: fixture('liar'), checkTimeoutMs: 50 });
    expect(await g.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({
      ok: false,
      code: 'timeout',
    });
  });

  it('resolves unavailable, never rejects, when a request can not be sent to the worker', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    // A function can't be structured-cloned, so postMessage throws.
    const uncloneable = [() => 'CREATE TABLE t(a)'] as unknown as string[];
    await expect(
      g.check('SELECT 1', { schemaSql: uncloneable, mode: 'read' }),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    expect(await g.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({ ok: true });
  });

  it('resolves unavailable when the SQL is not text', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    await expect(
      g.check(42 as unknown as string, { schemaSql, mode: 'read' }),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('sends a schema to the worker once and then refers to it by its hash', async () => {
    const g = make({ workerUrl: fixture('counting') });
    const tables = async (sql: string, schema: readonly string[]) => {
      const result = await g.check(sql, { schemaSql: schema, mode: 'read' });
      return result.ok ? result.tables : [result.code];
    };
    expect(await tables('SELECT 1', schemaSql)).toEqual(['loads:1', 'schema-in-check:false']);
    expect(await tables('SELECT 2', schemaSql)).toEqual(['loads:1', 'schema-in-check:false']);
    // A new array with the same statements is the same schema.
    expect(await tables('SELECT 3', [...schemaSql])).toEqual(['loads:1', 'schema-in-check:false']);
    expect(await tables('SELECT 4', ['CREATE TABLE other(a)'])).toEqual([
      'loads:2',
      'schema-in-check:false',
    ]);
  });

  it('notices a schema array changed in place after a check', async () => {
    const g = make({ workerUrl: fixture('counting') });
    const schema = ['CREATE TABLE a(x)'];
    expect(await g.check('SELECT 1', { schemaSql: schema, mode: 'read' })).toMatchObject({
      tables: ['loads:1', 'schema-in-check:false'],
    });
    schema.push('CREATE TABLE b(y)');
    expect(await g.check('SELECT 1', { schemaSql: schema, mode: 'read' })).toMatchObject({
      tables: ['loads:2', 'schema-in-check:false'],
    });
    schema[0] = 'CREATE TABLE a(z)';
    expect(await g.check('SELECT 1', { schemaSql: schema, mode: 'read' })).toMatchObject({
      tables: ['loads:3', 'schema-in-check:false'],
    });
  });

  it('sends the schema again when the worker no longer has it', async () => {
    const g = make({ workerUrl: fixture('counting') });
    expect(await g.check('FORGET', { schemaSql, mode: 'read' })).toMatchObject({
      ok: true,
      tables: ['loads:2', 'schema-in-check:false'],
    });
  });

  it('refuses after close', async () => {
    const g = make({ workerUrl: BUILT_WORKER });
    await g.close();
    expect(await g.check('SELECT 1', { schemaSql, mode: 'read' })).toMatchObject({
      code: 'unavailable',
    });
  });

  it('starts its worker whatever flags the host process was started with', async () => {
    // Worker threads inherit execArgv; `--input-type` (node -e) breaks loading a file.
    const index = new URL('../dist/index.js', import.meta.url).href;
    const script = `import { createSqlGuard } from ${JSON.stringify(index)};
      const g = createSqlGuard();
      const r = await g.check('SELECT 1', { schemaSql: [], mode: 'read' });
      await g.close();
      console.log(JSON.stringify(r));`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, kind: 'select' });
  });
});
