import { afterAll, describe, expect, it } from 'vitest';
import { createSqlGuard } from './guard.js';

const guard = createSqlGuard({ workerUrl: new URL('../dist/worker.js', import.meta.url) });
afterAll(async () => {
  await guard.close();
});

const schemaSql = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)',
  'CREATE TABLE lines (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE)',
  'CREATE TABLE audit (n INTEGER)',
  'CREATE TABLE logged (id INTEGER PRIMARY KEY)',
  'CREATE TRIGGER logged_delete AFTER DELETE ON logged BEGIN INSERT INTO audit VALUES (1); END',
];
const edit = (sql: string) => guard.check(sql, { schemaSql, mode: 'write' });

describe('tables an edit writes (Q2)', () => {
  it('reports the target of a DELETE with no WHERE (the truncate optimisation)', async () => {
    expect(await edit('DELETE FROM audit')).toMatchObject({
      ok: true,
      kind: 'write',
      tables: ['audit'],
    });
  });

  it('reports the target of updates, inserts and deletes with a WHERE', async () => {
    for (const sql of [
      'DELETE FROM audit WHERE n = 1',
      'UPDATE audit SET n = 2 WHERE n = 1',
      'INSERT INTO audit VALUES (3)',
    ]) {
      expect(await edit(sql), sql).toMatchObject({ ok: true, tables: ['audit'] });
    }
  });

  it('lists the written table first, before a parent read for its foreign key', async () => {
    const result = await edit('UPDATE lines SET order_id = ? WHERE id IS ?');
    expect(result).toMatchObject({ ok: true, kind: 'write' });
    expect(result.ok && result.tables).toEqual(['lines', 'orders']);
  });

  it('keeps the one-table rule for a DELETE with no WHERE', async () => {
    // A cascade to lines and a trigger that writes audit each make a second table.
    expect(await edit('DELETE FROM orders')).toMatchObject({ ok: false, code: 'multiple-tables' });
    expect(await edit('DELETE FROM logged')).toMatchObject({ ok: false, code: 'multiple-tables' });
  });
});

describe('written: the tables an edit writes, as their own field (review Low)', () => {
  it('names only the written table, not a parent read for its foreign key', async () => {
    const result = await edit('UPDATE lines SET order_id = ? WHERE id IS ?');
    expect(result.ok && result.written).toEqual(['lines']);
  });

  it('names the target of a DELETE with no WHERE and of an INSERT', async () => {
    for (const sql of ['DELETE FROM audit', 'INSERT INTO audit VALUES (3)']) {
      const result = await edit(sql);
      expect(result.ok && result.written, sql).toEqual(['audit']);
    }
  });

  it('is absent in read mode', async () => {
    const result = await guard.check('SELECT * FROM orders', { schemaSql, mode: 'read' });
    expect(result.ok).toBe(true);
    expect(result.ok && 'written' in result).toBe(false);
  });
});
