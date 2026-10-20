/**
 * The database tools against a stand-in daemon: what each sends, how answers are cut
 * and masked, and how every refusal reads. The real daemon and gate are in
 * db-tools-live.test.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DbDiff, DbList, DbSchema, QueryResult } from '@project-deck/core';
import { DB_UNTRUSTED_TEXT } from '@project-deck/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient } from './daemon-client.js';
import { MAX_OUTPUT_BYTES } from './output.js';
import { createDeckServer } from './server.js';
import type { FakeAnswer } from './testing/fake-daemon.js';
import { FakeDaemon, initProject } from './testing/fake-daemon.js';

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];
const tokens = new Set<string>();
const outputs: string[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-db-'));
  await initProject(projectDir);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  for (const token of tokens) for (const text of outputs) expect(text).not.toContain(token);
});

async function setup(dbTimeoutMs?: number): Promise<{ daemon: FakeDaemon; client: Client }> {
  const daemon = await FakeDaemon.start(projectDir);
  tokens.add(daemon.token);
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve('aaaaaaaaaaaa'),
    spawnDaemon: () => undefined,
    readyTimeoutMs: 300,
    pollMs: 20,
    ...(dbTimeoutMs === undefined ? {} : { dbTimeoutMs }),
  });
  const deck = createDeckServer({ projectDir, daemon: client });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await deck.server.connect(serverSide);
  await mcp.connect(clientSide);
  cleanups.push(async () => {
    await mcp.close();
    await deck.close();
  });
  return { daemon, client: mcp };
}

interface ToolOutput {
  isError: boolean;
  text: string;
  json: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutput> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join('\n');
  outputs.push(text);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Errors are plain text.
  }
  return { isError: result.isError === true, text, json };
}

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });
const dbError = (status: number, body: Record<string, unknown>): FakeAnswer => ({ status, body });

const DB_TOOLS = ['db_diff', 'db_list', 'db_query', 'db_schema', 'db_snapshot'];

describe('database tool list', () => {
  it('offers the five read-only tools and no write tool', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'db_diff',
      'db_list',
      'db_query',
      'db_schema',
      'db_snapshot',
      'deck_status',
      'get_logs',
    ]);
    expect(names.some((n) => /execute|write|insert|update|delete|edit/i.test(n))).toBe(false);
    for (const tool of tools.filter((t) => DB_TOOLS.includes(t.name))) {
      expect(tool.description).toContain(DB_UNTRUSTED_TEXT);
      expect(tool.description).toMatch(/Claude cannot change data/);
      expect(tool.description).toMatch(/best[- ]effort/i);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const query = tools.find((t) => t.name === 'db_query');
    expect(Object.keys(query?.inputSchema.properties ?? {}).sort()).toEqual([
      'db',
      'limit',
      'params',
      'sql',
    ]);
    expect(query?.description).toMatch(/count\(\*\)/);
  });
});

describe('db_list', () => {
  it('lists databases with their backend and turns a choose-device problem into a hint', async () => {
    const { daemon, client } = await setup();
    const list: DbList = {
      databases: [{ name: 'app', backend: 'live', source: 'drift' }],
      sources: [
        { id: 'drift', live: true, writable: true },
        {
          id: 'sqlite-file',
          live: false,
          writable: false,
          error: {
            code: 'choose-device',
            message: 'Two devices have the app.',
            devices: [{ id: 'emulator-5554', name: 'Pixel' }],
          },
        },
      ],
      writesAllowed: true,
    };
    daemon.route('GET', '/api/db', () => ok(list));
    const out = await call(client, 'db_list');
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      note: DB_UNTRUSTED_TEXT,
      databases: [{ name: 'app', backend: 'live', source: 'drift' }],
      problems: [
        {
          source: 'sqlite-file',
          code: 'choose-device',
          message: 'Two devices have the app.',
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(out.json.problems)).toMatch(/pick one in the FlutterDeck dashboard/);
    // Claude is never told writes are on: it has no way to write anyway.
    expect(out.text).not.toMatch(/writesAllowed|emulator-5554/);
    const req = daemon.requests.find((r) => r.path === '/api/db');
    expect(req?.headers['x-deck-token']).toBe(daemon.token);
  });
});

describe('db_schema', () => {
  it('asks for the schema by name and shows no CREATE text', async () => {
    const { daemon, client } = await setup();
    const schema: DbSchema = {
      db: 'app',
      tables: [
        {
          name: 'orders',
          kind: 'table',
          sql: 'CREATE TABLE orders (id INTEGER PRIMARY KEY)',
          columns: [{ name: 'id', type: 'INTEGER', nullable: false, pk: true, default: null }],
          rowCount: 2,
          foreignKeys: [],
          indexes: [],
        },
      ],
      untrusted: DB_UNTRUSTED_TEXT,
    };
    daemon.route('GET', '/api/db/app%2Fmain.db/schema', () => ok(schema));
    const out = await call(client, 'db_schema', { db: 'app/main.db' });
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain('CREATE');
    expect(out.json).toMatchObject({
      db: 'app',
      tables: [{ name: 'orders', rowCount: 2, columns: [{ name: 'id', pk: true, notNull: true }] }],
      truncated: false,
    });
  });
});

describe('db_query', () => {
  const result = (rows: QueryResult['rows'], truncated = false): QueryResult => ({
    columns: ['id', 'email'],
    rows,
    truncated,
    durationMs: 1.4,
  });

  it('posts the statement as JSON with the token and answers masked rows', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', (req) =>
      req.headers['x-deck-token'] === daemon.token
        ? ok(
            result([
              [1, 'ada@example.com'],
              [2, { type: 'blob', bytes: 9, base64: 'c2VjcmV0' }],
            ]),
          )
        : { status: 401, body: { error: 'no' } },
    );
    const out = await call(client, 'db_query', {
      db: 'app',
      sql: 'SELECT id, email FROM customers WHERE id > ?',
      params: [0],
      limit: 10,
    });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      note: DB_UNTRUSTED_TEXT,
      columns: ['id', 'email'],
      rows: [
        [1, '[email masked]'],
        [2, '[BLOB 9 bytes]'],
      ],
      rowCount: 2,
      truncated: false,
      durationMs: 1,
    });
    expect(out.text).not.toContain('c2VjcmV0');
    const req = daemon.requests.find((r) => r.path === '/api/db/query');
    expect(req?.method).toBe('POST');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.body).toEqual({
      db: 'app',
      sql: 'SELECT id, email FROM customers WHERE id > ?',
      params: [0],
      limit: 10,
    });
  });

  it('says when the limit left rows out, and when 20 kB did', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', () => ok(result([[1, 'a']], true)));
    const limited = await call(client, 'db_query', { db: 'app', sql: 'SELECT 1' });
    expect(limited.json.truncated).toBe(true);
    expect(String(limited.json.hint)).toMatch(/count\(\*\)/);
    const big = Array.from({ length: 500 }, (_, i) => [i, 'x'.repeat(300)]);
    daemon.route('POST', '/api/db/query', () => ok(result(big)));
    const cut = await call(client, 'db_query', { db: 'app', sql: 'SELECT 1', limit: 500 });
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(cut.json.truncated).toBe(true);
    expect(cut.json.rowCount).toBeLessThan(500);
  });

  it('refuses a limit over 500 and an empty statement before asking the daemon', async () => {
    const { daemon, client } = await setup();
    for (const args of [
      { db: 'app', sql: 'SELECT 1', limit: 501 },
      { db: 'app', sql: '' },
      { db: 'app', sql: 'SELECT 1', params: [{ type: 'int', value: '99999999999999999999' }] },
    ]) {
      const out = await call(client, 'db_query', args);
      expect(out.isError, JSON.stringify(args)).toBe(true);
    }
    expect(daemon.requests.filter((r) => r.path.startsWith('/api/db'))).toEqual([]);
  });

  it("gives the gate's reason for a refusal and says Claude can't change data", async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', () =>
      dbError(422, {
        error: 'This statement changes data or the database. Only reading is allowed here.',
        code: 'refused',
        detail: 'writes-data',
      }),
    );
    const out = await call(client, 'db_query', { db: 'app', sql: 'DELETE FROM orders' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(
      /^FlutterDeck couldn't do that \(refused\): "This statement changes data/,
    );
    expect(out.text).toMatch(/Claude can't change data/);
    expect(out.text).toMatch(/untrusted data/);
  });

  it('masks the reason too: an SQLite error can quote row values', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', () =>
      dbError(422, { error: 'no such column: bob@example.org', code: 'sql-error' }),
    );
    const out = await call(client, 'db_query', { db: 'app', sql: 'SELECT x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('[email masked]');
    expect(out.text).not.toContain('bob@example.org');
  });

  it.each([
    ['unsupported', 422, /no database inspection/],
    ['choose-device', 409, /pick one in the FlutterDeck dashboard/],
    ['busy', 503, /Try again in a moment/],
    ['timeout', 504, /Narrow the query/],
    ['app-gone', 409, /No app is attached/],
    ['setup-needed', 409, /flutterdeck_drift/],
  ])('explains %s', async (code, status, hint) => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', () => dbError(status, { error: 'Reason here', code }));
    const out = await call(client, 'db_query', { db: 'app', sql: 'SELECT 1' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`(${code}): "Reason here".`);
    expect(out.text).toMatch(hint);
  });

  it('gives up on a daemon that never answers within the database timeout', async () => {
    const { daemon, client } = await setup(200);
    daemon.route('POST', '/api/db/query', () => 'hang');
    const out = await call(client, 'db_query', { db: 'app', sql: 'SELECT 1' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/didn't answer POST \/api\/db\/query within 0.2 s/);
  });
});

describe('db_snapshot and db_diff', () => {
  it('takes a snapshot and says what to do next', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/snapshot', () =>
      ok({ id: 'snap_1', db: 'app', takenAt: 1760000000000, label: 'before' }),
    );
    const out = await call(client, 'db_snapshot', { db: 'app', label: 'before' });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      snapshotId: 'snap_1',
      db: 'app',
      label: 'before',
    });
    expect(String(out.json.next)).toMatch(/db_diff/);
    expect(daemon.requests.find((r) => r.path === '/api/db/snapshot')?.body).toEqual({
      db: 'app',
      label: 'before',
    });
  });

  it('shows rows added, changed and removed, masked, with real counts', async () => {
    const { daemon, client } = await setup();
    const diff: DbDiff = {
      db: 'app',
      snapshotId: 'snap_1',
      takenAt: 1,
      tables: [
        {
          table: 'orders',
          columns: ['id', 'item', 'status'],
          key: ['id'],
          matchedByRowid: false,
          added: [{ key: 3, row: [3, 'Order for ada@example.com', 'pending'] }],
          changed: [{ key: 1, row: [1, 'Coffee', 'shipped'], columns: ['status'] }],
          removed: [{ key: 2 }],
          counts: { added: 1, changed: 1, removed: 1 },
          truncated: false,
        },
      ],
      truncated: false,
      tablesOmitted: 0,
    };
    daemon.route('POST', '/api/db/diff', () => ok(diff));
    const out = await call(client, 'db_diff', { db: 'app', snapshotId: 'snap_1' });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      note: DB_UNTRUSTED_TEXT,
      snapshotId: 'snap_1',
      truncated: false,
      tables: [
        {
          table: 'orders',
          counts: { added: 1, changed: 1, removed: 1 },
          added: [{ key: 3, row: [3, 'Order for [email masked]', 'pending'] }],
          changed: [{ key: 1, columns: ['status'], row: [1, 'Coffee', 'shipped'] }],
          removed: [{ key: 2 }],
        },
      ],
    });
    expect(daemon.requests.find((r) => r.path === '/api/db/diff')?.body).toEqual({
      db: 'app',
      snapshotId: 'snap_1',
    });
  });

  it('asks for a snapshot first when there is none', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/diff', () =>
      dbError(404, { error: 'Take a snapshot first, then use the app.', code: 'not-found' }),
    );
    const out = await call(client, 'db_diff', { db: 'app' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Take a snapshot with db_snapshot first/);
  });

  it('refuses a malformed snapshot id before asking the daemon', async () => {
    const { daemon, client } = await setup();
    const out = await call(client, 'db_diff', { db: 'app', snapshotId: '../x' });
    expect(out.isError).toBe(true);
    expect(daemon.requests.filter((r) => r.path.startsWith('/api/db'))).toEqual([]);
  });
});

describe('no write path', () => {
  it('never calls the edit routes, whatever the tools are asked', async () => {
    const { daemon, client } = await setup();
    daemon.route('POST', '/api/db/query', () =>
      dbError(422, { error: 'Only reading is allowed here.', code: 'refused' }),
    );
    for (const sql of [
      'DELETE FROM orders',
      "UPDATE orders SET status = 'x'",
      'DROP TABLE orders',
    ]) {
      await call(client, 'db_query', { db: 'app', sql });
    }
    expect(
      daemon.requests.map((r) => r.path).filter((p) => /execute|device|queries/.test(p)),
    ).toEqual([]);
  });
});

describe('masking only what can be shown (review R8)', () => {
  it('runs slow user rules on the rows that can fit, so they finish and mask them', async () => {
    // A rule that is slow on long runs of x, then a rule for the secret. On 500 rows the
    // first rule runs out of the 200 ms budget and the second never runs.
    await writeFile(
      join(projectDir, '.flutterdeck', 'config.json'),
      JSON.stringify({ version: 1, logs: { rules: ['@w*q', 'SECRET-@d+'] } }).replaceAll(
        '@',
        '\\\\',
      ),
    );
    const { daemon, client } = await setup();
    const x = 'x'.repeat(500);
    const rows = Array.from({ length: 500 }, (_, i) => [i === 0 ? 'SECRET-123' : 'ok', x, x, x]);
    daemon.route('POST', '/api/db/query', () =>
      ok({ columns: ['a', 'b', 'c', 'd'], rows, truncated: false, durationMs: 1 }),
    );
    const out = await call(client, 'db_query', { db: 'app', sql: 'SELECT 1', limit: 500 });
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain('SECRET-123');
    expect(out.json.masking).not.toMatch(/skipped/);
    expect(out.json.truncated).toBe(true);
  });
});
