/**
 * Tester probes against the gate (ADR 0005 amended, design review S3/S5/S8/D3). Every
 * statement runs through the real bundled sqlite-wasm. Tests marked `it.fails` are
 * repros of open bugs (ids SG-n): they pass today only because the gate lets the
 * statement through, and start failing once the gate refuses it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GuardEngine, loadSqlite } from './engine.js';
import type { GuardCheckOptions, GuardResult, HiddenColumn } from './types.js';
import { MAX_SCHEMA_BYTES, MAX_SQL_BYTES } from './types.js';

const SCHEMA = [
  'CREATE TABLE "customers" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "password_hash" TEXT)',
  'CREATE TABLE sqlite_sequence(name,seq)',
  'CREATE TABLE "orders" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "customer" INTEGER NOT NULL REFERENCES customers (id), "item" TEXT NOT NULL, "status" TEXT NOT NULL)',
  "CREATE VIEW pending AS SELECT o.id, o.item, c.email FROM orders o JOIN customers c ON c.id = o.customer WHERE o.status = 'pending'",
  'CREATE VIRTUAL TABLE notes USING fts5(title, body)',
  'CREATE TABLE secrets (sid INTEGER PRIMARY KEY, token TEXT)',
  'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
  'CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT, pin INTEGER, email_lower TEXT GENERATED ALWAYS AS (lower(email)) VIRTUAL, pin_copy INTEGER AS (pin + 0) STORED)',
  'CREATE INDEX people_email ON people (email)',
  'CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT)',
];

const HIDDEN: HiddenColumn[] = [
  { table: 'customers', column: 'email' },
  { table: 'customers', column: 'password_hash' },
  { table: 'secrets', column: 'sid' },
  { table: 'secrets', column: 'token' },
  { table: 'notes', column: 'body' },
  { table: 'people', column: 'email' },
  { table: 'people', column: 'pin' },
];

let engine: GuardEngine;
beforeAll(async () => {
  engine = new GuardEngine(await loadSqlite());
});

function check(sql: string, opts: Partial<GuardCheckOptions> = {}): GuardResult {
  return engine.check(sql, { schemaSql: SCHEMA, mode: 'read', hiddenColumns: HIDDEN, ...opts });
}

const write = (sql: string, schemaSql: readonly string[] = SCHEMA) =>
  engine.check(sql, { schemaSql, mode: 'write' });

describe('read mode: statements that write, however they are dressed', () => {
  it.each<[string, string]>([
    [
      'CREATE TEMP TRIGGER t AFTER INSERT ON orders BEGIN DELETE FROM customers; END',
      'writes-data',
    ],
    ["INSERT INTO notes(notes) VALUES ('delete-all')", 'writes-data'],
    ["INSERT INTO notes(notes, rank) VALUES ('rank', 'bm25(10.0)')", 'writes-data'],
    ['WITH x AS (SELECT 1) INSERT INTO audit(what) SELECT * FROM x', 'writes-data'],
    ['INSERT INTO kv VALUES (1, 2) ON CONFLICT DO UPDATE SET v = 3', 'writes-data'],
    ['INSERT INTO people(email) VALUES (1)', 'writes-data'],
    ['DELETE FROM sqlite_sequence', 'writes-data'],
    ['PRAGMA "writable_schema" = 1', 'pragma'],
    ["PRAGMA 'writable_schema' = 1", 'pragma'],
    ['PRAGMA /* c */ writable_schema /* d */ = /* e */ 1', 'pragma'],
    ['pRaGmA WRITABLE_SCHEMA = 1', 'pragma'],
    ['PRAGMA main.writable_schema = 1', 'pragma'],
    ['PRAGMA temp.foreign_keys = 0', 'pragma'],
    ['PRAGMA [query_only] = 0', 'pragma'],
    ['PRAGMA recursive_triggers = 1', 'pragma'],
    ['EXPLAIN PRAGMA writable_schema = 1', 'pragma'],
    ["EXPLAIN ATTACH ':memory:' AS x", 'attach'],
    ['EXPLAIN BEGIN', 'transaction'],
    ['EXPLAIN QUERY PLAN VACUUM', 'writes-data'],
    ['BEGIN EXCLUSIVE', 'transaction'],
    ['END', 'transaction'],
    ['ROLLBACK TO a', 'transaction'],
    ['SELECT * FROM pragma_function_list', 'table'],
    ['SELECT * FROM pragma_module_list', 'table'],
    ['SELECT * FROM pragma_table_list', 'table'],
    ['SELECT * FROM generate_series(1, 10)', 'invalid-sql'],
    ['SELECT fts5(?1)', 'function'],
    ["SELECT edit('x')", 'function'],
    ["SELECT * FROM fsdir('/')", 'invalid-sql'],
    ["SELECT * FROM zipfile('/x.zip')", 'invalid-sql'],
    ["INSERT INTO temp.audit VALUES (1, 'x')", 'invalid-sql'],
  ])('refuses %s', (sql, code) => {
    expect(check(sql)).toMatchObject({ ok: false, code });
  });

  it('refuses schema-qualified writes to the schema table', () => {
    expect(check("UPDATE sqlite_master SET sql = 'x'")).toMatchObject({ ok: false });
    expect(check("UPDATE main.sqlite_schema SET sql = 'x'")).toMatchObject({ ok: false });
  });
});

