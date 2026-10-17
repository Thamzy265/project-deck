import { afterAll, describe, expect, it } from 'vitest';
import { createSqlGuard } from './guard.js';

// The real worker runs from the build, like the other gate tests.
const guard = createSqlGuard({ workerUrl: new URL('../dist/worker.js', import.meta.url) });
afterAll(async () => {
  await guard.close();
});

const schemaSql = [
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)',
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)',
];
const hiddenColumns = [{ table: 'users', column: 'email' }];
const read = (sql: string, hidden = false) =>
  guard.check(sql, { schemaSql, mode: 'read', ...(hidden ? { hiddenColumns } : {}) });

describe('reads of names a statement declares as CTEs (Q1)', () => {
  it('allows count(*) over a recursive CTE', async () => {
    const sql =
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 5) SELECT count(*) FROM n';
    expect(await read(sql)).toMatchObject({ ok: true, kind: 'select', recursive: true });
    expect(await read(sql, true)).toMatchObject({ ok: true });
  });

  it('allows count(*) over a plain and a materialized CTE', async () => {
    expect(await read('WITH n AS (SELECT id FROM orders) SELECT count(*) FROM n')).toMatchObject({
      ok: true,
    });
    expect(
      await read('WITH n AS MATERIALIZED (SELECT id FROM orders) SELECT count(*) FROM n'),
    ).toMatchObject({ ok: true });
  });

  it('still refuses count(*) over a CTE that reads a hidden column', async () => {
    expect(
      await read('WITH n AS (SELECT email FROM users) SELECT count(*) FROM n', true),
    ).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('gives a CTE named like a table no way past the hidden column rules', async () => {
    // The CTE shadows users: counting it reads nothing of the real table.
    expect(
      await read('WITH users AS (SELECT 1 AS email) SELECT count(*) FROM users', true),
    ).toMatchObject({
      ok: true,
    });
    // A CTE named users that reads the real users.email is refused (or can't prepare).
    expect(
      await read(
        'WITH u AS (SELECT email FROM main.users), users AS (SELECT * FROM u) SELECT count(*) FROM users',
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await read('WITH users AS (SELECT email FROM main.users) SELECT email FROM users', true),
    ).toMatchObject({
      ok: false,
    });
  });

  it('refuses a table-valued function hidden behind a CTE of the same name in another scope', async () => {
    for (const sql of [
      'SELECT (WITH pragma_database_list AS (SELECT 1) SELECT count(*) FROM pragma_database_list), (SELECT count(*) FROM pragma_database_list)',
      'SELECT count(*) FROM pragma_database_list',
      'WITH dbstat AS (SELECT 1) SELECT count(*) FROM dbstat',
    ]) {
      expect(await read(sql), sql).toMatchObject({ ok: false });
    }
  });

  it('still refuses a name that is neither a table nor a CTE', async () => {
    expect(await read('SELECT count(*) FROM nope')).toMatchObject({ ok: false });
  });
});
