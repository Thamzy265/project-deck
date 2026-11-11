/**
 * The two worker threads as the npm bundle ships them (ADR 0006): dist/guard-worker.js and
 * dist/snapshot-worker.js, run from a copy of dist/ outside the workspace, so nothing can
 * come from node_modules or a workspace package. The copy's folder name holds a space, a
 * `#` and a `%`, which file URLs must encode (Windows profiles often hold spaces).
 * Worker messages follow sql-guard/src/guard-worker.ts and db-sqlite/src/snapshot-worker.ts.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const ORDERS = 'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, status TEXT)';

/** A worker started from `file`, or the reason it never said it was ready. */
async function startWorker(file: string): Promise<Worker> {
  // stderr: true keeps the expected wasm failures below out of the test output.
  const w = new Worker(file, { execArgv: [], stderr: true, stdout: true });
  w.on('error', () => undefined);
  const ready = await new Promise<string | true>((done) => {
    const timer = setTimeout(() => done('no ready message in 15 s'), 15_000);
    w.on('message', (m: unknown) => {
      if (z.object({ ready: z.literal(true) }).safeParse(m).success) {
        clearTimeout(timer);
        done(true);
      }
    });
    w.once('error', (err) => {
      clearTimeout(timer);
      done(`error: ${err.message}`);
    });
    w.once('exit', (code) => {
      clearTimeout(timer);
      done(`exit ${code}`);
    });
  });
  if (ready !== true) {
    await w.terminate();
    throw new Error(`Worker ${file} did not start: ${ready}`);
  }
  return w;
}

let nextId = 1;
/** Sends one request and returns the reply with the same id. */
function ask(w: Worker, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('no reply in 10 s')), 10_000);
    const onMessage = (m: unknown): void => {
      const reply = z.looseObject({ id: z.number() }).safeParse(m);
      if (!reply.success || reply.data.id !== id) return;
      clearTimeout(timer);
      w.off('message', onMessage);
      done(reply.data);
    };
    w.on('message', onMessage);
    w.postMessage({ ...message, id });
  });
}

let copy = '';
const workers: Worker[] = [];

beforeAll(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pitdeck bundle #1 %41 '));
  copy = join(parent, 'dist');
  await cp(DIST, copy, { recursive: true });
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
  if (copy !== '') await rm(join(copy, '..'), { recursive: true, force: true });
});

describe('the bundled guard worker, outside the workspace (run pnpm build first)', () => {
  let guard: Worker;
  beforeAll(async () => {
    guard = await startWorker(join(copy, 'guard-worker.js'));
    workers.push(guard);
    expect(await ask(guard, { kind: 'schema', key: 'k', schemaSql: [ORDERS] })).toMatchObject({
      schema: true,
    });
  });

  const check = async (sql: string): Promise<unknown> => {
    const reply = await ask(guard, {
      kind: 'check',
      key: 'k',
      sql,
      opts: { mode: 'read', claude: true },
    });
    return reply['result'];
  };

  it('lets a read through', async () => {
    expect(await check('SELECT id, item FROM orders WHERE status = ?')).toMatchObject({
      ok: true,
      kind: 'select',
      tables: ['orders'],
    });
  });

  // Claude never writes (PM, 16 Oct 2026): each of these must be refused by the bundled gate.
  it.each([
    ['DELETE FROM orders', 'writes-data'],
    ["INSERT INTO orders (item) VALUES ('x')", 'writes-data'],
    ["UPDATE orders SET status = 'x'", 'writes-data'],
    ["REPLACE INTO orders (id, item) VALUES (1, 'x')", 'writes-data'],
    ['CREATE TABLE evil (a)', undefined],
    ['DROP TABLE orders', undefined],
    ["ATTACH DATABASE 'other.db' AS other", 'attach'],
    ["ATTACH ':memory:' AS m", 'attach'],
    ['DETACH DATABASE main', undefined],
    ['PRAGMA user_version = 7', 'pragma'],
    ['PRAGMA journal_mode = DELETE', 'pragma'],
    ['PRAGMA writable_schema = ON', 'pragma'],
    ['PRAGMA query_only = 0', 'pragma'],
    ['SELECT 1; DELETE FROM orders', 'multiple-statements'],
    ['SELECT 1;DELETE FROM orders;', 'multiple-statements'],
    ['VACUUM', undefined],
    ["VACUUM INTO 'copy.db'", undefined],
    ['BEGIN', 'transaction'],
    ["SELECT load_extension('evil')", undefined],
    ['WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)', 'writes-data'],
    ['EXPLAIN DELETE FROM orders', undefined],
  ])('refuses %s', async (sql, code) => {
    const result = await check(sql);
    expect(result).toMatchObject({ ok: false });
    if (code !== undefined) expect(result).toMatchObject({ code });
  });

  it('refuses a write in write mode when it is not an edit', async () => {
    const reply = await ask(guard, {
      kind: 'check',
      key: 'k',
      sql: 'DROP TABLE orders',
      opts: { mode: 'write' },
    });
    expect(reply['result']).toMatchObject({ ok: false });
  });
});

describe('the bundled snapshot worker, outside the workspace (run pnpm build first)', () => {
  let snap: Worker;
  beforeAll(async () => {
    snap = await startWorker(join(copy, 'snapshot-worker.js'));
    workers.push(snap);
    const bytes = new Uint8Array(await readFile(join(copy, 'fixtures', 'plain.sqlite')));
    expect(await ask(snap, { op: 'open', bytes })).toMatchObject({ ok: true });
  });

  it('reads the bundled fixture with sqlite3.wasm from the bundle folder', async () => {
    const reply = await ask(snap, {
      op: 'query',
      sql: 'SELECT item FROM orders ORDER BY id',
      params: [],
      limit: 10,
    });
    expect(reply).toMatchObject({ ok: true, value: { rows: [['Coffee'], ['Tea']] } });
  });

  it.each(['DELETE FROM orders', "INSERT INTO orders VALUES (3, 'x', 'y')", 'DROP TABLE orders'])(
    'refuses the write %s',
    async (sql) => {
      const reply = await ask(snap, { op: 'query', sql, params: [], limit: 10 });
      expect(reply).toMatchObject({ ok: false });
      const after = await ask(snap, {
        op: 'query',
        sql: 'SELECT count(*) FROM orders',
        params: [],
        limit: 1,
      });
      expect(after).toMatchObject({ ok: true, value: { rows: [[2]] } });
    },
  );
});

describe('a bundle without sqlite3.wasm (run pnpm build first)', () => {
  // Proves the workers load the wasm from their own folder, not from anywhere else.
  it.each(['guard-worker.js', 'snapshot-worker.js'])('cannot start %s', async (file) => {
    const parent = await mkdtemp(join(tmpdir(), 'pitdeck-nowasm-'));
    try {
      const partial = join(parent, 'dist');
      await cp(DIST, partial, {
        recursive: true,
        filter: (src) => !src.endsWith('sqlite3.wasm'),
      });
      await expect(startWorker(join(partial, file))).rejects.toThrow(/did not start/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