describe('read mode: harmless reads still pass', () => {
  it.each<[string, string]>([
    ["SELECT iif(1, 2, 3), if(0, 1, 2), '{\"a\":1}' -> '$.a', '[1]' ->> 0", 'select'],
    ['SELECT lag(id) OVER w, ntile(2) OVER w FROM orders WINDOW w AS (ORDER BY id)', 'select'],
    ['SELECT k, v FROM kv', 'select'],
    ['SELECT * FROM sqlite_temp_master', 'select'],
    ['SELECT name FROM temp.sqlite_master', 'select'],
    ['SELECT id, name FROM main.customers', 'select'],
    ["SELECT title FROM notes WHERE notes MATCH 'x' ORDER BY rank", 'select'],
    ['pragma main.table_info(orders)', 'pragma'],
    ["PRAGMA 'table_info'('orders')", 'pragma'],
    ['PRAGMA table_info = orders', 'pragma'],
    ['PRAGMA temp.table_info(orders)', 'pragma'],
    ['PRAGMA /* c */ main . table_xinfo ( "orders" )', 'pragma'],
    ['﻿SELECT 1', 'select'],
    [';;;SELECT 1;;;', 'select'],
    ['SELECT 1 /* never closed', 'select'],
    ['EXPLAIN QUERY PLAN SELECT id FROM customers', 'explain'],
  ])('allows %s', (sql, kind) => {
    // notes holds a hidden column, which hides it whole (SG-2); the rest stay hidden.
    const hiddenColumns = HIDDEN.filter((h) => h.table !== 'notes');
    expect(check(sql, { hiddenColumns })).toMatchObject({ ok: true, kind });
  });

  it('flags a recursive CTE without an end so callers can cap it (S2)', () => {
    const result = check(
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
    );
    expect(result).toMatchObject({ ok: true, recursive: true });
  });

  it('passes large-value builders and leaves the size cap to the backends (S2)', () => {
    for (const sql of [
      'SELECT randomblob(1000000000)',
      'SELECT zeroblob(1000000000)',
      "SELECT printf('%.*c', 1000000000, 'x')",
    ]) {
      expect(check(sql), sql).toMatchObject({ ok: true });
    }
  });
});

