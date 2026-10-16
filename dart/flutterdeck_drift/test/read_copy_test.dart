// Reads from an in-memory copy for apps not using WAL (PM decision,
// 2026-10-16: "Read a copy (Recommended)"). On Android the Dart profiler's
// signals cut SQLite's busy-handler sleeps short, so an app write that meets
// a long inspector read fails at once (QA finding F1). Reading a copy made in
// small backup steps means the inspector holds no lock while a query runs.
import 'dart:io';

import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/read_ops.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import 'fds.dart';

Matcher refusedWith(String code) =>
    throwsA(isA<DriftDeckError>().having((e) => e.code, 'code', code));

void main() {
  late Directory dir;
  late String path;
  late Database app;
  late ReadOps ops;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_copy');
    path = '${dir.path}/app.sqlite';
    app = sqlite3.open(path);
    app.execute('''
      CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, n REAL);
      CREATE INDEX orders_item ON orders (item);
      CREATE TABLE pairs (a TEXT NOT NULL, b INTEGER NOT NULL, v,
        PRIMARY KEY (a, b)) WITHOUT ROWID;
      CREATE VIEW teas AS SELECT * FROM orders WHERE item = 'Tea';
      INSERT INTO orders (item, n) VALUES ('Coffee', 1.5), ('Tea', NULL);
      INSERT INTO pairs VALUES ('x', 1, x'0102'), ('y', 2, 'two');
    ''');
    ops = ReadOps.open(path);
  });

  tearDown(() {
    ReadOps.copyCap = 50 * 1024 * 1024;
    ReadOps.copyBudget = readBudget;
    ReadOps.readLive = false;
    ops.close();
    app.close();
    dir.deleteSync(recursive: true);
  });

  test('a failed copy-connection setup closes the file connection (R3-5)', () {
    final before = openDescriptors(path);
    ReadOps.openCopy = () => throw StateError('no memory for the copy');
    addTearDown(() => ReadOps.openCopy = sqlite3.openInMemory);
    expect(
      () => ReadOps.open(path),
      throwsA(
        isA<DriftDeckError>().having((e) => e.code, 'code', ErrorCode.internal),
      ),
    );
    expect(openDescriptors(path), before);
  });

  test('a rollback-journal database is read from a copy', () {
    final r = ops.query('SELECT item FROM orders ORDER BY id', const [], 10);
    expect(r['rows'], [
      ['Coffee'],
      ['Tea'],
    ]);
    expect(ops.lastReadFromCopy, isTrue);
  });

  test('the copy is reused until the database changes', () {
    final before = ops.copies;
    ops.query('SELECT 1', const [], 10);
    ops.schema();
    ops.snapshot();
    expect(ops.copies - before, 1);

    app.execute("INSERT INTO orders (item) VALUES ('Cake')");
    final r = ops.query('SELECT count(*) FROM orders', const [], 10);
    expect(r['rows'], [
      [3],
    ]);
    expect(ops.copies - before, 2);
  });

  test('a database over the copy cap is too large, with a WAL hint', () {
    ReadOps.copyCap = 4096;
    expect(
      () => ops.query('SELECT 1', const [], 10),
      throwsA(
        isA<DriftDeckError>()
            .having((e) => e.code, 'code', ErrorCode.tooLarge)
            .having((e) => e.message, 'message', contains('WAL')),
      ),
    );
  });

  test('a database that grows over the cap during a copy is too large (R3-4)', () {
    app.execute(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
      "WHERE x < 1000) INSERT INTO orders (item) SELECT printf('%.500c', 'x') "
      'FROM c',
    );
    final size = File(path).lengthSync();
    ReadOps.copyCap = size + 64 * 1024;
    var grown = false;
    ReadOps.afterCopyStep = () {
      if (grown) return;
      grown = true;
      // The app adds about 1 MB between two copy steps.
      app.execute(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
        "WHERE x < 2000) INSERT INTO orders (item) SELECT printf('%.500c', 'y') "
        'FROM c',
      );
    };
    addTearDown(() => ReadOps.afterCopyStep = null);
    expect(
      () => ops.query('SELECT count(*) FROM orders', const [], 10),
      throwsA(
        isA<DriftDeckError>()
            .having((e) => e.code, 'code', ErrorCode.tooLarge)
            .having((e) => e.message, 'message', contains('WAL')),
      ),
    );
    expect(grown, isTrue);
  });

  test('an app that writes all the time gets busy with a WAL hint (R3-3)', () {
    app.execute(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
      "WHERE x < 1000) INSERT INTO orders (item) SELECT printf('%.500c', 'x') "
      'FROM c',
    );
    ReadOps.copyBudget = const Duration(milliseconds: 300);
    // A churning writer: the app commits between every two copy steps, so
    // SQLite restarts the copy each time.
    ReadOps.afterCopyStep = () =>
        app.execute("UPDATE orders SET n = n + 1 WHERE id = 1");
    addTearDown(() => ReadOps.afterCopyStep = null);
    expect(
      () => ops.query('SELECT 1', const [], 10),
      throwsA(
        isA<DriftDeckError>()
            .having((e) => e.code, 'code', ErrorCode.busy)
            .having((e) => e.message, 'message', contains('WAL')),
      ),
    );
  });

  test('a page size change resets the read connection (R3-2)', () {
    ops.query('SELECT 1', const [], 10);
    app.execute('PRAGMA page_size = 8192');
    app.execute('VACUUM');
    // SQLite can't copy into an in-memory database with another page size
    // (SQLITE_READONLY); a fresh connection can.
    expect(
      () => ops.query('SELECT count(*) FROM orders', const [], 10),
      throwsA(
        isA<DriftDeckError>()
            .having((e) => e.code, 'code', ErrorCode.internal)
            .having((e) => e.message, 'message', contains('reset')),
      ),
    );
    expect(ops.broken, isTrue);
    ops.close();
    ops = ReadOps.open(path);
    expect(ops.query('SELECT count(*) FROM orders', const [], 10)['rows'], [
      [2],
    ]);
  });

  test('a copy that runs out of time stops and holds no lock', () {
    app.execute(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
      "WHERE x < 20000) INSERT INTO orders (item) SELECT printf('%.500c', 'x') "
      'FROM c',
    );
    ReadOps.copyBudget = Duration.zero;
    expect(
      () => ops.query('SELECT 1', const [], 10),
      refusedWith(ErrorCode.timeout),
    );
    // No lock left behind: the app can write with no busy timeout.
    app.execute("INSERT INTO orders (item) VALUES ('after')");
    ReadOps.copyBudget = readBudget;
    expect(ops.query('SELECT count(*) FROM orders', const [], 10)['rows'], [
      [20003],
    ]);
  });

  test('the copy answers exactly like the live database', () {
    Map<String, Object?> all() {
      final query = ops.query(
        'SELECT * FROM orders o LEFT JOIN pairs p ON p.b = o.id ORDER BY o.id',
        const [],
        100,
      )..remove('durationMs');
      final snapshot = ops.snapshot()..remove('takenAt');
      return {
        'schema': ops.schema(),
        'query': query,
        'snapshot': snapshot,
        'rows': ops.rows('pairs', [
          ['x', 1],
          ['y', 2],
        ]),
      };
    }

    final fromCopy = all();
    expect(ops.lastReadFromCopy, isTrue);
    ReadOps.readLive = true;
    final live = all();
    expect(ops.lastReadFromCopy, isFalse);
    expect(fromCopy, live);
  });

  test('a WAL database is read live', () {
    ops.close();
    app.execute('PRAGMA journal_mode = WAL');
    ops = ReadOps.open(path);
    final r = ops.query('SELECT count(*) FROM orders', const [], 10);
    expect(r['rows'], [
      [2],
    ]);
    expect(ops.lastReadFromCopy, isFalse);
  });
}
