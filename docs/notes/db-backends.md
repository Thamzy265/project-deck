# Database backends: facts and differences from the plan

Batch 3 of [the M3 design](../design/m3-drift-inspector.md) (`feat/db-backends`): `packages/android-adb`, `packages/db-drift`, `packages/db-sqlite`, and the daemon's `/api/db` routes. Checked on 17 Oct 2026 against @sqlite.org/sqlite-wasm 3.53.4-build2, the system sqlite3 3.54.0 (macOS 27, for fixtures only), and the recorded `flutterdeck_drift` session in `packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json`.

## Facts checked

- **One engine for the gate and the snapshots.** sqlite-wasm opens a file image with `sqlite3_deserialize(…, SQLITE_DESERIALIZE_READONLY | FREEONCLOSE)`. The snapshot backend uses it with `PRAGMA query_only = 1`, `SQLITE_LIMIT_LENGTH` 16 MB, `SQLITE_LIMIT_ATTACHED` 0, one statement only and `sqlite3_stmt_readonly`. `randomblob(1e9)`, `zeroblob(1e9)` and `printf('%.*c', 1e9, 'x')` fail with "string or blob too big". A recursive CTE without an end is stopped by terminating the worker at 5 s; the next call opens the same copy in a new worker.
- **`bind_text` and `bind_blob` with JS values fail in this build** (a `ReferenceError: pMem is not defined` inside the binding). The backend copies the bytes into wasm memory itself and binds them with `SQLITE_WASM_DEALLOC`.
- **`z.enum(['Infinity', '-Infinity', 'NaN'])` loses `'-Infinity'` in core's built types** (the declaration file names it as a computed key `[-Infinity]`). Core now uses a union of literals (`fix(core)` commit).
- **WAL merge** (https://sqlite.org/fileformat2.html): the magic's low bit picks the checksum byte order (`0x377f0682` little-endian; the macOS fixture uses it). Only frames up to the last valid commit are applied; a frame with another salt or a bad cumulative checksum ends the WAL. Each frame's page must be within the size its own commit declares. The merged image gets bytes 18–19 set to 1 (rollback journal), and its header size (offset 28) made valid by copying offset 24 to 92.
- **Hot journal:** a rollback journal whose first 8 bytes are `d9d505f920a163d7` belongs to a write in progress. A journal with a zeroed header (PERSIST mode) does not.
- **The cell hash matches the app's.** FNV-1a 64-bit over a type byte and the value (int and real as 8 big-endian bytes), computed in two 32-bit halves. A test checks it against the recorded hashes of order 1 (`529a2ddc8ff5355f`, `2e1d5ff04220d18e`, `b8413ec34aa45d35`).
- **`adb exec-out` mixes stderr into stdout and exits 0** (review R2; `exec-out` has no shell protocol). So `head -c 28 -- app.sqlite-journal` on a missing journal prints `head: …: No such file or directory`, longer than 28 bytes, and `run-as: package not debuggable` arrives as output too. The backend gives `head` a 4 KB cap and returns only the bytes asked for. It reads `run-as:`, `cat:` and `head:` at the start of the output of `ls`, `cat` and `head` as the device's complaint: "No such file" means missing, "not debuggable" means not-debuggable, and anything else is a failed read. A real file can't be mistaken for one: a database starts with `SQLite format 3\0`, a WAL and a hot journal with binary magic numbers, and a file that starts with those words would be refused by the header and WAL checks anyway. stderr with a non-zero exit (the shell protocol) is still handled. `FakeAdb` models exec-out this way.
- **The flutterdeck_drift fake replays recorded replies.** `FakeDriftApp` (in `@project-deck/db-drift/testing`) answers with the recorded bodies. The `db-drift` tests also run against the recorded JSON file itself.

## Differences from the plan and the design note

1. **sqlite-wasm, not sql.js, for snapshots.** The plan and design name sql.js. The gate already ships @sqlite.org/sqlite-wasm (ADR 0005), which has `sqlite3_deserialize`, limits and `stmt_readonly`. So there is one wasm engine to trust and no new dependency. sql.js would add a second SQLite build.
2. **Copies stay in memory.** The design note keeps snapshot copies in daemon memory only, never on disk (Privacy table, abuse cases). The brief mentioned 0600 temp files. The design wins: no temp files are written, and `refresh()` and `close()` drop the copy.
3. **`head` is a third fixed run-as command.** The consistency rule (design review D4) reads the header change counter and the WAL salts before and after the copy. `exec-out run-as <pkg> head -c <n> -- <path>` reads 100 or 32 bytes without copying the whole file twice. It runs with a 10 s timeout, like `ls`.
4. **`ls` runs once per folder** (`app_flutter`, then `databases`), not once for both. With two folders, `ls` prints headers and fails when one folder is missing. A missing folder is skipped.
5. **The running app's process name comes before `android.applicationId`.** The process at the app's pid is the app's real id (flavors with an id suffix included). config.json's id is used when the pid or the process name is unknown. With several devices and no pid match, the answer is `choose-device`; FlutterDeck never guesses.
6. **The core `DbInspectorFactory.create` gets the session** (`create(app, session?)`), so `db-drift` uses `session.extensions` without importing connector-dart (ADR 0004).
7. **The diff answer changed shape** (core `TableDiffSchema`). Following D5, it carries keys and new values only (`added: {key, row}`, `changed: {key, row, columns}`, `removed: {key}`) and real `counts`. The M1 shape had `before` rows, which D5 rules out.
8. **The edit route has two steps.** `POST /api/db/execute` returns a request id and runs nothing. `POST /api/db/execute/confirm` sends the id with the same SQL and parameters. `POST /api/db/execute/cancel` drops it.
9. **Token callers count as Claude.** Hidden columns and Claude's caps (500 rows per query, 50 rows and 20 tables per diff) apply to every `x-deck-token` caller (MCP server, CLI, curl). Only the dashboard cookie sees full rows.
10. **Snapshot hashes for a diff always take a fresh copy** on the snapshot backend: a diff compares with now.
11. **Schema text for Claude.** Token callers get no table `sql` (free CREATE text; the columns, keys and indexes carry the same facts). Column defaults stay, because they help Claude write inserts. Instead the answer carries `untrusted`: core's `DB_UNTRUSTED_TEXT`, which the MCP tool descriptions (batch 5) can reuse word for word.

## Not in this batch

- Activity entries "Snapshot taken", "Diff shown" and "Write allowed / denied" (design note, Observability).
- A way for the user to pick the device or simulator when the answer is `choose-device`. Today the message asks them to disconnect or shut down the others.
- `flutterdeck init` writing `android.applicationId` and `ios.bundleId` to config.json (`docs/notes/untrusted-project-files.md` describes the bundle id rules).