describe('read mode: size, nesting and odd bytes', () => {
  it('judges exactly 100,000 bytes and refuses 100,001', () => {
    const at = (n: number) => `SELECT 1 -- ${'x'.repeat(n - 'SELECT 1 -- '.length)}`;
    expect(Buffer.byteLength(at(MAX_SQL_BYTES))).toBe(MAX_SQL_BYTES);
    expect(check(at(MAX_SQL_BYTES))).toMatchObject({ ok: true });
    expect(check(at(MAX_SQL_BYTES + 1))).toMatchObject({ ok: false, code: 'too-long' });
  });

  it('counts multi-byte characters as bytes at the boundary', () => {
    const head = 'SELECT 1 -- ';
    const fill = (MAX_SQL_BYTES - head.length - 1) / 2;
    const exact = `${head}${'é'.repeat(Math.floor(fill))}x`;
    expect(Buffer.byteLength(exact) <= MAX_SQL_BYTES).toBe(true);
    expect(check(exact)).toMatchObject({ ok: true });
    expect(check(`${exact}é`)).toMatchObject({ ok: false, code: 'too-long' });
  });

  it('refuses deep nesting, long compounds and long expressions as invalid, quickly', () => {
    const started = Date.now();
    expect(check(`SELECT ${'('.repeat(5000)}1${')'.repeat(5000)}`)).toMatchObject({ ok: false });
    expect(
      check(`SELECT * FROM ${'(SELECT * FROM '.repeat(500)}orders${')'.repeat(500)}`),
    ).toMatchObject({ ok: false, code: 'invalid-sql' });
    expect(check(`SELECT 1 ${'UNION ALL SELECT 1 '.repeat(600)}`)).toMatchObject({
      ok: false,
      code: 'invalid-sql',
    });
    expect(check(`SELECT ${'1+'.repeat(20_000)}1`)).toMatchObject({
      ok: false,
      code: 'invalid-sql',
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a very long identifier that names nothing, without echoing all of it', () => {
    const result = check(`SELECT "${'a'.repeat(90_000)}" FROM orders`);
    expect(result).toMatchObject({ ok: false, code: 'invalid-sql' });
  });

  it('refuses statements split by non-ASCII spaces as invalid', () => {
    expect(check('SELECT 1 ; DELETE FROM orders')).toMatchObject({ ok: false });
    expect(check('SELECT 1; DELETE FROM orders')).toMatchObject({ ok: false });
    expect(check('\u0000DELETE FROM orders')).toMatchObject({ ok: false, code: 'invalid-sql' });
  });

  // SG-5: SQLite stops reading at a NUL byte, so whatever follows is never judged. A
  // backend or transport that drops NULs (or reads past them) would run it.
  it('SG-5 refuses SQL with a NUL byte that hides a second statement', () => {
    expect(check('SELECT 1\u0000; DELETE FROM orders')).toMatchObject({ ok: false });
    expect(check('SELECT 1 -- x\u0000\nDELETE FROM orders')).toMatchObject({ ok: false });
    expect(check('SELECT 1\u0000')).toMatchObject({ ok: false, code: 'invalid-sql' });
    expect(check("SELECT 'a\u0000b'")).toMatchObject({ ok: false, code: 'invalid-sql' });
  });
});

describe('hidden columns: aliases and oracles that are refused', () => {
  it.each([
    'SELECT * FROM main.customers',
    'SELECT main.customers.email FROM customers',
    'SELECT rowid FROM secrets',
    'SELECT oid FROM secrets',
    'SELECT _rowid_ FROM secrets',
    'SELECT max(rowid) FROM secrets',
    'SELECT count(*) FROM secrets WHERE _rowid_ > 5',
    'SELECT * FROM (SELECT * FROM customers)',
    'WITH c AS (SELECT * FROM customers) SELECT id FROM c',
    'SELECT id FROM pending',
    'SELECT * FROM customers NATURAL JOIN orders',
    'SELECT count(email) FROM customers',
    'SELECT id FROM customers WHERE email IS NULL',
    'SELECT id FROM customers ORDER BY email',
    'SELECT count(*) FROM customers GROUP BY email',
    'SELECT typeof(email) FROM customers',
    'SELECT sqlite_offset(email) FROM customers',
    'SELECT id FROM customers WHERE (id, email) = (1, 2)',
    'SELECT id FROM customers WHERE email COLLATE NOCASE = 1',
    'SELECT row_number() OVER (PARTITION BY email) FROM customers',
    'SELECT count(*) FROM customers c WHERE EXISTS (SELECT 1 FROM customers d WHERE d.email = c.email)',
    'SELECT * FROM json_each((SELECT email FROM customers))',
    'SELECT * FROM pragma_table_info((SELECT email FROM customers))',
    "SELECT title FROM notes WHERE body MATCH 'x'",
    'SELECT * FROM notes',
    'EXPLAIN QUERY PLAN SELECT email FROM customers',
    'SELECT * FROM customers c JOIN (SELECT 1 AS email) k USING (email)',
  ])('refuses %s', (sql) => {
    expect(check(sql)).toMatchObject({ ok: false, code: 'hidden-column' });
  });

  it('matches hidden columns whatever the case of table and column', () => {
    const hidden = [{ table: 'CUSTOMERS', column: 'Email' }];
    expect(check('SELECT EMAIL FROM Customers', { hiddenColumns: hidden })).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('refuses hidden columns read by an edit, its WHERE or its RETURNING', () => {
    const edit = (sql: string) => check(sql, { mode: 'write' });
    for (const sql of [
      'INSERT INTO audit(what) SELECT email FROM customers',
      'UPDATE audit SET what = (SELECT password_hash FROM customers LIMIT 1)',
      "UPDATE customers SET name = 'x' WHERE id = 1 RETURNING email",
      'INSERT INTO kv VALUES (1, 2) ON CONFLICT DO UPDATE SET v = (SELECT email FROM customers)',
    ]) {
      expect(edit(sql), sql).toMatchObject({ ok: false, code: 'hidden-column' });
    }
  });
});

describe('hidden columns: open bypasses', () => {
  // SG-1: a USING or NATURAL join compares the hidden column without an SQLITE_READ, so
  // it is an equality oracle, and with a generated list it reads the value out.
  it.fails('SG-1 refuses JOIN … USING on a hidden column (equality oracle)', () => {
    expect(
      check(
        "SELECT c.id FROM customers c JOIN (SELECT 'bob@example.com' AS email) k USING (email)",
      ),
    ).toMatchObject({ ok: false, code: 'hidden-column' });
  });

  it.fails('SG-1 refuses NATURAL JOIN on a hidden column', () => {
    expect(
      check("SELECT c.id FROM (SELECT 'bob@example.com' AS email) k NATURAL JOIN customers c"),
    ).toMatchObject({ ok: false, code: 'hidden-column' });
  });

  it.fails('SG-1 refuses a self-join USING a hidden column (finds shared values)', () => {
    expect(
      check('SELECT a.id, b.id FROM customers a JOIN customers b USING (password_hash)'),
    ).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it.fails('SG-1 refuses reading a hidden integer out with a generated list and USING', () => {
    const sql =
      'WITH RECURSIVE n(sid) AS (SELECT 0 UNION ALL SELECT sid + 1 FROM n LIMIT 100000) SELECT n.sid FROM secrets JOIN n USING (sid)';
    expect(check(sql)).toMatchObject({ ok: false, code: 'hidden-column' });
  });

  it.fails('SG-1 refuses LEFT, RIGHT and FULL joins USING a hidden column', () => {
    for (const join of ['LEFT', 'RIGHT', 'FULL']) {
      const sql = `SELECT c.id FROM customers c ${join} JOIN (SELECT 'x' AS email) k USING (email)`;
      expect(check(sql), join).toMatchObject({ ok: false, code: 'hidden-column' });
    }
  });

  // SG-2: FTS5 auxiliary functions and column filters read a column by index or name in
  // a string, never through SQLITE_READ, so a hidden FTS column leaks in full.
  it('SG-2 refuses highlight() of a hidden FTS5 column', () => {
    expect(check("SELECT highlight(notes, 1, '', '') FROM notes")).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('SG-2 refuses snippet() of a hidden FTS5 column', () => {
    expect(check("SELECT snippet(notes, 1, '', '', '', 64) FROM notes")).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('SG-2 refuses a MATCH column filter on a hidden FTS5 column', () => {
    expect(check("SELECT title FROM notes WHERE notes MATCH 'body:secret*'")).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('SG-2 hides the whole FTS table and its shadow tables when it holds a hidden column', () => {
    for (const sql of [
      'SELECT title FROM notes',
      'SELECT 1 FROM notes',
      'SELECT count(*) FROM notes',
      "SELECT rowid FROM notes WHERE notes MATCH 'x'",
      'SELECT bm25(notes) FROM notes',
      'SELECT * FROM notes_content',
      'SELECT block FROM notes_data',
      'SELECT * FROM notes_idx',
    ]) {
      expect(check(sql), sql).toMatchObject({ ok: false, code: 'hidden-column' });
    }
    // Without a hidden column in it, the FTS table reads as before.
    expect(check('SELECT title FROM notes', { hiddenColumns: [] })).toMatchObject({ ok: true });
  });

  it('SG-2 hides an FTS4 stand-in table with a hidden column too', () => {
    const schemaSql = [...SCHEMA, 'CREATE VIRTUAL TABLE legacy USING fts4(subject, secret)'];
    const hiddenColumns = [{ table: 'legacy', column: 'secret' }];
    expect(check('SELECT subject FROM legacy', { schemaSql, hiddenColumns })).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  // SG-3: a generated column computes from the hidden one at read time; reading it reads
  // the hidden value, but the authorizer only sees the generated column.
  it.fails('SG-3 refuses a generated column computed from a hidden column', () => {
    expect(check('SELECT email_lower FROM people')).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
    expect(check('SELECT pin_copy FROM people')).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  // SG-4: INDEXED BY an index on a hidden column returns rows in the hidden column's
  // order: the ORDER BY oracle without naming the column.
  it.fails('SG-4 refuses INDEXED BY an index on a hidden column', () => {
    expect(check('SELECT id FROM people INDEXED BY people_email')).toMatchObject({ ok: false });
  });
});

describe('write mode: one table, rows only', () => {
  it.each([
    "INSERT INTO orders(customer, item, status) VALUES (1, 'a', 'b'), (2, 'c', 'd')",
    "INSERT INTO audit(what) VALUES ('x') RETURNING *",
    'WITH x AS (SELECT 1) INSERT INTO audit(what) SELECT * FROM x',
    'INSERT INTO people(email, pin) VALUES (1, 2)',
    "INSERT INTO kv VALUES ('a', 'b') ON CONFLICT DO UPDATE SET v = excluded.v",
  ])('allows %s', (sql) => {
    expect(write(sql)).toMatchObject({ ok: true, kind: 'write' });
  });

  it.each<[string, string]>([
    ['CREATE TABLE z(x)', 'not-an-edit'],
    ['DROP TABLE audit', 'not-an-edit'],
    ['ALTER TABLE audit RENAME TO a2', 'not-an-edit'],
    ['CREATE INDEX i ON audit(what)', 'not-an-edit'],
    ['ANALYZE', 'not-an-edit'],
    ['REINDEX', 'not-an-edit'],
    ['VACUUM', 'vacuum'],
    ["VACUUM INTO '/tmp/out.db'", 'vacuum'],
    ['PRAGMA writable_schema = 1', 'pragma'],
    ['PRAGMA foreign_keys = OFF', 'pragma'],
    ['PRAGMA defer_foreign_keys = 1', 'pragma'],
    ['BEGIN', 'transaction'],
    ['SAVEPOINT x', 'transaction'],
    ["ATTACH ':memory:' AS x", 'attach'],
    ['DELETE FROM audit; DELETE FROM orders', 'multiple-statements'],
    ["INSERT INTO audit(what) VALUES (load_extension('x'))", 'function'],
    ["UPDATE sqlite_master SET sql = 'x'", 'invalid-sql'],
  ])('refuses %s', (sql, code) => {
    expect(write(sql)).toMatchObject({ ok: false, code });
  });

  const parent = 'CREATE TABLE p(id INTEGER PRIMARY KEY, n TEXT UNIQUE)';
  it.each<[string, string, string]>([
    ['ON DELETE CASCADE', 'ON DELETE CASCADE', 'DELETE FROM p WHERE id = 1'],
    ['ON DELETE SET NULL', 'ON DELETE SET NULL', 'DELETE FROM p WHERE id = 1'],
    ['ON DELETE SET DEFAULT', 'ON DELETE SET DEFAULT', 'DELETE FROM p'],
    ['ON UPDATE CASCADE', 'ON UPDATE CASCADE', 'UPDATE p SET id = 2 WHERE id = 1'],
    ['REPLACE fires ON DELETE', 'ON DELETE CASCADE', "REPLACE INTO p VALUES (1, 'x')"],
    [
      'an upsert fires ON UPDATE',
      'ON UPDATE SET NULL',
      "INSERT INTO p VALUES (1, 'x') ON CONFLICT(n) DO UPDATE SET id = 9",
    ],
  ])('counts a foreign key action (%s) as a second table', (_name, action, sql) => {
    const schema = [
      parent,
      `CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ${action})`,
    ];
    expect(write(sql, schema)).toMatchObject({ ok: false, code: 'multiple-tables' });
  });

  it('counts a trigger fired by an upsert, and an INSTEAD OF trigger on a view', () => {
    const schema = [
      'CREATE TABLE a(x UNIQUE, y)',
      'CREATE TABLE b(y)',
      'CREATE TRIGGER t AFTER UPDATE ON a BEGIN DELETE FROM b; END',
      'CREATE VIEW v AS SELECT x FROM a',
      'CREATE TRIGGER vt INSTEAD OF INSERT ON v BEGIN INSERT INTO a(x) VALUES (NEW.x); END',
    ];
    expect(
      write('INSERT INTO a VALUES (1, 2) ON CONFLICT(x) DO UPDATE SET y = 3', schema),
    ).toMatchObject({
      ok: false,
      code: 'multiple-tables',
    });
    expect(write('INSERT INTO v VALUES (1)', schema)).toMatchObject({
      ok: false,
      code: 'multiple-tables',
    });
  });

  it('allows a trigger that only reads another table', () => {
    const schema = [
      'CREATE TABLE a(x)',
      'CREATE TABLE b(y)',
      'CREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT (SELECT count(*) FROM b); END',
    ];
    expect(write('INSERT INTO a VALUES (1)', schema)).toMatchObject({ ok: true, kind: 'write' });
  });

  // SG-8: FTS5 special commands are INSERTs into the table's own hidden column; they
  // wipe or rebuild the index or change its config, which no row edit does.
  it('SG-8 refuses FTS5 commands such as delete-all as edits', () => {
    expect(write("INSERT INTO notes(notes) VALUES ('delete-all')")).toMatchObject({ ok: false });
    expect(write("INSERT INTO notes(notes, rank) VALUES ('rank', 'bm25(10.0)')")).toMatchObject({
      ok: false,
    });
  });

  it('SG-8 refuses any edit of a virtual table, its shadow tables or a stand-in', () => {
    const schema = [...SCHEMA, 'CREATE VIRTUAL TABLE legacy USING fts4(subject)'];
    for (const sql of [
      "INSERT INTO notes(title, body) VALUES ('a', 'b')",
      "UPDATE notes SET title = 'x'",
      'DELETE FROM notes',
      'DELETE FROM notes_data',
      "UPDATE notes_config SET v = 'x'",
      "INSERT INTO legacy(subject) VALUES ('x')",
    ]) {
      const result = write(sql, schema);
      expect(result, sql).toMatchObject({ ok: false, code: 'not-an-edit' });
      expect(result.ok ? '' : result.reason, sql).toMatch(/virtual/);
    }
    expect(write("INSERT INTO audit(what) VALUES ('x')", schema)).toMatchObject({ ok: true });
  });
});

describe('schema loading: hostile statements', () => {
  const read = (schemaSql: readonly string[], sql: string, hiddenColumns: HiddenColumn[] = []) =>
    engine.check(sql, { schemaSql, mode: 'read', hiddenColumns });

  it('skips CREATE … AS SELECT, temp objects and statements with a tail', () => {
    for (const statement of [
      'CREATE TABLE x AS SELECT 1 AS a',
      'CREATE TEMP TABLE x(a)',
      'CREATE TABLE temp.x(a)',
      'CREATE TABLE x(a); CREATE TABLE y(b)',
      'CREATE TABLE x(a); PRAGMA writable_schema = 1',
    ]) {
      expect(read([statement], 'SELECT * FROM x'), statement).toMatchObject({
        ok: false,
        code: 'invalid-sql',
      });
    }
  });

  it('ignores PRAGMA, ATTACH, DROP and INSERT in the schema and keeps the rest', () => {
    const schema = [
      'CREATE TABLE a(x)',
      'PRAGMA foreign_keys = OFF',
      "ATTACH ':memory:' AS y",
      'DROP TABLE a',
      "INSERT INTO sqlite_master VALUES ('table', 'z', 'z', 0, 'CREATE TABLE z(q)')",
      'CREATE TABLE b(y)',
    ];
    expect(read(schema, 'SELECT * FROM a, b')).toMatchObject({ ok: true, tables: ['a', 'b'] });
    expect(read(schema, 'SELECT * FROM z')).toMatchObject({ ok: false });
  });

  it('keeps foreign key cascades visible even when the schema says PRAGMA foreign_keys = OFF', () => {
    const schema = [
      'PRAGMA foreign_keys = OFF',
      'CREATE TABLE p(id INTEGER PRIMARY KEY)',
      'CREATE TABLE c(id INTEGER PRIMARY KEY, p REFERENCES p(id) ON DELETE CASCADE)',
    ];
    expect(write('DELETE FROM p', schema)).toMatchObject({ ok: false, code: 'multiple-tables' });
  });

  it('loads views and triggers with dangerous bodies but refuses what reaches them', () => {
    const schema = [
      'CREATE TABLE a(x, s)',
      "CREATE VIEW v AS SELECT load_extension('x') AS l, x FROM a",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT load_extension('x'); END",
      'CREATE INDEX i ON a(s) WHERE s IS NOT NULL',
    ];
    expect(read(schema, 'SELECT x FROM v')).toMatchObject({ ok: false, code: 'function' });
    expect(write('INSERT INTO a VALUES (1, 2)', schema)).toMatchObject({
      ok: false,
      code: 'function',
    });
    expect(read(schema, 'SELECT x FROM a')).toMatchObject({ ok: true });
  });

  it('keeps the first of two statements with the same name', () => {
    const schema = [
      'CREATE TABLE a(x)',
      'CREATE TABLE a(x, secret)',
      'CREATE VIEW a AS SELECT 1 AS x',
    ];
    expect(read(schema, 'SELECT x FROM a')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT secret FROM a')).toMatchObject({ ok: false, code: 'invalid-sql' });
  });

  it('loads quoted, bracketed and backticked names', () => {
    const schema = [
      'CREATE TABLE "wé ""q"""(x)',
      'CREATE TABLE [b r]([c c])',
      'CREATE TABLE `t`(y)',
    ];
    expect(read(schema, 'SELECT x FROM "wé ""q"""')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT [c c] FROM [b r]')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT y FROM t')).toMatchObject({ ok: true });
  });

  // SG-6: SQLite's lower() folds ASCII only, JavaScript's toLowerCase folds all of
  // Unicode, so a table named with a non-ASCII capital is never "of this database".
  it('SG-6 lets a table with a non-ASCII capital in its name be read', () => {
    expect(read(['CREATE TABLE "Ünï"(c)'], 'SELECT c FROM "Ünï"')).toMatchObject({ ok: true });
    // SQLite folds ASCII letters only: N matches n, but Ï never matches ï.
    expect(read(['CREATE TABLE "Ünï"(c)'], 'SELECT c FROM "ÜNï"')).toMatchObject({ ok: true });
    expect(read(['CREATE TABLE "Ünï"(c)'], 'SELECT c FROM "ÜNÏ"')).toMatchObject({ ok: false });
  });

  it('SG-6 matches hidden columns with non-ASCII names the way SQLite does', () => {
    const schema = ['CREATE TABLE "Ünï"("Çode" TEXT, n TEXT)'];
    const hidden = [{ table: 'ÜNï', column: 'ÇODE' }];
    expect(read(schema, 'SELECT "Çode" FROM "Ünï"', hidden)).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
    expect(read(schema, 'SELECT n FROM "Ünï"', hidden)).toMatchObject({ ok: true });
  });

  it('turns unknown modules into plain tables and loads the built-in ones', () => {
    const schema = [
      'CREATE VIRTUAL TABLE w USING whatever(a, b, x=1)',
      'CREATE VIRTUAL TABLE r USING rtree(id, x0, x1)',
      'CREATE VIRTUAL TABLE n USING fts5(a, b)',
    ];
    expect(read(schema, 'SELECT a, b FROM w')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT x FROM w')).toMatchObject({ ok: false });
    expect(read(schema, 'SELECT id, x0 FROM r')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT a FROM n')).toMatchObject({ ok: true });
  });

  // SG-7: LEAKY_TABLES matches names only. A schema table built on the dbstat or
  // sqlite_dbpage module reads raw pages (deleted rows, hidden columns) under any name.
  it('SG-7 refuses a schema virtual table over sqlite_dbpage or dbstat', () => {
    expect(
      read(['CREATE VIRTUAL TABLE pages USING sqlite_dbpage'], 'SELECT * FROM pages'),
    ).toMatchObject({
      ok: false,
    });
    expect(read(['CREATE VIRTUAL TABLE st USING dbstat'], 'SELECT * FROM st')).toMatchObject({
      ok: false,
    });
  });

  it('SG-7 refuses the whole schema, saying why, when it declares dbstat or sqlite_dbpage', () => {
    for (const module of ['dbstat', 'sqlite_dbpage', 'DBSTAT']) {
      const schema = ['CREATE TABLE a(x)', `CREATE VIRTUAL TABLE pages USING ${module}`];
      const result = read(schema, 'SELECT x FROM a');
      expect(result, module).toMatchObject({ ok: false, code: 'schema' });
      expect(result.ok ? '' : result.reason).toMatch(/raw database pages/);
    }
  });

  it('SG-7 never runs a module outside fts3, fts4, fts5, rtree and rtree_i32', () => {
    // fts5vocab exists in the bundled build; as a plain table it has the parsed columns only.
    const schema = [
      'CREATE VIRTUAL TABLE n USING fts5(a)',
      'CREATE VIRTUAL TABLE v USING fts5vocab(n, row)',
      'CREATE VIRTUAL TABLE r32 USING rtree_i32(id, x0, x1)',
    ];
    expect(read(schema, 'SELECT term, doc FROM v')).toMatchObject({
      ok: false,
      code: 'invalid-sql',
    });
    expect(read(schema, 'SELECT n FROM v')).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT id, x0 FROM r32')).toMatchObject({ ok: true });
  });

  it('accepts a schema of exactly 4 MiB and refuses one byte more', () => {
    const statements = 2000;
    const per = Math.floor(MAX_SCHEMA_BYTES / statements);
    const make = (extra: number) =>
      Array.from({ length: statements }, (_, i) => {
        const head = `CREATE TABLE t${i}(a) -- `;
        const size = per + (i === 0 ? MAX_SCHEMA_BYTES - per * statements + extra : 0);
        return `${head}${'x'.repeat(size - head.length)}`;
      });
    const exact = make(0);
    expect(exact.reduce((n, s) => n + Buffer.byteLength(s), 0)).toBe(MAX_SCHEMA_BYTES);
    expect(read(exact, 'SELECT a FROM t1999')).toMatchObject({ ok: true });
    expect(read(make(1), 'SELECT 1')).toMatchObject({ ok: false, code: 'schema' });
  });

  it('refuses every check while the schema is too large, even a plain SELECT 1', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `CREATE TABLE t${i}(a)`);
    expect(read(big, 'SELECT 1')).toMatchObject({ ok: false, code: 'schema' });
    expect(read(big.slice(0, 2000), 'SELECT a FROM t1999')).toMatchObject({ ok: true });
  });

  it('never lets one check change the scratch database for the next', () => {
    const schema = ['CREATE TABLE a(x)'];
    expect(read(schema, 'CREATE TABLE b(y)')).toMatchObject({ ok: false });
    expect(engine.check('DROP TABLE a', { schemaSql: schema, mode: 'write' })).toMatchObject({
      ok: false,
    });
    expect(read(schema, 'SELECT * FROM b')).toMatchObject({ ok: false, code: 'invalid-sql' });
    expect(read(schema, 'SELECT x FROM a')).toMatchObject({ ok: true });
  });
});
