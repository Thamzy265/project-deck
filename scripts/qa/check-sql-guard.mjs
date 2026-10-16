#!/usr/bin/env node
// QA check of the read-only SQL gate (ADR 0005) against the BUILT package, as a backend
// will call it. Loads a Drift-like schema (orders, customers with a hidden email, an index
// on email, a trigger, an fts5 table and a view) and runs real statements through
// createSqlGuard(). Prints a CHECK/EXPECTED/GOT/MS/RESULT table and exits non-zero on any
// failure. Needs `pnpm build` first. Touches no database and no network; the schema lives
// only in the gate's in-memory scratch database.
//
// Usage: node scripts/qa/check-sql-guard.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo root has no node_modules link to the package, so load the files its
// package.json "exports" map names, exactly as a dependent package would get them.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'sql-guard');
const { exports: entries } = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8'));
const load = (entry) => import(pathToFileURL(join(PKG, entries[entry].default)).href);
const { createSqlGuard } = await load('.');
const { FakeSqlGuard } = await load('./testing');

const SCHEMA = [
  'CREATE TABLE "customers" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "created_at" INTEGER NOT NULL DEFAULT (CAST(strftime(\'%s\', CURRENT_TIMESTAMP) AS INTEGER)))',
  'CREATE TABLE sqlite_sequence(name,seq)',
  'CREATE TABLE "orders" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "customer" INTEGER NOT NULL REFERENCES customers (id), "item" TEXT NOT NULL, "total" REAL NOT NULL, "status" TEXT NOT NULL)',
  'CREATE INDEX "customers_email" ON "customers" ("email")',
  'CREATE TABLE "audit" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "what" TEXT NOT NULL)',
  'CREATE TRIGGER "customers_audit" AFTER DELETE ON "customers" BEGIN INSERT INTO audit(what) VALUES (\'customer \' || OLD.id); END',
  'CREATE VIRTUAL TABLE "customer_search" USING fts5(name, email, content=customers, content_rowid=id)',
  'CREATE VIEW "customer_orders" AS SELECT c.name, c.email, o.item, o.total FROM orders o JOIN customers c ON c.id = o.customer',
];
const HIDDEN = [{ table: 'customers', column: 'email' }];
const read = { schemaSql: SCHEMA, mode: 'read', hiddenColumns: HIDDEN };
const write = { schemaSql: SCHEMA, mode: 'write' };

// A CTE whose inlined size doubles at every level: preparing it never finishes in time,
// so it is the realistic way to push one check over the gate's 1 s budget.
function runawayPrepare(levels) {
  const ctes = ['l0 AS NOT MATERIALIZED (SELECT 1 AS x)'];
  for (let i = 1; i <= levels; i++) {
    ctes.push(
      `l${i} AS NOT MATERIALIZED (SELECT (SELECT x FROM l${i - 1}) + (SELECT x FROM l${i - 1}) AS x)`,
    );
  }
  return `WITH ${ctes.join(', ')} SELECT x FROM l${levels}`;
}

