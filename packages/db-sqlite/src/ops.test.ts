import type { Cell } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenDb } from './ops.js';
import { cellHash, closeImage, hashes, openImage, query, rowsByKey, schema } from './ops.js';
import { loadSqlite } from './sqlite.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';
import { mergeWal } from './wal.js';

const image = () => mergeWal(walDbFixture(), walFixture(), 1e9);
let open: OpenDb | undefined;

async function openFixture(bytes: Uint8Array = image()): Promise<OpenDb> {
  open = openImage(await loadSqlite(), bytes);
  return open;
}

afterEach(() => {
  if (open !== undefined) closeImage(open);
  open = undefined;
});

/** A database image built with the real engine, for shapes the fixtures don't have. */
async function build(sql: string): Promise<Uint8Array> {
  const sqlite = await loadSqlite();
  const db = new sqlite.oo1.DB();
  try {
    db.exec(sql);
    return sqlite.capi.sqlite3_js_db_export(db.pointer ?? 0);
  } finally {
    db.close();
  }
}

describe('cellHash', () => {
  it('matches flutterdeck_drift (recorded hashes for order 1: 1, Coffee, pending)', () => {
    expect([1n, 'Coffee', 'pending'].map((v) => cellHash(v))).toEqual([
      '529a2ddc8ff5355f',
      '2e1d5ff04220d18e',
      'b8413ec34aa45d35',
    ]);
    expect(cellHash(2n)).toBe('529a2edc8ff53712');
    expect(cellHash('Tea')).toBe('ae583b88f21d6d1c');
  });

  it('keeps 1, 1.0, "1", a blob and null apart', () => {
    const values = [1n, 1.0, '1', new Uint8Array([0x31]), null];
    expect(new Set(values.map((v) => cellHash(v))).size).toBe(values.length);
  });
});

describe('schema', () => {
  it('describes tables and views with columns, keys, indexes, row counts and the schema SQL', async () => {
    const { tables, sqlSchema } = schema(await openFixture());
    expect(tables.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'table:lines',
      'table:orders',
      'view:pending',
      'table:raw',
    ]);
    const orders = tables.find((t) => t.name === 'orders');
    expect(orders).toMatchObject({
      rowCount: 3,
      indexes: [{ name: 'orders_status', columns: ['status'], unique: false }],
    });
    expect(orders?.columns[0]).toEqual({
      name: 'id',
      type: 'INTEGER',
      nullable: false,
      pk: true,
      pkPosition: 1,
      default: null,
    });
    expect(orders?.columns[2]).toMatchObject({ name: 'status', default: "'pending'" });
    expect(tables.find((t) => t.name === 'lines')?.foreignKeys).toEqual([
      { from: 'order_id', table: 'orders', to: 'id' },
    ]);
    expect(sqlSchema[0]).toMatch(/^CREATE TABLE orders/);
    expect(sqlSchema).toContain('CREATE TABLE sqlite_sequence(name,seq)');
    expect(sqlSchema.some((s) => s.startsWith('CREATE INDEX orders_status'))).toBe(true);
  });

  it('gives a table it cannot read an error entry and keeps the others', async () => {
    const bytes = await build(`
      CREATE TABLE ok(a);
      CREATE VIRTUAL TABLE notes USING fts5(body);
      PRAGMA writable_schema = ON;
      UPDATE sqlite_schema SET sql = 'CREATE VIRTUAL TABLE notes USING nosuchmodule(body)' WHERE name = 'notes';
    `);
    const { tables } = schema(await openFixture(bytes));
    expect(tables.find((t) => t.name === 'ok')?.error).toBeUndefined();
    expect(tables.find((t) => t.name === 'notes')?.error?.code).toBe('unsupported');
  });
});

