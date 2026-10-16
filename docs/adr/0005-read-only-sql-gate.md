# 0005. Read-only SQL gate with the real SQLite engine

Date: 2026-10-16

## Status

Proposed (M3 plan, waiting for PM approval of the plan)

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
