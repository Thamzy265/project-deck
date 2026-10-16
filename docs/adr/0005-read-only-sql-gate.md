# 0005. Read-only SQL gate with the real SQLite engine

Date: 2026-10-16

## Status

Accepted (M3 plan approved by the PM, 16 Oct 2026)

## Context

CLAUDE.md requires that `db_query` allows only reading statements, "checked by parsing, not regex". On 16 Oct 2026 no maintained, permissively licensed pure-JS SQLite parser handled the shapes we must judge: node-sql-parser fails on `EXPLAIN`, every `PRAGMA`, `WITH … INSERT` and `DELETE … RETURNING`; sql-parser-cst is GPL-2.0; sqlite-parser was last published in 2017. SQLite's own `sqlite3_stmt_readonly` is reliable for writes but returns true for `ATTACH` and `PRAGMA writable_schema=1`, and preparing reads only the first statement.

## Decision

We will judge every SQL statement from the dashboard or Claude with the real SQLite engine before it reaches any backend:

- `packages/sql-guard` uses `@sqlite.org/sqlite-wasm` (Apache-2.0, pure wasm, no native module) in the daemon. It loads the target database's schema into a scratch in-memory database (app-defined functions stubbed), prepares the statement, and passes it only if:
  1. there is exactly one statement (empty tail after whitespace and comments);
  2. `sqlite3_stmt_readonly` is 1, or `sqlite3_stmt_isexplain` is set and the explained statement is itself read-only;
  3. an authorizer allowlist sees only `SQLITE_SELECT`, `SQLITE_READ`, `SQLITE_FUNCTION` (minus a deny list such as `load_extension`), `SQLITE_RECURSIVE`, and `SQLITE_PRAGMA` for `table_info`, `table_xinfo`, `index_list`, `index_info` and `foreign_key_list` without a value.
- The app checks again: `flutterdeck_drift` runs reads on a separate read-only connection (`OpenMode.readOnly`, `PRAGMA query_only=1`) and requires `isReadOnly` with `checkNoTail`.
- Writes (only when `db.allowWrites` is on and the user confirms) skip the read-only rule but still pass a single-statement check and a deny list for `ATTACH`, `DETACH`, `VACUUM` and `PRAGMA` writes.

## Consequences

- The gate uses SQLite's own grammar, so new syntax is handled the same way the app's SQLite handles it.
- The daemon ships an 869 KB wasm file and loads it lazily on the first query.
- Queries that use functions only the app registers fail to prepare in the gate unless stubbed; the stub list starts with Drift's own functions and grows from user reports.
- Two independent checks must both fail for a write to slip through.

## Amended 16 Oct 2026 (M3 design review)

These rules replace the matching parts above:

- **Functions:** the authorizer allows `SQLITE_FUNCTION` only for SQLite's built-in scalar, aggregate, window, date/time and JSON functions (an allowlist). App-defined functions are never stubbed and are always refused; the app's read connection registers none.
- **Transaction control:** `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused in both modes and both layers. The app checks autocommit after every query and rolls back if needed.
- **Hidden columns:** for queries from Claude, the authorizer refuses any `SQLITE_READ` of a hidden (table, column) pair, which covers aliases, expressions, joins, views and subqueries. Reads of `sqlite_dbpage`, `dbstat` and `pragma_*` table-valued functions outside the pragma allowlist are refused.
- **Schema loading:** only `CREATE TABLE/INDEX/VIEW/TRIGGER/VIRTUAL TABLE` statements load, checked with an authorizer; a virtual table with a missing module becomes a plain table with the same columns. Wasm init has a 10 s timeout and each check 1 s.
- **Runtime limits** (outside the gate): the app interrupts a read with `sqlite3_interrupt` after 5 s; sql.js reads run in a terminable worker.
- **Writes:** only the user's own dashboard edits; Claude never writes (PM decision, 16 Oct 2026).

The Consequences line about a stub list growing from user reports no longer applies.

## Amended 16 Oct 2026 (batch 1 tests, lead decisions)

- **Hidden columns, second layer:** the authorizer misses reads that SQLite makes for itself: the comparison behind `JOIN … USING` and `NATURAL JOIN`, a VIRTUAL generated column computed from a hidden one, and the order of an index on a hidden column. After the authorizer passes a statement, the gate also lists the compiled program with `EXPLAIN` (which runs nothing). It maps each `OpenRead` cursor to its table or index through `sqlite_schema.rootpage`, then refuses the statement if any of these is true:
  - a `Column` reads a hidden column's record slot on a table cursor;
  - a cursor on an index, or on a WITHOUT ROWID table, whose key holds a hidden column is used for anything other than counting (expression and partial indexes on a table with hidden columns count as holding one);
  - the rowid is read or sought on a table whose hidden column is its INTEGER PRIMARY KEY.

  Generated columns computed from a hidden column are hidden too, read from the schema, so STORED ones are caught. Both layers run; the cursor of the row an edit rewrites is not checked.

  The bytecode layer checks the gate's own query plan. The app's SQLite version or statistics may choose another index. That changes only the order of the rows, because every index that holds a hidden column is refused whenever the gate's plan uses it.

- **Virtual tables:** a virtual table that holds a hidden column is hidden whole, with its shadow tables. FTS auxiliary functions and MATCH column filters read columns without `SQLITE_READ`. A schema loads only the fts3, fts4, fts5, rtree and rtree_i32 modules; any other module becomes a plain table. A schema that declares a `dbstat` or `sqlite_dbpage` table is refused.
- **Edits:** write mode allows only INSERT, UPDATE and DELETE on one ordinary table. Triggers and foreign key actions count towards the one table. Virtual tables and their shadow tables can't be edited.
- **Input:** SQL that contains a NUL character is refused. Names are compared the way SQLite compares them, folding ASCII letters only.
- **Review fixes (16 Oct 2026):**
  - The gate records every declared virtual table, including the ones it could not create, and treats every `<vtab>_<suffix>` table as one of its shadow tables.
  - An FTS table whose `content=` table has a hidden column is hidden whole.
  - A table that stands in for a module outside the allowlist can't be read.
  - `sqlite_sequence` is refused while any column is hidden.
  - `sqlite_offset` is no longer allowed.
  - An edit must write exactly one table.
  - Backends give the gate the full `sqlite_schema` SQL through `DbInspector.schemaSql()`.
- **Schema size:** loading a schema has its own 5 s budget. A schema with more than 2,000 statements or 4 MB is refused. A schema statement longer than 100 kB is skipped by design, and a query that needs it says so.
