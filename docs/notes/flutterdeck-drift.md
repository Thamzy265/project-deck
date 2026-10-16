# flutterdeck_drift: facts and differences from the plan

Batch 2 of [the M3 design](../design/m3-drift-inspector.md) (`feat/flutterdeck-drift`). Checked on 16 Oct 2026 against the package sources in the pub cache: drift 2.35.2, drift_flutter 0.3.1, package:sqlite3 3.5.2 and 3.7.1, Flutter 3.44.6 (Dart 3.12.2).

## Facts checked

- **sqlite3 version.** Flutter 3.44.6 pins `meta` 1.18.0. package:sqlite3 3.6 and later need `hooks` ^2.2, which needs `record_use` ^1.0, which needs `meta` ^1.19. So a Flutter 3.44 app resolves at most sqlite3 3.5.x. The package asks for `sqlite3: ^3.5.2`; its own tests resolve 3.7.1, the sample app 3.5.2.
- **No `sqlite3_interrupt` or `sqlite3_limit` in package:sqlite3** (3.5.2 and 3.7.1). The package binds both itself with `@Native(assetId: 'package:sqlite3/src/ffi/libsqlite3.g.dart')`, the code asset package:sqlite3's build hook bundles (`lib/src/native.dart`). A test checks that both resolve. When package:sqlite3 compiles SQLite from source on Linux, its linker script exports only the symbols it uses itself; neither is among them, so the lookup fails there: the read still answers "timeout" after 6 s, but a step that never returns keeps running in its isolate. The default (a prebuilt library) exports both.
- **`sqlite3_limit(SQLITE_LIMIT_LENGTH, n)`** never goes below 30 bytes (SQLite clamps it).
- **`checkNoTail`** throws `ArgumentError` (not `SqliteException`) for a second statement or for SQL that is only comments.
- **`PreparedStatement.close()`** and **`Database.autocommit`** exist in both 3.5.2 and 3.7.1.
- **Drift sets no busy timeout**, and drift_flutter sets no journal mode (rollback journal) and no busy timeout. drift_flutter sets `sqlite3.tempDirectory` (a process-wide setting), so the read connection's `temp_store=FILE` works on Android too.
- **Rollback-journal locks.** A reader holds a SHARED lock while a statement runs. An app writer without a busy timeout then fails at commit with "database is locked" (seen in the tests before the fix below). Some pragmas (for example `cache_size`) read the schema and so take a lock, so the read connection sets `busy_timeout` first.
- **`tableUpdates()`** is a broadcast stream of `Set<TableUpdate>`; `customInsert(updates:)` and `notifyUpdates` feed it; `customStatement` does not.
- **`driftDatabase()`** runs the connection in a background isolate (`NativeDatabase.createInBackground`). Errors come back wrapped in `DriftRemoteException` (from the experimental `drift/remote.dart`), whose `remoteCause` is the `SqliteException`.
- **Registering a service extension twice** throws `ArgumentError`. The build-mode test uses that to tell whether `register` registered anything in a VM started with `-Ddart.vm.product=true` or `-Ddart.vm.profile=true`.

## Differences from the plan

1. **Pure Dart package, no Flutter dependency.** `kDebugMode` is two `bool.fromEnvironment` constants; the package defines the same constant itself. This keeps the dependencies to drift and sqlite3, lets `dart test` run the tests, and lets the fixture recorder run a real VM service with DDS.
2. **The app's busy timeout.** Before the first read of a database, the package sets `PRAGMA busy_timeout = 7000` on the app's own connection when it has none (debug builds only). Without it, an app write that meets an inspector read in rollback-journal mode fails. With it, the write waits for the read (at most 5 s plus 1 s). In WAL mode writes do not wait. This changes the app's connection, so the lead and PM should confirm it.
3. **Edits allow only `INSERT`, `REPLACE`, `UPDATE` and `DELETE`** on one table named without a schema. ADR 0005 lists a deny list (`ATTACH`, `DETACH`, `VACUUM`, `PRAGMA` writes, transaction control); an allowlist covers it, and the UI edits rows only.
4. **Extra `rows` extension** (from the brief) to read values by key for a diff; **extra error codes** `busy` and `not-allowed`.
5. **Blob cells** carry at most 64 KB of base64 (`truncated: true` beyond); keys carry whole blobs. **Non-finite doubles** are tagged `{type: 'real', value: 'Infinity' | '-Infinity' | 'NaN'}`, in cells and in keys. This is the agreed shape; core's `CellSchema` on `feat/db-core` gets the same variant.
6. **Write token.** The app checks only the token's shape (43 base64url characters) and that the token was not used before in this isolate. The set of used tokens lives in the app's isolate, so a hot restart (a new isolate) empties it. The app cannot tell a daemon-made token from any other. The daemon enforces single use (each confirm is bound to a server-made request id, refused after a hot restart) and stays the real control, through its dashboard-only route (design note S1).
7. **Schema and snapshot entries can carry an error.** A view or table the read connection can't use (a view that calls an app function such as Drift's `REGEXP`, a virtual table whose module is missing) gets `error: {code: 'unsupported', message}` with empty columns, instead of failing the whole call. The `db-drift` backend has to show these entries.
8. **Rowid keys for nullable primary keys.** A rowid table whose primary key may hold NULL (not `INTEGER PRIMARY KEY`, not declared `NOT NULL`) is keyed by rowid (`rowid: true`) in snapshot and rows, because SQLite lets such a key repeat NULL.
