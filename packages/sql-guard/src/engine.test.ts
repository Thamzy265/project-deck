import { beforeAll, describe, expect, it } from 'vitest';
import { GuardEngine, loadSqlite } from './engine.js';
import type { GuardCheckOptions, GuardResult } from './types.js';
import { MAX_SQL_BYTES } from './types.js';

/** A Drift-style app schema, as `sqlite_schema.sql` holds it. */
const SCHEMA = [
  'CREATE TABLE "customers" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "password_hash" TEXT)',
  'CREATE TABLE sqlite_sequence(name,seq)',
  'CREATE TABLE "orders" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "customer" INTEGER NOT NULL REFERENCES customers (id), "item" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT \'pending\', "created" INTEGER NOT NULL DEFAULT (CAST(strftime(\'%s\', CURRENT_TIMESTAMP) AS INTEGER)))',
  'CREATE INDEX orders_status ON orders (status)',
  "CREATE VIEW pending AS SELECT o.id, o.item, c.email FROM orders o JOIN customers c ON c.id = o.customer WHERE o.status = 'pending'",
  'CREATE TRIGGER orders_touch AFTER UPDATE ON orders BEGIN UPDATE orders SET created = 0 WHERE id = NEW.id; END',
  'CREATE VIRTUAL TABLE notes USING fts5(title, body)',
  "CREATE TABLE 'notes_data'(id INTEGER PRIMARY KEY, block BLOB)",
  'CREATE VIRTUAL TABLE legacy USING fts4(subject, content="", tokenize=porter)',
];

let engine: GuardEngine;
beforeAll(async () => {
  engine = new GuardEngine(await loadSqlite());
});

function check(sql: string, opts: Partial<GuardCheckOptions> = {}): GuardResult {
  return engine.check(sql, { schemaSql: SCHEMA, mode: 'read', ...opts });
}

function reasonOf(result: GuardResult): string {
  return result.ok ? '' : result.reason;
}

const HIDDEN = [
  { table: 'customers', column: 'email' },
  { table: 'customers', column: 'password_hash' },
];

describe('read mode: allowed', () => {
  const allowed: [string, 'select' | 'explain' | 'pragma'][] = [
    ['SELECT * FROM orders', 'select'],
    ['select id, status from orders where status = ? limit 10', 'select'],
    ['SELECT count(*) FROM orders GROUP BY status', 'select'],
    ['SELECT * FROM pending', 'select'],
    ['SELECT * FROM orders; ', 'select'],
    ['SELECT 1; -- trailing comment\n /* and another */', 'select'],
    ['SELECT 1 /* ; DROP TABLE orders */', 'select'],
    ['SELECT name, sql FROM sqlite_master', 'select'],
    ["SELECT * FROM sqlite_schema WHERE type = 'table'", 'select'],
    ["SELECT * FROM pragma_table_info('orders')", 'select'],
    [
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 5) SELECT x FROM n',
      'select',
    ],
    ["WITH p AS (SELECT * FROM orders WHERE status = 'pending') SELECT count(*) FROM p", 'select'],
    ['SELECT row_number() OVER (ORDER BY id), item FROM orders', 'select'],
    ["SELECT json_extract('{\"a\":1}', '$.a'), '{\"a\":1}' ->> '$.a'", 'select'],
    ["SELECT value FROM json_each('[1,2]')", 'select'],
    ["SELECT * FROM notes WHERE notes MATCH 'x' ORDER BY bm25(notes)", 'select'],
    ['SELECT subject FROM legacy', 'select'],
    ["SELECT date('now'), unixepoch(), sqrt(4), upper(item) FROM orders", 'select'],
    ['SELECT randomblob(4), zeroblob(4)', 'select'],
    ['EXPLAIN SELECT * FROM orders', 'explain'],
    ['EXPLAIN QUERY PLAN SELECT * FROM orders WHERE status = 1', 'explain'],
    ['PRAGMA table_info(orders)', 'pragma'],
    ['PRAGMA main.table_xinfo("orders")', 'pragma'],
    ['PRAGMA index_list(orders)', 'pragma'],
    ['PRAGMA index_info(orders_status)', 'pragma'],
    ['PRAGMA foreign_key_list(orders)', 'pragma'],
  ];
  it.each(allowed)('%s', (sql, kind) => {
    expect(check(sql)).toMatchObject({ ok: true, kind });
  });

  it('reports the tables, functions and recursion a statement uses', () => {
    expect(check('SELECT upper(item) FROM orders')).toEqual({
      ok: true,
      kind: 'select',
      tables: ['orders'],
      functions: ['upper'],
      recursive: false,
    });
    expect(
      check('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n'),
    ).toMatchObject({ ok: true, recursive: true });
  });
});

