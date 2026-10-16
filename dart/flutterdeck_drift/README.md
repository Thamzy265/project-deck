# flutterdeck_drift

Lets [FlutterDeck](../../README.md) show your app's [Drift](https://drift.simonbinder.eu) database live, in debug builds only.

## Setup

Add the package (a path dependency until it is published):

```yaml
dependencies:
  flutterdeck_drift:
    path: <path to this folder>
```

In your app's `main()`, after you create the database:

```dart
FlutterDeckDrift.register(db, name: 'app');
```

It does nothing in release builds (and in profile builds). Register each database once, with its own name, if your app has more than one.

## What it does in a debug build

- It registers the VM service extensions `ext.flutterdeck.drift.v1.list`, `.schema`, `.query`, `.snapshot`, `.rows` and `.execute`. The FlutterDeck daemon calls them through the app's VM service. Nothing listens on a port.
- It posts a `flutterdeck.drift.tables` event (at most one per 100 ms) when tables of the database change, so the dashboard can show new rows.
- Reads run in a background isolate on a second, read-only connection to the same file. That connection has none of your app's SQL functions. A read must be one reading statement; it stops after 5 seconds and returns at most 5,000 rows and 8 MB.
- If your database doesn't use WAL (drift_flutter's default is the rollback journal), FlutterDeck reads a private in-memory copy. It makes the copy in small steps (64 pages each, a few milliseconds), holds no lock on your file between steps, and makes a new copy only after your app changed the database. So a long query never blocks your app's writes. If your app writes all the time, a copy keeps starting over and the read answers "busy". Databases over 50 MB are not copied. In both cases, turn on WAL (`PRAGMA journal_mode = WAL`, for example in Drift's `setup`) to read them live. With WAL, FlutterDeck reads your file directly; WAL readers never block writers.
- The first time FlutterDeck reads a database that doesn't use WAL, it sets a busy timeout of 7 seconds on your app's connection if it has none, so a write that meets a copy step waits a few milliseconds instead of failing. A timeout your app set is never changed, and nothing is set in WAL mode.
- It changes data only for an edit you confirm in the FlutterDeck dashboard, with `db.allowWrites` on. Claude never changes data.
- An edit is one `INSERT`, `REPLACE`, `UPDATE` or `DELETE` on one table. Your triggers and foreign-key actions run as usual. After the edit, Drift's streams and the dashboard are told about the table and every table its triggers write to or whose foreign keys cascade from it (`CASCADE`, `SET NULL`, `SET DEFAULT`), followed on from there. SQLite doesn't report which tables a statement changed, so this list comes from the schema and can name a table that didn't change. `REPLACE` and `INSERT OR REPLACE` are reported as updates.

In-memory and encrypted (SQLCipher) databases are not supported.

## Protocol

Every reply holds `protocol: 1`. Errors are `{"protocol": 1, "error": {"code", "message"}}`. Codes: `bad-request`, `unknown-db`, `not-read-only`, `not-allowed`, `timeout`, `busy`, `too-large`, `unsupported`, `bad-token`, `sql-error`, `not-found`, `internal`. In `schema` and `snapshot`, a table or view the read connection can't use (for example a view that calls one of your app's SQL functions) gets its own `error` entry, and the other tables still answer. The `schema` reply also holds `sqlSchema`: every `CREATE` statement in `sqlite_schema` (tables, views, indexes, triggers, virtual tables) in schema order, read in the same transaction, for the daemon's read-only check. If it would make the reply larger than 8 MB it is cut, and `sqlSchemaTruncated: true` says so. Write tokens are single use per app isolate; the daemon enforces single use across hot restarts. Recorded examples: [`packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json`](../../packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json).

## Development

```bash
dart pub get
dart analyze
dart test
```

To record the fixtures again:

```bash
dart run --enable-vm-service=0 tool/record_fixtures.dart ../../packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json
```

Then run `pnpm exec prettier --write` on the file from the repo root.

## Licence

MIT