describe('query', () => {
  it('runs a reading query with parameters and types every cell', async () => {
    const db = await openFixture();
    expect(
      query(db, 'SELECT id, item FROM orders WHERE status = ? ORDER BY id', ['pending'], 100),
    ).toMatchObject({
      columns: ['id', 'item'],
      rows: [
        [2, 'Tea'],
        [3, 'Cake'],
      ],
      truncated: false,
    });
    const raw = query(db, 'SELECT x FROM raw ORDER BY rowid', [], 100).rows.map((r) => r[0]);
    expect(raw).toEqual([
      { type: 'blob', bytes: 3, base64: 'AP8Q' },
      { type: 'int', value: '9007199254740993' },
      null,
      'text',
    ] satisfies Cell[]);
    const reals = query(db, 'SELECT 1.5, 9e999, -9e999, 0.0/0.0', [], 10).rows[0];
    expect(reals).toEqual([
      1.5,
      { type: 'real', value: 'Infinity' },
      { type: 'real', value: '-Infinity' },
      null,
    ]);
  });

  it('caps rows at the limit and says so', async () => {
    const db = await openFixture();
    expect(query(db, 'SELECT id FROM orders ORDER BY id', [], 2)).toMatchObject({
      rows: [[1], [2]],
      truncated: true,
    });
  });

  it('refuses writes, several statements and empty SQL, even past the gate', async () => {
    const db = await openFixture();
    for (const sql of [
      'DELETE FROM orders',
      'SELECT 1; SELECT 2',
      '  -- nothing',
      'PRAGMA user_version = 3',
    ]) {
      expect(() => query(db, sql, [], 10), sql).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/refused|sql-error/) as unknown }),
      );
    }
    expect(query(db, 'SELECT count(*) FROM orders', [], 10).rows).toEqual([[3]]);
  });

  it('reports SQL errors with SQLite message', async () => {
    const db = await openFixture();
    expect(() => query(db, 'SELECT nope FROM orders', [], 10)).toThrow(
      expect.objectContaining({
        code: 'sql-error',
        message: expect.stringContaining('no such column') as unknown,
      }),
    );
  });

  it('cuts a reply over 8 MB and says so', async () => {
    const db = await openFixture();
    const result = query(
      db,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 3000) SELECT printf('%.5000c', 'x') FROM c",
      [],
      5000,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeLessThan(3000);
  });
});

describe('hashes and rows by key', () => {
  it('keys rows by primary key, composite keys as arrays, and by rowid without one', async () => {
    const snap = hashes(await openFixture());
    const byName = new Map(snap.tables.map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual(['lines', 'orders', 'raw']);
    const orders = byName.get('orders');
    expect(orders).toMatchObject({ columns: ['id', 'item', 'status', 'created'], key: ['id'] });
    if (orders === undefined || 'error' in orders) throw new Error('no orders');
    expect(orders.rows.map(([k]) => k)).toEqual([1, 2, 3]);
    expect(orders.rows[1]?.[1].slice(0, 3)).toEqual([
      '529a2edc8ff53712',
      'ae583b88f21d6d1c',
      'b8413ec34aa45d35',
    ]);
    const lines = byName.get('lines');
    if (lines === undefined || 'error' in lines) throw new Error('no lines');
    // order_id and n may hold NULL (a rowid table's key without NOT NULL), so: rowid.
    expect(lines).toMatchObject({ key: ['rowid'], rowid: true });
    expect(byName.get('raw')).toMatchObject({ key: ['rowid'], rowid: true });
  });

  it('marks a table over 10,000 rows as too large to diff', async () => {
    const bytes = await build(
      'CREATE TABLE big(id INTEGER PRIMARY KEY); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 10001) INSERT INTO big SELECT x FROM c;',
    );
    expect(hashes(await openFixture(bytes)).tables[0]).toMatchObject({
      name: 'big',
      error: { code: 'too-large' },
    });
  });

  it('reads rows back by key, with missing keys listed', async () => {
    const db = await openFixture();
    expect(rowsByKey(db, 'orders', [3, 99])).toEqual({
      columns: ['id', 'item', 'status', 'created'],
      key: ['id'],
      rows: [[3, [3, 'Cake', 'pending', 1760000002000]]],
      missing: [99],
      truncated: false,
    });
    expect(rowsByKey(db, 'ORDERS', [1]).rows).toHaveLength(1);
    expect(() => rowsByKey(db, 'nope', [1])).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => rowsByKey(db, 'pending', [1])).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('reads blob and big integer keys sent back as tagged cells', async () => {
    const bytes = await build(
      "CREATE TABLE k(id BLOB PRIMARY KEY NOT NULL, v) WITHOUT ROWID; INSERT INTO k VALUES (x'0102', 'blob'); CREATE TABLE b(id INTEGER PRIMARY KEY, v); INSERT INTO b VALUES (9007199254740993, 'big');",
    );
    const db = await openFixture(bytes);
    expect(rowsByKey(db, 'k', [{ type: 'blob', bytes: 2, base64: 'AQI=' }]).rows[0]?.[1]).toEqual([
      { type: 'blob', bytes: 2, base64: 'AQI=' },
      'blob',
    ]);
    expect(rowsByKey(db, 'b', [{ type: 'int', value: '9007199254740993' }]).rows[0]?.[1][1]).toBe(
      'big',
    );
  });

  it('opens a plain rollback-journal database too', async () => {
    const db = await openFixture(plainDbFixture());
    expect(query(db, 'SELECT count(*) FROM orders', [], 1).rows).toEqual([[2]]);
  });
});
