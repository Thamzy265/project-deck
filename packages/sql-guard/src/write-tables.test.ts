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

  it('keeps the one-table rule for a DELETE with no WHERE', async () => {
    // A cascade to lines and a trigger that writes audit each make a second table.
    expect(await edit('DELETE FROM orders')).toMatchObject({ ok: false, code: 'multiple-tables' });
    expect(await edit('DELETE FROM logged')).toMatchObject({ ok: false, code: 'multiple-tables' });
  });
});