/** [name, sql, options, expected: 'pass' | refusal code, extra check on the result] */
const CASES = [
  // Normal reads
  [
    'SELECT with join',
    'SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer WHERE o.status = ?',
    read,
    'pass',
  ],
  ['count(*)', 'SELECT count(*) FROM customers', read, 'pass'],
  ['PRAGMA table_info', 'PRAGMA table_info(orders)', read, 'pass'],
  ['EXPLAIN SELECT', 'EXPLAIN SELECT * FROM orders WHERE id = 1', read, 'pass'],
  ['EXPLAIN QUERY PLAN', 'EXPLAIN QUERY PLAN SELECT name FROM customers', read, 'pass'],
  // Writes
  [
    'INSERT',
    "INSERT INTO orders(customer, item, total, status) VALUES (1, 'x', 1, 'new')",
    read,
    'writes-data',
  ],
  ['DELETE', 'DELETE FROM orders', read, 'writes-data'],
  ['ATTACH', "ATTACH '/tmp/x.db' AS x", read, 'attach'],
  ['PRAGMA write', 'PRAGMA writable_schema = 1', read, 'pragma'],
  ['PRAGMA query_only off', 'PRAGMA query_only = 0', read, 'pragma'],
  ['multi-statement', 'SELECT 1; DELETE FROM orders', read, 'multiple-statements'],
  ['NUL character', 'SELECT 1\u0000; DELETE FROM orders', read, 'invalid-sql'],
  // Hidden column
  ['hidden: direct', 'SELECT email FROM customers', read, 'hidden-column'],
  ['hidden: SELECT *', 'SELECT * FROM customers', read, 'hidden-column'],
  [
    'hidden: join USING',
    'SELECT a.id FROM customers a JOIN customers b USING (email)',
    read,
    'hidden-column',
  ],
  [
    'hidden: via index order',
    'SELECT id FROM customers ORDER BY email LIMIT 1',
    read,
    'hidden-column',
  ],
  ['hidden: via index range', "SELECT id FROM customers WHERE email > 'm' ", read, 'hidden-column'],
  [
    'hidden: via fts',
    "SELECT rowid FROM customer_search WHERE customer_search MATCH 'a*'",
    read,
    'refused',
  ],
  ['hidden: via view', 'SELECT email FROM customer_orders', read, 'hidden-column'],
  // A view whose body reads a hidden column is refused whole, even for its other
  // columns: SQLite's authorizer reports every column of the view body (fails closed).
  ['hidden: view, other column', 'SELECT name FROM customer_orders', read, 'hidden-column'],
  // Write mode
  ['write: UPDATE orders', "UPDATE orders SET status = 'shipped' WHERE id = 1", write, 'pass'],
  // ADR 0005: triggers count towards the one table an edit may write.
  ['write: DELETE with trigger', 'DELETE FROM customers WHERE id = 1', write, 'multiple-tables'],
  ['write: SELECT refused', 'SELECT * FROM orders', write, 'not-an-edit'],
  ['write: ATTACH refused', "ATTACH '/tmp/x.db' AS x", write, 'attach'],
  // Runtime cost
  [
    'unbounded WITH RECURSIVE',
    'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
    read,
    'pass',
    (r) => r.ok && r.recursive === true,
  ],
  ['runaway prepare (doubling CTE)', runawayPrepare(40), read, 'timeout'],
  ['next check after timeout', 'SELECT count(*) FROM orders', read, 'pass'],
];

const outcome = (r) => (r.ok ? 'pass' : r.code);
const matches = (expected, got) => (expected === 'refused' ? got !== 'pass' : expected === got);

const guard = createSqlGuard();
const rows = [];
let failed = 0;
try {
  // Warm-up: the wasm engine loads lazily on the first check.
  const t0 = performance.now();
  const warm = await guard.check('SELECT 1', read);
  rows.push([
    'warm-up (engine + schema load)',
    'pass',
    outcome(warm),
    performance.now() - t0,
    warm.ok,
  ]);
  if (!warm.ok) failed++;

  for (const [name, sql, opts, expected, extra] of CASES) {
    const start = performance.now();
    const r = await guard.check(sql, opts);
    const ms = performance.now() - start;
    let ok = matches(expected, outcome(r)) && (extra === undefined || extra(r));
    // The gate must answer within its budgets: 1 s per check, plus a fresh worker
    // (10 s init) and schema load (5 s) after a timeout.
    if (ms > 1500 && name !== 'next check after timeout') ok = false;
    let got = outcome(r);
    if (r.ok && r.recursive) got += ' (recursive)';
    rows.push([name, expected, got, ms, ok]);
    if (!ok) failed++;
  }
} finally {
  await guard.close();
}

// The testing fake must be importable from the built package and answer as scripted.
{
  const fake = new FakeSqlGuard().refuse('DELETE FROM orders', 'writes-data', 'no');
  const a = await fake.check('DELETE FROM orders', read);
  const b = await fake.check('SELECT 1', read);
  const ok = !a.ok && a.code === 'writes-data' && b.ok;
  rows.push([
    'FakeSqlGuard from /testing',
    'writes-data, pass',
    `${outcome(a)}, ${outcome(b)}`,
    0,
    ok,
  ]);
  if (!ok) failed++;
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('CHECK', 34)} ${pad('EXPECTED', 20)} ${pad('GOT', 22)} ${pad('MS', 7)} RESULT`);
for (const [name, expected, got, ms, ok] of rows) {
  console.log(
    `${pad(name, 34)} ${pad(expected, 20)} ${pad(got, 22)} ${pad(ms.toFixed(1), 7)} ${ok ? 'PASS' : 'FAIL'}`,
  );
}
console.log(`\n${rows.length - failed}/${rows.length} PASS`);
process.exitCode = failed === 0 ? 0 : 1;
