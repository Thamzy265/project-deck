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
- The first time FlutterDeck reads, it sets a busy timeout of 7 seconds on your app's connection if it has none. Without one, a write from your app that meets a read in progress would fail with "database is locked".
- It changes data only for an edit you confirm in the FlutterDeck dashboard, with `db.allowWrites` on. Claude never changes data.

In-memory and encrypted (SQLCipher) databases are not supported.

## Protocol

Every reply holds `protocol: 1`. Errors are `{"protocol": 1, "error": {"code", "message"}}`. Codes: `bad-request`, `unknown-db`, `not-read-only`, `not-allowed`, `timeout`, `busy`, `too-large`, `unsupported`, `bad-token`, `sql-error`, `not-found`, `internal`. In `schema` and `snapshot`, a table or view the read connection can't use (for example a view that calls one of your app's SQL functions) gets its own `error` entry, and the other tables still answer. Write tokens are single use per app isolate; the daemon enforces single use across hot restarts. Recorded examples: [`packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json`](../../packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json).

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
