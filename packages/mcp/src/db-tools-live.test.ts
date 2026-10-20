/**
 * The database tools end to end: MCP client → this server → the real daemon with its
 * real SQL gate → a real in-memory SQLite database (FakeLiveDatabase). Covers the M3
 * Accept questions, hidden columns and the read-only rule.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { projectIdentity, startDaemon } from '@project-deck/daemon';
import { FakeLiveDatabase } from '@project-deck/db-sqlite/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient } from './daemon-client.js';
import { createDeckServer } from './server.js';
import { initProject } from './testing/fake-daemon.js';

const SETUP = [
  'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)',
  "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', customer_id INTEGER REFERENCES customers(id))",
  "INSERT INTO customers VALUES (1, 'Ada Lovelace', 'ada@example.com'), (2, 'Grace Hopper', NULL)",
  "INSERT INTO orders (item, status, customer_id) VALUES ('Coffee', 'pending', 1), ('Tea', 'shipped', 2), ('Cake', 'pending', 2)",
];

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];
const tokens = new Set<string>();
const outputs: string[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-live-'));
  await initProject(projectDir);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  for (const token of tokens) for (const text of outputs) expect(text).not.toContain(token);
});

async function setup(config: unknown = { version: 1 }) {
  await writeFile(join(projectDir, '.flutterdeck', 'config.json'), JSON.stringify(config));
  const registry = new Registry();
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  const holder: { live?: FakeLiveDatabase } = {};
  registry.dbInspectors.register({
    id: 'fake',
    create: async () => {
      holder.live = await FakeLiveDatabase.create('app', SETUP);
      return holder.live;
    },
  });
  const daemon = await startDaemon({ projectDir, registry, port: 0, log: () => undefined });
  tokens.add(daemon.token);
  cleanups.push(() => daemon.stop());
  while (daemon.manager.apps().length === 0) await new Promise((r) => setTimeout(r, 10));
  await daemon.manager.attach('app-1');
  const client = new DaemonClient({
    projectDir,
    version: daemon.version,
    projectId: () => projectIdentity(projectDir),
    spawnDaemon: () => undefined,
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
  const live = () => {
    if (holder.live === undefined) throw new Error('no live database yet');
    return holder.live;
  };
  return { mcp, live };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[]).map((c) => c.text).join('\n');
  outputs.push(text);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Errors are plain text.
  }
  return { isError: result.isError === true, text, json };
}

describe('database tools with the real daemon and gate', { timeout: 30_000 }, () => {
  it('answers "how many orders are pending?"', async () => {
    const { mcp } = await setup();
    const list = await call(mcp, 'db_list');
    expect(list.json.databases).toEqual([{ name: 'app', backend: 'live', source: 'fake' }]);
    const schema = await call(mcp, 'db_schema', { db: 'app' });
    expect(schema.text).not.toContain('CREATE');
    expect(schema.json.tables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'orders', rowCount: 3 })]),
    );
    const count = await call(mcp, 'db_query', {
      db: 'app',
      sql: 'SELECT count(*) AS pending FROM orders WHERE status = ?',
      params: ['pending'],
    });
    expect(count.isError).toBe(false);
    expect(count.json).toMatchObject({ columns: ['pending'], rows: [[2]], truncated: false });
  });

  it('confirms with db_diff what a change saved', async () => {
    const { mcp, live } = await setup();
    const snap = await call(mcp, 'db_snapshot', { db: 'app', label: 'before' });
    expect(snap.isError).toBe(false);
    // The app saves an order and ships another (Claude can't write; the app does).
    await live().run(
      "INSERT INTO orders (item, status, customer_id) VALUES ('Juice', 'pending', 1)",
    );
    await live().run("UPDATE orders SET status = 'shipped' WHERE id = 1");
    const diff = await call(mcp, 'db_diff', { db: 'app', snapshotId: snap.json.snapshotId });
    expect(diff.isError).toBe(false);
    expect(diff.json.tables).toEqual([
      expect.objectContaining({
        table: 'orders',
        counts: { added: 1, changed: 1, removed: 0 },
        added: [{ key: 4, row: [4, 'Juice', 'pending', 1] }],
        changed: [{ key: 1, columns: ['status'], row: [1, 'Coffee', 'shipped', 1] }],
      }),
    ]);
  });

  it('refuses writes through db_query and leaves the data as it was', async () => {
    const { mcp } = await setup();
    for (const sql of [
      'DELETE FROM orders',
      "UPDATE orders SET status = 'x'",
      'WITH x AS (SELECT 1) DELETE FROM orders',
      'SELECT 1; DROP TABLE orders',
      "ATTACH 'x.db' AS x",
      'BEGIN',
    ]) {
      const out = await call(mcp, 'db_query', { db: 'app', sql });
      expect(out.isError, sql).toBe(true);
      expect(out.text, sql).toMatch(/^FlutterDeck couldn't do that \(refused\)/);
    }
    const count = await call(mcp, 'db_query', { db: 'app', sql: 'SELECT count(*) FROM orders' });
    expect(count.json.rows).toEqual([[3]]);
  });

  it('never shows hidden columns: refused in queries, dropped from diffs', async () => {
    const { mcp, live } = await setup({ version: 1, db: { hiddenColumns: ['customers.email'] } });
    const star = await call(mcp, 'db_query', { db: 'app', sql: 'SELECT * FROM customers' });
    expect(star.isError).toBe(true);
    expect(star.text).toMatch(/hidden/);
    const alias = await call(mcp, 'db_query', {
      db: 'app',
      sql: 'SELECT upper(email) AS e FROM customers',
    });
    expect(alias.isError).toBe(true);
    const names = await call(mcp, 'db_query', { db: 'app', sql: 'SELECT id, name FROM customers' });
    expect(names.json.rows).toEqual([
      [1, 'Ada Lovelace'],
      [2, 'Grace Hopper'],
    ]);
    const snap = await call(mcp, 'db_snapshot', { db: 'app' });
    await live().run("INSERT INTO customers VALUES (3, 'Alan Turing', 'secret-mail@example.net')");
    const diff = await call(mcp, 'db_diff', { db: 'app', snapshotId: snap.json.snapshotId });
    expect(diff.isError).toBe(false);
    expect(diff.text).not.toContain('secret-mail');
    expect(diff.json.tables).toEqual([
      expect.objectContaining({
        table: 'customers',
        columns: ['id', 'name'],
        added: [{ key: 3, row: [3, 'Alan Turing'] }],
      }),
    ]);
  });
});
