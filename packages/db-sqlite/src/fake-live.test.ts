import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { FakeLiveDatabase } from './testing/fake-live.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const TOKEN = 'a'.repeat(43);
const open: FakeLiveDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function make(): Promise<FakeLiveDatabase> {
  const db = await FakeLiveDatabase.create(
    'app',
    [
      'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, customer_id INTEGER REFERENCES customers(id))',
      "INSERT INTO customers VALUES (1, 'Ada')",
      "INSERT INTO orders VALUES (1, 'Coffee', 1)",
    ],
    { engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }) },
  );
  open.push(db);
  return db;
}

describe('FakeLiveDatabase (fake mode)', { timeout: 20_000 }, () => {
  it('is a live, writable database that runs real SQL with parameters', async () => {
    const db = await make();
    expect(db.live).toBe(true);
    expect(db.writable).toBe(true);
    expect(await db.listDatabases()).toEqual([{ name: 'app', backend: 'live' }]);
    const result = await db.query('app', 'SELECT item FROM orders WHERE id = ? LIMIT ?', [1, 10]);
    expect(result.rows).toEqual([['Coffee']]);
    const schema = await db.schema('app');
    expect(schema.find((t) => t.name === 'orders')?.foreignKeys).toEqual([
      { from: 'customer_id', table: 'customers', to: 'id' },
    ]);
  });

  it('runs an edit only with a confirm token, then announces the change', async () => {
    const db = await make();
    const seen: string[] = [];
    db.watch('app', 'orders', () => seen.push('orders'));
    await expect(
      db.execute('app', 'UPDATE orders SET item = ? WHERE id = ?', ['Tea', 1]),
    ).rejects.toMatchObject({ code: 'bad-token' });
    expect(
      await db.execute('app', 'UPDATE orders SET item = ? WHERE id = ?', ['Tea', 1], {
        token: TOKEN,
      }),
    ).toEqual({ changes: 1 });
    expect((await db.query('app', 'SELECT item FROM orders')).rows).toEqual([['Tea']]);
    expect(seen).toEqual(['orders']);
  });

  it('reports SQLite errors of an edit as sql-error', async () => {
    const db = await make();
    await expect(
      db.execute('app', 'INSERT INTO customers (id) VALUES (?)', [2], { token: TOKEN }),
    ).rejects.toMatchObject({ code: 'sql-error' });
  });

  it('adds rows like the app, and its diff hashes see them', async () => {
    const db = await make();
    const before = await db.rowHashes('app');
    await db.run('INSERT INTO orders VALUES (?, ?, ?)', [2, 'Cake', 1]);
    const after = await db.rowHashes('app');
    const rows = (h: typeof before) =>
      h.tables.flatMap((t) => ('rows' in t && t.name === 'orders' ? t.rows : []));
    expect(rows(before)).toHaveLength(1);
    expect(rows(after)).toHaveLength(2);
    expect((await db.rowsByKey('app', 'orders', [2])).rows).toEqual([[2, [2, 'Cake', 1]]]);
  });
});
