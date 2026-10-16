# Drift, SQLite and the VM service: facts for M3

Research notes behind [the M3 design](../design/m3-drift-inspector.md), ADR 0004 and ADR 0005. Checked on 16 Oct 2026 by the developer (batch 1, `feat/db-core`) against the sources linked in each section. Versions: drift 2.35.2, drift_flutter 0.3.1, package:sqlite3 3.7.1, @sqlite.org/sqlite-wasm 3.53.4-build2 (SQLite 3.53.4), Dart VM service protocol 4.x.

## Drift's own DevTools extension

- Drift registers one service extension, `ext.drift.database`, the first time a database is created. Source: [drift/lib/src/runtime/devtools/service_extension.dart](https://github.com/simolus3/drift/blob/develop/drift/lib/src/runtime/devtools/service_extension.dart) (`registerExtension('ext.drift.database', …)`).
- It is on in every build that isn't a product (release) build: `const _enable = !bool.fromEnvironment('dart.vm.product')` in [devtools.dart](https://github.com/simolus3/drift/blob/develop/drift/lib/src/runtime/devtools/devtools.dart). So profile builds have it too. The library is `@internal`.
- Its actions: `get-supported-features`, `download`, `subscribe-to-tables`, `unsubscribe-from-tables`, `execute-query`, `collect-expected-schema`, `clear`, `notify-update`.
- `execute-query` runs whatever it is given through `customSelect`, `customInsert`, `customUpdate` or `customStatement`, chosen by the caller. There is no read-only rule and no row limit, and `clear` deletes data. **Consequence:** FlutterDeck never calls `ext.drift.*`. `core` blocks the prefix outright, with `ext.flutter.`, `ext.dart.`, `ext.dds.` and dart:ui's `ext.ui.` (`BLOCKED_PREFIXES` in `packages/core/src/extensions.ts`), whatever the registry allows (ADR 0004, amended).

## Table change notifications

Source: [drift/lib/src/runtime/api/connection_user.dart](https://github.com/simolus3/drift/blob/develop/drift/lib/src/runtime/api/connection_user.dart).

- `tableUpdates([TableUpdateQuery])` streams sets of `TableUpdate`s that happened atomically. A `TableUpdate` carries the table name and an optional `UpdateKind` (insert, update, delete).
- `customStatement` "does not update stream queries on this drift database". After a raw write, call `notifyUpdates` (or `markTablesUpdated`) yourself. **Consequence:** `flutterdeck_drift`'s confirmed writes must call `notifyUpdates` for the tables they touched (design note, "Execute").
- `notifyUpdates` is more precise than `markTablesUpdated` when triggers or foreign keys write to other tables.

## package:sqlite3 (inside the app)

Source: [sqlite3.dart: lib/src/statement.dart and lib/src/database.dart](https://github.com/simolus3/sqlite3.dart/tree/main/sqlite3/lib/src).

- `CommonPreparedStatement.isReadOnly` wraps `sqlite3_stmt_readonly`; `isExplain` wraps `sqlite3_stmt_isexplain`.
- `prepare(sql, {persistent, vtab, checkNoTail})`: with `checkNoTail: true`, SQL with trailing statements throws and nothing runs. It defaults to false.
- There is no authorizer API (no `sqlite3_set_authorizer` binding). So the app alone can't refuse `ATTACH` or `PRAGMA writable_schema=1`, which `sqlite3_stmt_readonly` reports as read-only (see below). This is why the daemon's gate exists (ADR 0005).
- `createFunction` registers app functions. Drift's `NativeDatabase` registers these on every connection (`useNativeFunctions` in [native_functions.dart](https://github.com/simolus3/drift/blob/develop/drift/lib/src/sqlite3/native_functions.dart)): `power`, `pow`, `sqrt`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `regexp`, `regexp_moor_ffi`, `moor_contains` (2 and 3 arguments), `current_time_millis`. The math ones are SQLite built-ins too. Under ADR 0005 (amended) the gate refuses the others: the app's read-only connection registers no functions.

## SQLite behaviour the gate relies on

Checked by running the bundled SQLite 3.53.4 (sqlite-wasm) on 16 Oct 2026; each case is a test in `packages/sql-guard/src/engine.test.ts`. C API reference: [sqlite.org/c3ref](https://sqlite.org/c3ref/intro.html) (`stmt_readonly`, `stmt_isexplain`, `stmt_explain`, `set_authorizer`, `prepare_v3`).

- `sqlite3_stmt_readonly` returns 1 for `ATTACH`, `DETACH`, `BEGIN`, `COMMIT`, `SAVEPOINT`, `RELEASE`, `PRAGMA writable_schema=1`, `PRAGMA foreign_keys=OFF` and `PRAGMA integrity_check`. It returns 0 for `VACUUM`, `VACUUM INTO`, `PRAGMA user_version=3`, `PRAGMA optimize`, `ANALYZE`, `REINDEX`, every DML statement (with or without `RETURNING`) and `EXPLAIN DELETE …`. So the read-only flag alone is not enough; the authorizer closes the gap.
- `sqlite3_prepare_v3` prepares only the first statement and returns a tail pointer. `SELECT 1; DROP TABLE t` prepares `SELECT 1` with tail `" DROP TABLE t"`. A tail of only whitespace and comments prepares to no statement. The gate prepares the tail too and refuses if it yields anything.
- `WITH x AS (DELETE … RETURNING *) SELECT …` is a syntax error in SQLite: data-changing CTEs don't exist. `WITH … DELETE` is a plain DELETE.
- `EXPLAIN` and `EXPLAIN QUERY PLAN` report `stmt_isexplain` 1 and 2. `sqlite3_stmt_explain(stmt, 0)` re-prepares the inner statement, after which `stmt_readonly` describes it.
- Authorizer arguments: `SQLITE_READ` gives the base table and column, also through views (4th argument = view name), CTEs, aliases and expressions; `SELECT *` reports every column. A rowid read reports an empty column name. `SQLITE_FUNCTION` gives the function name in argument 2 (`->` and `->>` for the JSON operators, `match` for `MATCH`). `SQLITE_PRAGMA` gives the pragma name and its argument (`table_info(x)` and `table_info=x` both give `x`). Table-valued functions show up as `SQLITE_READ` on their name (`pragma_table_info`, `json_each`, `sqlite_dbpage`, `dbstat`, `sqlite_stmt`).
- `VACUUM` and `VACUUM INTO` call the authorizer with nothing at all. In write mode the gate finds them by their `Vacuum` opcode in the `EXPLAIN` listing (stepping an EXPLAIN lists the program; nothing runs).
- `CREATE TABLE … AUTOINCREMENT` reports two `SQLITE_CREATE_TABLE` actions (the table and `sqlite_sequence`). `CREATE TABLE … AS SELECT` reports `SQLITE_SELECT`, which the schema loader refuses. `CREATE VIEW` and `CREATE TRIGGER` bodies are not authorized at creation, only when a statement uses them.
- `CREATE VIRTUAL TABLE` with a module the build lacks prepares fine and fails at step with `no such module: X`. The bundled build has fts5, rtree and dbstat/dbpage, but not fts3/fts4 or `generate_series`.
- Functions in the bundled build: everything in the gate's allowlist except `soundex` (needs `SQLITE_SOUNDEX`); `functions.test.ts` checks the list against `pragma_function_list`.
- SQLite stops reading SQL at a NUL character, so the gate refuses SQL that contains one. Text after a NUL would otherwise never be judged.
- SQLite compares names by folding ASCII letters only (`sqlite3StrICmp`). `"Ünï"` matches `"ÜNï"` but not `"ÜNÏ"`. The gate folds names the same way (`packages/sql-guard/src/names.ts`), never with JavaScript's `toLowerCase`.
- A schema statement longer than the SQL length limit (100 kB, `SQLITE_LIMIT_SQL_LENGTH`) can't be prepared. The gate skips it by design (lead decision, 16 Oct 2026). A query on a table it would create is refused, and the reason says why.

### Reads the authorizer doesn't see (bytecode layer)

Found by the tester in batch 1 (SG-1, SG-3, SG-4) and confirmed with `EXPLAIN` listings from the bundled build:

- `JOIN … USING (email)` and `NATURAL JOIN` compare the column without any `SQLITE_READ`. The program reads it with `Column <cursor> <slot>` on the table's cursor. Joined with a generated list, this reads the value out.
- A VIRTUAL generated column is computed at read time: `Column` reads its source column, then the expression runs. The authorizer reports only the generated column. A STORED one is read from its own record slot, so the gate marks a generated column as hidden when its expression names a hidden column, read from the `CREATE TABLE` text.
- Record slots: stored columns in declared order, then VIRTUAL generated ones. An INTEGER PRIMARY KEY is the rowid and is read with `Rowid`, `SeekRowid` or `NotExists`, or with `IdxRowid` from any of the table's indexes. A WITHOUT ROWID table is stored as an index whose key starts with the primary key.
- `OpenRead p1 p2 p3` opens cursor `p1` on root page `p2` of database `p3` (0 = main). `sqlite_schema.rootpage` names the table or index. `OpenDup` copies a cursor.
- `INDEXED BY` an index on a hidden column, or one the planner picks, gives rows in that column's order. Counting through such an index uses only `Count`, which the gate allows.
- FTS `highlight()`, `snippet()` and MATCH column filters (`'body:x'`) read FTS columns by number or inside a string, never through `SQLITE_READ`. So the gate hides a whole virtual table that holds a hidden column, with its shadow tables. Those tables hold copies of the text. A virtual table the gate could not create (fts3 and fts4 are missing from the wasm build; fts5 with an app tokenizer fails) leaves its shadow tables as plain tables, so every `<vtab>_<suffix>` table counts as a shadow, not only those `pragma_table_list` marks `shadow`. An external-content FTS table (`content='notes'`) indexes its content table's text, so it is hidden whole when that table has a hidden column.
- A schema's virtual table on `dbstat` or `sqlite_dbpage` reads raw pages under any name. The gate refuses such a schema. It runs only fts3, fts4, fts5, rtree and rtree_i32; any other module becomes a plain table that can't be read, and its code never runs. Its real module (fts5vocab, an app module) could read anything.
- FTS5 commands such as `INSERT INTO notes(notes) VALUES ('delete-all')` are INSERTs into the table itself, so edits of virtual tables and their shadow tables are refused.
- Foreign key actions are compiled only when `foreign_keys` is on. The gate turns it on in its scratch database, so a cascade counts as a write to a second table.

## VM service: calling extensions and hearing events

Sources: [runtime/vm/service/service.md](https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md), [runtime/vm/service.cc](https://github.com/dart-lang/sdk/blob/main/runtime/vm/service.cc), [sdk/lib/vmservice/running_isolates.dart](https://github.com/dart-lang/sdk/blob/main/sdk/lib/vmservice/running_isolates.dart), [dart:developer ServiceExtensionResponse](https://api.dart.dev/dart-developer/ServiceExtensionResponse-class.html).

- There is no `callServiceExtension` RPC on the wire: that is package:vm_service's helper. The method name itself (`ext.flutterdeck.drift.v1.query`) is sent as the JSON-RPC method, with `isolateId` and the extension's parameters, which dart:developer hands to the handler as `Map<String, String>`. ADR 0004 therefore takes string parameters only.
- An unregistered method answers JSON-RPC `-32601` (`kMethodNotFound`, `PrintUnrecognizedMethodError` in service.cc). Errors from the extension come back with its own code, in `-32016` … `-32000` (`extensionErrorMin` … `extensionErrorMax`).
- An `isolateId` that no longer exists (for example after a hot restart) is not an error: `running_isolates.dart` answers a `Sentinel` with `kind: "Collected"`. `connector-dart` drops that isolate's extensions, re-reads the main isolate and retries once.
- Extensions registered before we attach are listed in `Isolate.extensionRPCs` (`getIsolate`). Later ones arrive as `ServiceExtensionAdded` on the `Isolate` stream, with `extensionRPC` and the `isolate`. DDS keeps history only for the Extension, Timer, Logging, Stderr and Stdout streams (`loggingRepositoryStreams` in [pkg/dds/lib/src/stream_manager.dart](https://github.com/dart-lang/sdk/blob/main/pkg/dds/lib/src/stream_manager.dart)), not Isolate, so `getIsolate` at attach is needed.
- `postEvent(kind, data)` in the app arrives as an `Extension` event on the `Extension` stream, with `extensionKind`, `extensionData` and the `isolate`. FlutterDeck subscribes to `Extension` at attach and passes events on only from isolates that announced an allowed extension (ADR 0004, amended).
- DDS replays the Extension stream's history to every new subscriber. Replayed events arrive before `getIsolate` has named the extension's isolate, so `connector-dart` drops them; they are stale anyway. **For batch 2:** `flutterdeck_drift` must register its extensions before it posts its first event, or that event is dropped.
- An extension's handler is Dart code in the app's isolate, so it can't answer while the isolate is paused at a breakpoint. Every extension call therefore has a timeout (5 s by default).
- Fixtures in `packages/connector-dart/src/testing/fixtures.ts` for these messages are spec-built; batch 2 replaces them with a recorded `flutterdeck_drift` session.

## Database files on the device

- drift_flutter's `driftDatabase(name: 'app')` opens `<getApplicationDocumentsDirectory()>/app.sqlite` unless `DriftNativeOptions.databasePath` or `databaseDirectory` says otherwise. Source: [drift_flutter/lib/src/native.dart](https://github.com/simolus3/drift/blob/develop/drift_flutter/lib/src/native.dart).
- On Android, path_provider's documents directory is `Context.getDir("flutter", MODE_PRIVATE)` ([path_provider_android_real.dart](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_android/lib/src/path_provider_android_real.dart)), which Android names `app_flutter`: `/data/data/<applicationId>/app_flutter/app.sqlite`. Not `databases/`, as the plan first said; the snapshot backend reads both.
- On iOS, the documents directory is the app container's `Documents/`.
- drift_flutter sets no journal mode, so WAL is off unless the app turns it on in `setup`. When it is on, a `-wal` file sits next to the database; sql.js opens a single byte array, so the snapshot backend merges the WAL into the main file first (design note, "Snapshot backend").

## Differences from the plan found in batch 1

- `sqlite3_stmt_readonly` also passes `BEGIN`, `COMMIT`, `SAVEPOINT`, `PRAGMA foreign_keys=OFF` and `DETACH`, not only `ATTACH` and `writable_schema`. All are refused by the authorizer.
- `VACUUM` is invisible to the authorizer; write mode finds it by opcode.
- `generate_series` is not in the bundled SQLite, so queries using it are refused by the gate even if the app has it.