describe('read mode: refused', () => {
  const refused: [string, string][] = [
    // Writes, including the shapes that hide them.
    ['DELETE FROM orders', 'writes-data'],
    ['DELETE FROM orders RETURNING *', 'writes-data'],
    ["INSERT INTO orders(customer, item) VALUES (1, 'x') RETURNING id", 'writes-data'],
    ["UPDATE orders SET status = 'x'", 'writes-data'],
    ["REPLACE INTO orders(id, customer, item) VALUES (1, 1, 'x')", 'writes-data'],
    ['WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x', 'invalid-sql'],
    ['WITH x AS (SELECT 1) DELETE FROM orders', 'writes-data'],
    ['DROP TABLE orders', 'writes-data'],
    ['ALTER TABLE orders ADD COLUMN x', 'writes-data'],
    ['CREATE TABLE t(a)', 'writes-data'],
    ['CREATE TEMP TABLE t(a)', 'writes-data'],
    ['CREATE TEMP VIEW v AS SELECT 1', 'writes-data'],
    ['CREATE INDEX i ON orders(item)', 'writes-data'],
    ['ANALYZE', 'writes-data'],
    ['REINDEX', 'writes-data'],
    ['VACUUM', 'writes-data'],
    ["VACUUM INTO '/tmp/copy.db'", 'writes-data'],
    ['EXPLAIN DELETE FROM orders', 'writes-data'],
    ['EXPLAIN QUERY PLAN DELETE FROM orders', 'writes-data'],
    // Read-only by SQLite's own flag, refused by the authorizer.
    ["ATTACH DATABASE '/tmp/x.db' AS x", 'attach'],
    ["ATTACH ':memory:' AS x", 'attach'],
    ['DETACH x', 'attach'],
    ['PRAGMA writable_schema=1', 'pragma'],
    ['PRAGMA writable_schema = ON', 'pragma'],
    ['PRAGMA user_version=3', 'pragma'],
    ['PRAGMA user_version', 'pragma'],
    ['PRAGMA foreign_keys=OFF', 'pragma'],
    ['PRAGMA query_only=0', 'pragma'],
    ['PRAGMA journal_mode=DELETE', 'pragma'],
    ['PRAGMA integrity_check', 'pragma'],
    ['PRAGMA optimize', 'pragma'],
    ['PRAGMA database_list', 'pragma'],
    ['BEGIN', 'transaction'],
    ['BEGIN IMMEDIATE', 'transaction'],
    ['COMMIT', 'transaction'],
    ['ROLLBACK', 'transaction'],
    ['SAVEPOINT a', 'transaction'],
    ['RELEASE a', 'transaction'],
    // Several statements, including comment and string tricks.
    ['SELECT 1; DROP TABLE orders', 'multiple-statements'],
    ['SELECT 1; SELECT 2', 'multiple-statements'],
    ['SELECT 1 -- x\n; DELETE FROM orders', 'multiple-statements'],
    ["SELECT ';'; DELETE FROM orders", 'multiple-statements'],
    ['SELECT 1 /* x */; /* y */ DELETE FROM orders', 'multiple-statements'],
    ['SELECT 1; garbage here', 'multiple-statements'],
    // Functions outside the allowlist.
    ["SELECT load_extension('evil')", 'function'],
    ["SELECT readfile('/etc/passwd')", 'function'],
    ["SELECT writefile('/tmp/x', 'y')", 'function'],
    ["SELECT fts3_tokenizer('simple')", 'function'],
    ["SELECT regexp('a', item) FROM orders", 'function'],
    ["SELECT * FROM orders WHERE item REGEXP 'a'", 'function'],
    ['SELECT current_time_millis()', 'function'],
    ['SELECT no_such_function(1)', 'function'],
    // Built-in tables that leak more than rows (S8).
    ['SELECT * FROM sqlite_dbpage', 'table'],
    ['SELECT * FROM dbstat', 'table'],
    ['SELECT * FROM sqlite_stmt', 'table'],
    ['SELECT * FROM pragma_database_list', 'table'],
    ['SELECT * FROM pragma_compile_options', 'table'],
    ['SELECT * FROM no_such_table', 'invalid-sql'],
    // Malformed or empty.
    ['SELEC 1', 'invalid-sql'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['-- only a comment', 'empty'],
    ['/* only a comment */ ;', 'empty'],
  ];
  it.each(refused)('%s', (sql, code) => {
    const result = check(sql);
    expect(result).toMatchObject({ ok: false, code });
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
  });

  it('explains refusals in plain words', () => {
    expect(reasonOf(check('DELETE FROM orders'))).toMatch(/only reading/i);
    expect(reasonOf(check('SELECT 1; SELECT 2'))).toMatch(/one statement/i);
    expect(reasonOf(check('PRAGMA writable_schema=1'))).toContain('writable_schema');
    expect(reasonOf(check("SELECT regexp('a', 'b')"))).toContain("SQLite's built-in functions");
    expect(reasonOf(check('SELECT * FROM sqlite_dbpage'))).toContain('raw database pages');
  });

  it('refuses SQL over the size limit without preparing it', () => {
    const sql = `SELECT '${'x'.repeat(MAX_SQL_BYTES)}'`;
    expect(check(sql)).toMatchObject({ ok: false, code: 'too-long' });
    // Bytes, not characters: 40,000 four-byte characters are 160 kB.
    expect(check(`SELECT '${'😀'.repeat(40_000)}'`)).toMatchObject({ ok: false, code: 'too-long' });
  });
});

describe('app-defined functions (S5, ADR 0005 amended)', () => {
  it.each(['regexp', 'regexp_moor_ffi', 'moor_contains', 'current_time_millis'])(
    "refuses Drift's %s, which the app's read connection doesn't register",
    (name) => {
      expect(check(`SELECT ${name}('a', 'b')`)).toMatchObject({ ok: false, code: 'function' });
    },
  );
});

describe('hidden columns (S3)', () => {
  const bypasses: string[] = [
    'SELECT email FROM customers',
    'SELECT * FROM customers',
    'SELECT c.email AS e FROM customers c',
    'SELECT upper(email) FROM customers',
    "SELECT json_object('e', email) FROM customers",
    'SELECT group_concat(email) FROM customers',
    'SELECT * FROM pending',
    'SELECT o.id, c.password_hash FROM orders o JOIN customers c ON c.id = o.customer',
    "SELECT id FROM customers WHERE email LIKE 'a%'",
    "SELECT count(*) FROM customers WHERE substr(email, 1, 1) = 'a'",
    'SELECT (SELECT email FROM customers LIMIT 1)',
    'WITH x AS (SELECT email AS e FROM customers) SELECT e FROM x',
    'SELECT id FROM customers ORDER BY password_hash',
    'SELECT length(email) FROM customers GROUP BY 1',
    'EXPLAIN SELECT email FROM customers',
    'SELECT "EMAIL" FROM "Customers"',
  ];
  it.each(bypasses)('refuses %s', (sql) => {
    expect(check(sql, { hiddenColumns: HIDDEN })).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('allows the other columns and counts, and hints at SELECT *', () => {
    expect(check('SELECT id, name FROM customers', { hiddenColumns: HIDDEN })).toMatchObject({
      ok: true,
    });
    expect(check('SELECT count(*) FROM customers', { hiddenColumns: HIDDEN })).toMatchObject({
      ok: true,
    });
    expect(reasonOf(check('SELECT * FROM customers', { hiddenColumns: HIDDEN }))).toMatch(
      /customers\.email.*list the columns/i,
    );
  });
});

describe('write mode (confirmed dashboard edits)', () => {
  const write = (sql: string) => check(sql, { mode: 'write' });

  it.each([
    ["UPDATE orders SET status = 'shipped' WHERE id = 1", 'write'],
    ['DELETE FROM orders WHERE id = 1', 'write'],
    ["INSERT INTO orders(customer, item) VALUES (1, 'x') RETURNING id", 'write'],
    ["REPLACE INTO orders(id, customer, item) VALUES (1, 1, 'x')", 'write'],
    [
      "INSERT INTO orders(id, customer, item) VALUES (1, 1, 'x') ON CONFLICT(id) DO UPDATE SET item = 'y'",
      'write',
    ],
    // Its trigger writes only to orders itself.
    ["UPDATE orders SET status = 'shipped'", 'write'],
    ['SELECT * FROM orders', 'select'],
  ])('allows %s', (sql, kind) => {
    expect(write(sql)).toMatchObject({ ok: true, kind });
  });

  it.each([
    ["ATTACH ':memory:' AS x", 'attach'],
    ['DETACH x', 'attach'],
    ['VACUUM', 'vacuum'],
    ["VACUUM INTO '/tmp/x.db'", 'vacuum'],
    ['PRAGMA writable_schema=1', 'pragma'],
    ['PRAGMA foreign_keys=OFF', 'pragma'],
    ['PRAGMA user_version=2', 'pragma'],
    ['BEGIN', 'transaction'],
    ['COMMIT', 'transaction'],
    ['ROLLBACK', 'transaction'],
    ['SAVEPOINT s', 'transaction'],
    ['RELEASE s', 'transaction'],
    ["UPDATE orders SET status = 'x'; DELETE FROM orders", 'multiple-statements'],
    ["UPDATE orders SET item = load_extension('x')", 'function'],
    // Edits change rows only (UI spec): no schema changes of any kind.
    ['CREATE INDEX i ON orders(item)', 'not-an-edit'],
    ['CREATE TABLE t(a)', 'not-an-edit'],
    ['CREATE TEMP TABLE t(a)', 'not-an-edit'],
    ['CREATE TEMP VIEW v AS SELECT 1', 'not-an-edit'],
    ['CREATE TRIGGER t AFTER INSERT ON orders BEGIN DELETE FROM customers; END', 'not-an-edit'],
    ['CREATE TEMP TRIGGER t AFTER INSERT ON orders BEGIN SELECT 1; END', 'not-an-edit'],
    ['DROP TABLE orders', 'not-an-edit'],
    ['DROP INDEX orders_status', 'not-an-edit'],
    ['DROP VIEW pending', 'not-an-edit'],
    ['DROP TRIGGER orders_touch', 'not-an-edit'],
    ['ALTER TABLE orders ADD COLUMN x', 'not-an-edit'],
    ['ALTER TABLE orders RENAME TO o2', 'not-an-edit'],
    ['CREATE VIRTUAL TABLE v USING fts5(a)', 'not-an-edit'],
    ['ANALYZE', 'not-an-edit'],
    ['REINDEX', 'not-an-edit'],
  ])('refuses %s', (sql, code) => {
    expect(write(sql)).toMatchObject({ ok: false, code });
  });

  it('refuses an edit that writes to more than one table, triggers included', () => {
    const schemaSql = [
      ...SCHEMA,
      'CREATE TABLE audit(id INTEGER PRIMARY KEY, what TEXT)',
      "CREATE TRIGGER customers_gone AFTER DELETE ON customers BEGIN INSERT INTO audit(what) VALUES ('gone'); END",
    ];
    const edit = (sql: string) => check(sql, { mode: 'write', schemaSql });
    expect(edit('DELETE FROM customers WHERE id = 1')).toMatchObject({
      ok: false,
      code: 'multiple-tables',
    });
    expect(reasonOf(edit('DELETE FROM customers WHERE id = 1'))).toMatch(/one table/i);
    expect(edit("UPDATE customers SET name = 'x' WHERE id = 1")).toMatchObject({ ok: true });
    expect(edit("INSERT INTO audit(what) VALUES ('x')")).toMatchObject({ ok: true });
  });

  it('counts foreign key cascades as writes to the other table', () => {
    const schemaSql = [
      'CREATE TABLE p(id INTEGER PRIMARY KEY)',
      'CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE)',
    ];
    expect(check('DELETE FROM p WHERE id = 1', { mode: 'write', schemaSql })).toMatchObject({
      ok: false,
      code: 'multiple-tables',
    });
    expect(check('DELETE FROM c WHERE id = 1', { mode: 'write', schemaSql })).toMatchObject({
      ok: true,
    });
  });
});

describe('schema loading (D3)', () => {
  it('ignores schema statements that are not CREATE TABLE/INDEX/VIEW/TRIGGER/VIRTUAL TABLE', () => {
    const schemaSql = [
      'CREATE TABLE a(x)',
      "ATTACH ':memory:' AS evil",
      'CREATE TABLE b AS SELECT * FROM a',
      'DROP TABLE a',
      'PRAGMA writable_schema=1',
      'CREATE TEMP TABLE t(y)',
      'CREATE TABLE c(z); DROP TABLE a',
    ];
    expect(check('SELECT x FROM a', { schemaSql })).toMatchObject({ ok: true });
    for (const table of ['b', 't', 'c', 'evil.sqlite_master']) {
      expect(check(`SELECT * FROM ${table}`, { schemaSql }), table).toMatchObject({ ok: false });
    }
  });

  it('replaces a virtual table whose module is missing with a plain table', () => {
    expect(check('SELECT subject, content FROM legacy')).toMatchObject({ ok: false });
    expect(check('SELECT subject FROM legacy')).toMatchObject({ ok: true });
    // A module outside the allowlist stands in as a plain table that can't be read (S2).
    expect(
      check('SELECT a, b FROM r', {
        schemaSql: ['CREATE VIRTUAL TABLE r USING nosuchmodule(a, b)'],
      }),
    ).toMatchObject({ ok: false, code: 'table' });
  });

  it('loads statements in any order', () => {
    const schemaSql = [
      'CREATE INDEX i ON t(a)',
      'CREATE VIEW v AS SELECT a FROM t',
      'CREATE TABLE t(a)',
    ];
    expect(check('SELECT a FROM v', { schemaSql })).toMatchObject({ ok: true });
  });

  it('takes up to 2,000 schema statements and refuses more as too large', () => {
    const tables = (n: number) => Array.from({ length: n }, (_, i) => `CREATE TABLE t${i}(a)`);
    expect(check('SELECT a FROM t1999', { schemaSql: tables(2000) })).toMatchObject({ ok: true });
    const tooMany = check('SELECT 1', { schemaSql: tables(2001) });
    expect(tooMany).toMatchObject({ ok: false, code: 'schema' });
    expect(reasonOf(tooMany)).toMatch(/schema is too large/i);
    expect(engine.loadSchema(tables(2001))).toMatchObject({ code: 'schema' });
    expect(engine.loadSchema(tables(3))).toBeUndefined();
  });

  it('keeps a bounded number of scratch databases', () => {
    const small = new GuardEngine(engine.sqlite, { maxSchemas: 3 });
    for (let i = 0; i < 10; i++) {
      expect(
        small.check(`SELECT a FROM t${i}`, { schemaSql: [`CREATE TABLE t${i}(a)`], mode: 'read' }),
      ).toMatchObject({ ok: true });
    }
    expect(small.cachedSchemas).toBe(3);
    small.close();
    expect(small.cachedSchemas).toBe(0);
  });
});

describe('cost and growth', () => {
  it('judges thousands of statements without growing wasm memory or slowing down', () => {
    // Warm up: the first check builds the scratch database.
    check('SELECT 1');
    const before = engine.sqlite.wasm.heap8u().byteLength;
    const started = performance.now();
    for (let i = 0; i < 2000; i++) {
      check(i % 2 === 0 ? `SELECT * FROM orders WHERE id = ${i}` : 'DELETE FROM orders');
    }
    const perCheck = (performance.now() - started) / 2000;
    expect(perCheck).toBeLessThan(5);
    expect(engine.sqlite.wasm.heap8u().byteLength).toBe(before);
  });

  it('judges pathological nesting quickly: deep parentheses pass, deep expressions refuse', () => {
    const started = performance.now();
    expect(check(`SELECT ${'('.repeat(2000)}1${')'.repeat(2000)}`)).toMatchObject({ ok: true });
    // SQLite's expression depth limit (1,000) stops this at prepare time.
    expect(check(`SELECT ${'abs('.repeat(1500)}1${')'.repeat(1500)}`)).toMatchObject({
      ok: false,
      code: 'invalid-sql',
    });
    const subqueries = `${'SELECT ('.repeat(200)}1${')'.repeat(200)}`;
    expect(check(subqueries).ok).toBeTypeOf('boolean');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
