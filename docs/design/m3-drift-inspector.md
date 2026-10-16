# M3 — Drift inspector — design note

Date: 2026-10-16 — Size: large — new Dart package inside the user's app, new trust boundary (the app's database), personal data of the app's end users, writes to a database, new commands (`adb run-as`) — Phase: MVP — Status: draft, waiting for PM

## Context

M3 is the headline feature: a Drift inspector clearly better than the Drift DevTools extension, next to Claude in Claude Desktop. Plan items ([PLAN.md M3](../PLAN.md#m3--drift-inspector-headline-feature)):

- `flutterdeck_drift` Dart package; no-op in release.
- `db-drift` (live) and `db-sqlite` (snapshot, `sql.js`) backends.
- Database tab: tables, schema diagram, SQL editor with autocomplete, saved queries, live refresh, snapshot diff, export, guarded editing.
- MCP tools: `db_list`, `db_schema`, `db_query`, `db_execute`, `db_snapshot`, `db_diff`.
- Accept: adding an item in the sample app flashes the new row within 1 s; Claude answers "how many orders are pending?" and uses `db_diff` to confirm what a change saved.
- Validation checkpoint: the team drafts a 60-second demo, an install guide and post text; the PM publishes them (PM decision, 14 Oct 2026).

PM decision, 14 Oct 2026: the live backend is our own `flutterdeck_drift` package.

Facts checked on 16 Oct 2026 (drift 2.35.2, drift_flutter 0.3.1, package:sqlite3 3.7.1, sql.js 1.15.0, @sqlite.org/sqlite-wasm 3.53.4, @codemirror/lang-sql 6.10.0; sources in the research notes, `docs/notes/drift.md` to be written in batch 1):

- Drift registers its own DevTools service extension `ext.drift.database` for every database in any non-release build (also profile). It is `@internal`, has no read-only guarantee (`DELETE … RETURNING` runs through its select path), no row limit, and includes a destructive `clear` action.
- `tableUpdates()` reports table name and update kind. Raw `customStatement` writes do not notify; our own writes must call `notifyUpdates`.
- package:sqlite3 exposes `PreparedStatement.isReadOnly` (`sqlite3_stmt_readonly`) and `checkNoTail`, but no authorizer. `sqlite3_stmt_readonly` alone misses `ATTACH` and `PRAGMA writable_schema=1`.
- @sqlite.org/sqlite-wasm (Apache-2.0, 869 KB wasm, pure wasm) gives the real SQLite parser in Node, with `sqlite3_stmt_readonly`, `sqlite3_stmt_isexplain` and `sqlite3_set_authorizer`.
- drift_flutter stores the database at `getApplicationDocumentsDirectory()/<name>.sqlite`, which on Android is `/data/data/<pkg>/app_flutter/`, not `databases/` as the plan says.
- sql.js cannot read `-wal` files; a WAL must be merged into the main file in JS (prototype works). drift does not enable WAL by default.
- CodeMirror 6 uses constructable style sheets and CSSOM, so it should work under our CSP without `unsafe-inline` (to be proven by a Playwright CSP test).
- `flutterdeck_drift` is free on pub.dev today.

## Deviations from the plan

1. **Snapshot path:** read candidate files from `app_flutter/` and `databases/`, not only `databases/`.
2. **Read-only gate:** "checked by parsing" becomes a check with the real SQLite engine (sqlite-wasm in the daemon, plus a read-only connection in the app), because no maintained pure-JS SQLite parser handles `EXPLAIN`, `PRAGMA`, CTE writes and `RETURNING` (node-sql-parser fails them; others are GPL or abandoned). ADR 0005.
3. **VM service access for `db-drift`:** CLAUDE.md keeps VM service specifics inside `connector-dart`, and packages depend on `core` only. `core` gets an optional, generic `AppSession.extensions` capability (call a named app extension, listen for app events); `connector-dart` implements it over the VM service; `db-drift` uses it. ADR 0004.
4. **adb sharing:** `logs-android` holds the adb path resolution and fixed-command runner. `db-sqlite` needs the same, so they move to a small `packages/android-adb` package that both use.
5. **No-setup path on Drift's own extension:** not in the plan; left as decision D1.

## Requirements and non-goals

- Functional:
  - `flutterdeck_drift`: `FlutterDeckDrift.register(db, name: 'app')` registers `ext.flutterdeck.drift.*` extensions in debug builds only (`kDebugMode`; nothing in profile or release): list, schema, query (read-only connection), execute (only when the daemon says writes are allowed and the user confirmed), and table-change events through `postEvent`. Several databases per app.
  - `db-drift`: `DbInspector` over those extensions, `live: true`, `watch` from the events.
  - `db-sqlite`: `DbInspector` over a snapshot copied with `adb exec-out run-as <applicationId> cat <file>` (WAL merged, `SQLite format 3` header checked), opened read-only in sql.js; `live: false`; "Snapshot from 14:02 · Refresh" in the UI. Android, debuggable apps only.
  - Read-only gate in the daemon for every query from the dashboard or Claude, before it reaches either backend.
  - Database tab (UI spec), saved queries in `.flutterdeck/queries.json`, export CSV/JSON.
  - Snapshots and diffs: `db_snapshot` stores the current rows of each table (memory only), `db_diff` returns rows added, changed and removed per table.
  - MCP tools `db_list`, `db_schema`, `db_query`, `db_execute`, `db_snapshot`, `db_diff`, with the M2 output rules (masking, 20 kB cap, truncation said, untrusted data).
  - Sample app: a Drift `orders` table (item, status, created) with an "Add order" button and a status toggle.
- Non-functional: a new row shows in an open table within 1 s; a 10,000-row table pages smoothly at 420 px; queries time out after 5 s (app) and results cap at 500 rows / 20 kB for Claude and 1,000 rows per page in the dashboard; no native Node modules.
- Non-goals: Room, Core Data, Hive, Isar (adapters later); schema migrations; editing the schema; iOS snapshot (live works on iOS); publishing to pub.dev and npm (M5).

## Top 3 qualities

| Quality     | Target                                                                                                               | How we check it                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data safety | No query from Claude or the dashboard can change data unless writes are switched on and the user confirms each write | Guard tests with every known write shape (CTE writes, `RETURNING`, `ATTACH`, `PRAGMA x=y`, `VACUUM INTO`, multiple statements, `writable_schema`), in the daemon and in the Dart package; reviewer security review; QA abuse run |
| Privacy     | Claude sees only what it asks for, masked and capped; nothing is stored on disk except saved queries                 | MCP output tests; QA masking table with personal data in rows                                                                                                                                                                    |
| Live feel   | A new row appears and flashes within 1 s                                                                             | Playwright with the fake backend; QA timing on the emulator                                                                                                                                                                      |

## Estimate

Small: one developer, one to three databases, tables up to about 100,000 rows. Snapshot copies up to 50 MB (refused above, with a message). Snapshots for diff hold at most 10,000 rows per table and 50 MB in total (the rest is reported as "too large to diff").

## Data

- In the app: the user's own database; `flutterdeck_drift` opens a second, read-only connection to the same file for queries (`OpenMode.readOnly`, `PRAGMA query_only=1`, short statements), and uses the app's Drift connection only for confirmed writes (then `notifyUpdates`).
- In the daemon: snapshots for diff in memory; the snapshot backend's copy in memory (sql.js) and never on disk.
- `.flutterdeck/queries.json`: saved queries (name, SQL), written atomically without following links (as in M2).
- Config: `db.allowWrites` (default false), `db.hiddenColumns` per D2.

## Options

### D1 — A no-setup path on Drift's own DevTools extension

**A: Add it as a read-only extra.** When `flutterdeck_drift` isn't installed, FlutterDeck uses Drift's internal `ext.drift.database` read-only: every statement passes the daemon's gate; no `clear`, no writes; the drift version is checked and the path switches off if the protocol changes.

- Benefit: the inspector works live on any debug app with Drift, no setup.
- Cost: relies on an internal API Drift can change in any release; Drift's extension runs any SQL, so the daemon's gate is the only guard; listing databases needs VM `evaluate`; more to maintain.

**B: Not in M3 (recommended).** Live needs `flutterdeck_drift`; without it, the Android snapshot backend works with no setup. Revisit after the validation checkpoint feedback (Later line).

- Benefit: one supported live path, with a guard in the app as well as in the daemon.
- Cost: live mode needs one line in the app.

### D2 — What Claude sees from the database

App databases can hold the personal data of the app's end users.

**A: Rows reach Claude, masked and capped, with hidden columns (recommended).** `db_query` and `db_diff` return rows through the M2 masking layer (emails, phones, tokens, keys…), at most 100 rows / 20 kB by default, and never the columns listed in `db.hiddenColumns` (e.g. `users.password_hash`, `users.email`), which show as `[hidden]`. The dashboard shows full data locally. Documented as the developer's own processing (like M2 D4).

- Benefit: Claude can answer "how many orders are pending?" and check what a change saved.
- Cost: masking is best effort; personal data in free text can still reach Claude.

**B: Schema only by default; rows only after opt-in per project.** `db_query` returns counts and schema; rows need `db.allowRowsForClaude: true`.

- Benefit: private by default.
- Cost: the acceptance check ("Claude uses db_diff") needs the opt-in; most users will switch it on.

### D3 — Can Claude change data?

**A: Yes, only when writes are on, and each write waits for a click in the dashboard (recommended).** `db_execute` refuses unless `db.allowWrites: true`; then the dashboard shows the SQL and "Allow" / "Deny"; it times out after 60 s.
**B: Never in M3.** `db_execute` always refuses; Claude can propose SQL for the user to run in the dashboard.

### D4 — iOS simulator snapshots

Snapshot mode needs a command to read the app's files: `adb` on Android (already allowed). On the iOS simulator it would need `xcrun simctl get_app_container` — a new fixed command, which changes a security rule.
**A: Android only in M3 (recommended);** iOS works through the live backend. **B:** add `xcrun simctl` now.

## Decision

Waiting for PM on D1–D4. Recommendations: D1 B, D2 A, D3 A, D4 A. ADR 0004 (app extensions in core) and ADR 0005 (read-only gate) are proposed and need no PM decision beyond approving this plan.

## Design details

**flutterdeck_drift (Dart)**

- `FlutterDeckDrift.register(GeneratedDatabase db, {required String name})`: returns at once and does nothing unless `kDebugMode`. Registers `ext.flutterdeck.drift.v1.list`, `.schema`, `.query`, `.execute`, and posts `flutterdeck.drift.tables` events (`{db, tables: [{name, kind}]}`) from `db.tableUpdates()`, debounced 100 ms.
- Query: prepared on the read-only connection with `checkNoTail: true`, must be `isReadOnly` (or `isExplain` of a read-only statement), `ATTACH`/`DETACH`/`PRAGMA` with a value refused by a token check as a second guard; rows streamed with a hard cap (default 1,000, max 5,000) and a 5 s time limit; values typed (int, double, text, blob as base64 with size, null).
- Execute: only after the daemon sends the write token it got from the user's confirm (one-time, 60 s); runs through Drift (`customStatement` in a transaction) then `notifyUpdates` for the tables SQLite reports (`changes`), returns `{changes}`.
- Version and protocol: every reply carries `protocol: 1`; the daemon refuses unknown versions with "Update flutterdeck_drift".
- Tests: Dart unit tests with `NativeDatabase.memory()`; a release-mode test that nothing registers.

**Read-only gate (daemon, ADR 0005)**

- `packages/sql-guard`: @sqlite.org/sqlite-wasm with the target schema loaded into a scratch in-memory database (app-defined functions stubbed). A statement passes only if: one statement (empty tail), `stmt_readonly == 1` (or `stmt_isexplain` and its inner statement read-only), and an authorizer allowlist sees only `SELECT`, `READ`, `FUNCTION` (not `load_extension` or `writefile`-style names), `RECURSIVE`, and `PRAGMA table_info`/`table_xinfo`/`index_list`/`foreign_key_list` with no value. Refusals name the reason in plain words.
- Both backends receive only statements the gate passed. The app still checks again (defence in depth).

**Snapshot backend**

- adb commands (fixed, validated, from the home folder): `exec-out run-as <applicationId> ls -1 app_flutter databases` and `exec-out run-as <applicationId> cat <dir>/<file>`; `applicationId` from `.flutterdeck/config.json` (written by `init`) or the running app's process name, validated `^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$`; file names `^[A-Za-z0-9._-]+\.(sqlite|db)$`; size cap 50 MB; `SQLite format 3\0` header required; WAL merged with salt and checksum checks; a hot `-journal` → retry once, then "The app is writing; try Refresh".

**Snapshots and diff**

- `db_snapshot(db, label?)` → id; stores primary-key → row hash and row values per table (tables without a primary key use rowid). `db_diff(db, snapshotId?)` compares with now: per table, rows added, changed (with changed columns), removed; capped and masked for Claude.

**Dashboard**

- Database tab first (per the plan), Logs, Activity. Details in the UI spec.

## Failure plan

- Extension calls: 5 s timeout; app gone → "The app stopped"; extension missing → "Add flutterdeck_drift (see setup)" with the snippet; protocol mismatch → "Update flutterdeck_drift".
- Snapshot: adb missing / not debuggable / file too big / journal busy → clear message, nothing partial shown.
- Gate refusal → message with the reason; nothing reaches the app.
- Write confirm timeout → "Not allowed (no answer in 60 s)".
- Live events lost (reconnect) → re-query open tables on reconnect.

## Observability

- Activity entries: "Snapshot taken", "Diff shown", "Write allowed / denied" (SQL never stored in Activity; only the table names and change count).
- Daemon stderr: backend errors without SQL text or row data.

## Trust boundaries and abuse cases

- Boundaries: app database content (untrusted, personal data) → dashboard and Claude; Claude's SQL → daemon gate → app; dashboard SQL → gate; adb output → snapshot parser; `.flutterdeck/queries.json` and config (cloned repo).
- Abuse cases:
  - As Claude (prompt-injected by a row value) I run `DELETE …` through `db_query` — mitigation: daemon gate + read-only connection + `isReadOnly` in the app.
  - As Claude I run `WITH x AS (DELETE … RETURNING *) SELECT …`, `ATTACH 'file' AS x`, `PRAGMA writable_schema=1`, `VACUUM INTO`, `SELECT 1; DROP TABLE` — mitigation: gate rules and tests for each.
  - As Claude I call `db_execute` to destroy data — mitigation: off by default; per-write confirm in the dashboard (D3 A).
  - As a row value I contain HTML or a script — mitigation: text-only rendering (M2 rules), CSV export escapes formulas (`=`, `+`, `-`, `@` prefixed with `'`).
  - As a row value I tell Claude to do something — mitigation: tool descriptions say rows are untrusted data.
  - As a huge table I exhaust memory — mitigation: row caps, snapshot and diff caps, 50 MB snapshot limit.
  - As a crafted database file (snapshot) I exploit the parser — mitigation: sql.js in wasm, read-only, header check, size cap.
  - As a cloned repo I set `db.allowWrites: true` and saved queries that delete — mitigation: allowWrites still needs a per-write confirm; saved queries run through the same gate; the dashboard shows "Writes are on (from .flutterdeck/config.json)".
  - As a release build I expose my database — mitigation: `kDebugMode` only; test that nothing registers in release and profile.
  - As another process on the device I read the copied snapshot — mitigation: the copy stays in daemon memory only.

## Privacy

Not legal advice. Items marked "PM decides" need the PM's decision before the developer starts.

| Field                                                          | Purpose                                                       | Lawful basis (PM decides)                                                                                   | Retention                                                                                                | Shared with                                                                   | Notes                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| Rows of the app's database (may hold end users' personal data) | Let the developer and Claude inspect and debug the app's data | PM decides with D2 — options: the developer's own processing (as M2 D4), or opt-in before rows go to Claude | Dashboard: memory while shown; snapshots: memory until the daemon stops or 20 snapshots (oldest dropped) | Claude (Anthropic) only for `db_query` / `db_diff` results (D2); nowhere else | Masking + caps + hidden columns (D2 A) |
| Snapshot file copy (Android)                                   | Inspect without the package                                   | as above                                                                                                    | Memory only, replaced on Refresh, gone on daemon stop                                                    | none                                                                          | Never written to disk                  |
| Saved queries                                                  | Reuse SQL                                                     | n/a — the developer's own SQL                                                                               | Until deleted                                                                                            | none (git if the user commits it)                                             | `.flutterdeck/queries.json`            |

- Fields removed: none beyond the hidden columns the user sets.
- DPIA screening: none of the ICO triggers apply to FlutterDeck itself (no profiling, local only). The developer's app may need one; out of scope — not needed because FlutterDeck stores no rows on disk and sends rows only on the developer's request.
- Children likely: no (developer tool). Automated decisions: none. Special category data: possible in app data → covered by D2.
- New vendors / SDKs / transfers: none new; new libraries are local only (sqlite-wasm, sql.js, CodeMirror, package:sqlite3 in the app's debug build).
- Private defaults: writes off; masking on; row caps.
- Export, delete, rectify: export is the developer's own action; snapshots deleted on daemon stop; nothing to rectify.
- Escalated to PM: D2 (and its lawful basis), D3.

## Rollout and rollback

Batches, each through developer → tester → reviewer → QA → merge:

1. `feat/db-core`: core `DbInspector` zod schemas, `AppSession.extensions` (ADR 0004), `packages/sql-guard` (ADR 0005), fakes; `docs/notes/drift.md`.
2. `feat/flutterdeck-drift`: `dart/flutterdeck_drift` + Drift in `examples/sample_app` (orders), Dart tests, CI job for the package; recorded extension fixtures.
3. `feat/db-backends`: `db-drift`, `packages/android-adb` (moved from logs-android), `db-sqlite` with WAL merge; daemon `/api/db/*` routes with the gate; snapshots and diff in the daemon.
4. `feat/dashboard-db`: Database tab — browse, schema diagram, SQL editor, saved queries, live flash, diff view, export, guarded editing.
5. `feat/mcp-db`: the six MCP tools with masking, hidden columns, caps and the write confirm flow.
6. M3 acceptance (QA + PM check) and the validation checkpoint drafts (demo script, install guide, post text; the PM publishes).

Rollback: revert the batch's merge commit; `flutterdeck_drift` is a path dependency of the sample app only until M5.

## Later lines

- No-setup live path on Drift's own DevTools extension (D1 B) — internal API, no in-app read-only guard — trigger: 5 or more feedback replies asking for live mode without adding a package — noted 2026-10-16 by lead
- iOS simulator snapshots (D4 A) — needs `xcrun simctl`, a new command — trigger: 3 user requests for snapshot mode on iOS — noted 2026-10-16 by lead
- Room / Isar / Hive inspectors — other databases — trigger: 3 user requests for one of them — noted 2026-10-16 by lead
