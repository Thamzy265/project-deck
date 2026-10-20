/**
 * Tester probes of the gate's `written` list with the real engine: it must name the one
 * table an edit changes and never a table the edit only reads.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createSqlGuard } from './guard.js';

const guard = createSqlGuard({ workerUrl: new URL('../dist/worker.js', import.meta.url) });
afterAll(async () => {
  await guard.close();
});

const schemaSql = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, status TEXT)',
  'CREATE TABLE archive (id INTEGER PRIMARY KEY, item TEXT, status TEXT)',
  'CREATE TABLE audit (n INTEGER)',
  'CREATE TABLE counted (id INTEGER PRIMARY KEY)',
  'CREATE TRIGGER counted_insert AFTER INSERT ON counted BEGIN UPDATE audit SET n = n + 1; END',
  "CREATE VIEW pending AS SELECT * FROM orders WHERE status = 'pending'",
];
const edit = (sql: string) => guard.check(sql, { schemaSql, mode: 'write' });

describe('written names only the changed table (real gate)', () => {
  it.each([
    ['INSERT … SELECT from another table', 'INSERT INTO archive SELECT * FROM orders'],
    [
      'UPDATE with a subquery',
      'UPDATE archive SET status = (SELECT status FROM orders WHERE orders.id = archive.id)',
    ],
    ['DELETE with a subquery', 'DELETE FROM archive WHERE id IN (SELECT id FROM orders)'],
    ['UPDATE … FROM', 'UPDATE archive SET item = o.item FROM orders o WHERE o.id = archive.id'],
    [
      'a CTE reading another table',
      'WITH o AS (SELECT id FROM orders) DELETE FROM archive WHERE id IN o',
    ],
    ['RETURNING', "UPDATE archive SET status = 'x' WHERE id = 1 RETURNING id"],
    [
      'an upsert',
      'INSERT INTO archive (id, item) SELECT id, item FROM orders WHERE true ON CONFLICT(id) DO UPDATE SET item = excluded.item',
    ],
  ])('%s', async (_name, sql) => {
    const result = await edit(sql);
    expect(result).toMatchObject({ ok: true, kind: 'write' });
    expect(result.ok && result.written).toEqual(['archive']);
  });

  it('refuses an insert whose trigger writes a second table', async () => {
    expect(await edit('INSERT INTO counted VALUES (1)')).toMatchObject({ ok: false });
  });

  it('refuses reads and schema changes in write mode', async () => {
    for (const sql of [
      'SELECT * FROM orders',
      'CREATE TABLE x (a)',
      'DROP TABLE audit',
      'ALTER TABLE audit ADD COLUMN m',
      "INSERT INTO pending VALUES (1, 'x', 'pending')",
      'UPDATE orders SET status = 1; UPDATE archive SET status = 1',
    ]) {
      expect(await edit(sql), sql).toMatchObject({ ok: false });
    }
  });
});
