import { afterAll, describe, expect, it } from 'vitest';
import { createSqlGuard } from './guard.js';

const guard = createSqlGuard({ workerUrl: new URL('../dist/worker.js', import.meta.url) });
afterAll(async () => {
  await guard.close();
});

const schemaSql = [
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_key TEXT DEFAULT 'k1')",
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)',
];
const hidden = [{ table: 'users', column: 'api_key' }];
const read = (sql: string, opts: { claude?: boolean; hide?: boolean } = {}) =>
  guard.check(sql, {
    schemaSql,
    mode: 'read',
    ...(opts.claude === undefined ? {} : { claude: opts.claude }),
    ...(opts.hide === true ? { hiddenColumns: hidden } : {}),
  });

describe("Claude's rules for schema text and defaults (review R1)", () => {
  it.each([
    'SELECT sql FROM sqlite_schema',
    'SELECT * FROM sqlite_master',
    'SELECT upper(sql) AS s FROM sqlite_master',
    'SELECT sql FROM sqlite_temp_schema',
    "SELECT count(*) FROM sqlite_master WHERE sql LIKE '%k1%'",
    'SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p WHERE m.sql IS NOT NULL',
  ])('refuses CREATE text for Claude, with or without hidden columns: %s', async (sql) => {
    for (const hide of [false, true]) {
      const verdict = await read(sql, { claude: true, hide });
      expect(verdict, sql).toMatchObject({ ok: false, code: 'hidden-column' });
      expect(verdict.ok ? '' : verdict.reason).toMatch(/db_schema/);
    }
    // The dashboard reads it as before.
    expect(await read(sql)).toMatchObject({ ok: true });
  });

  it("lets Claude read sqlite_schema's other columns", async () => {
    expect(
      await read("SELECT name, type FROM sqlite_master WHERE type = 'table'", {
        claude: true,
        hide: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    "SELECT * FROM pragma_table_info('users')",
    "SELECT dflt_value AS d FROM pragma_table_xinfo('users')",
    'SELECT m.name, p.* FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p',
  ])('refuses column defaults to Claude while columns are hidden: %s', async (sql) => {
    expect(await read(sql, { claude: true, hide: true })).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('lets Claude read defaults when no column is hidden, and other pragma columns always', async () => {
    expect(
      await read("SELECT name, dflt_value FROM pragma_table_info('users')", { claude: true }),
    ).toMatchObject({ ok: true });
    expect(
      await read("SELECT name, type FROM pragma_table_info('users')", { claude: true, hide: true }),
    ).toMatchObject({ ok: true });
  });
});
