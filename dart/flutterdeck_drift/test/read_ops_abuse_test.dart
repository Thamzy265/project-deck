// Tester probes of the read connection (design note S2, S4, D5; ADR 0005).
// Tests marked `skip: 'FD-n ...'` are known bugs: they fail today
// (`dart test --run-skipped` shows it) and the skip goes when fixed.
import 'dart:io';

import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/read_ops.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

Matcher refusedWith(String code) =>
    throwsA(isA<DriftDeckError>().having((e) => e.code, 'code', code));

void main() {
  late Directory dir;
  late String path;
  late String otherPath;
  late Database app;
  late ReadOps ops;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_abuse');
    path = '${dir.path}/app.sqlite';
    otherPath = '${dir.path}/other.sqlite';
    final other = sqlite3.open(otherPath);
    other.execute("CREATE TABLE secret (x); INSERT INTO secret VALUES ('s');");
    other.close();
    app = sqlite3.open(path);
    app.execute('''
      CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT);
      INSERT INTO orders VALUES (1, 'Coffee');
    ''');
    ops = ReadOps.open(path);
  });

  tearDown(() {
    ops.close();
    app.close();
    dir.deleteSync(recursive: true);
  });

  Map<String, Object?> q(String sql, [List<Object?> params = const []]) =>
      ops.query(sql, params, 10);

  group('FD-1: an empty statement before the real one', () {
    test('a leading ";" cannot attach another database file', () {
      expect(
        () => q(";ATTACH '$otherPath' AS x"),
        refusedWith(ErrorCode.notReadOnly),
      );
      expect(
        () => q('SELECT * FROM x.secret'),
        refusedWith(ErrorCode.sqlError),
        reason: 'nothing may stay attached to the read connection',
      );
      final names = ops.db.select('PRAGMA database_list');
      expect(names.map((r) => r['name']), ['main']);
    });

    test('a leading ";" cannot change the connection settings', () {
      for (final sql in [
        ';PRAGMA query_only=0',
        ';PRAGMA writable_schema=1',
        ';PRAGMA temp_store=MEMORY',
        ';PRAGMA cache_size=-1000000',
      ]) {
        expect(() => q(sql), refusedWith(ErrorCode.notReadOnly), reason: sql);
      }
      expect(ops.db.select('PRAGMA query_only').first.values.first, 1);
      expect(ops.db.select('PRAGMA temp_store').first.values.first, 1);
    });

    test('lock: a leading ";" before BEGIN never leaves a transaction', () {
      // Passes today only because guarded() rolls back after every query.
      try {
        q(';BEGIN');
      } on DriftDeckError {
        // Refusing it is the fix for FD-1.
      }
      expect(ops.db.autocommit, isTrue);
    });
  });

  group('locks: read bypasses SQLite itself stops', () {
    test('load_extension is not authorized', () {
      expect(
        () => q("SELECT load_extension('${dir.path}/x')"),
        refusedWith(ErrorCode.sqlError),
      );
    });

    test('VACUUM INTO writes no file, even after a leading ";"', () {
      for (final sql in [
        "VACUUM INTO '${dir.path}/a.db'",
        ";VACUUM INTO '${dir.path}/b.db'",
        "EXPLAIN VACUUM INTO '${dir.path}/c.db'",
      ]) {
        expect(() => q(sql), refusedWith(ErrorCode.notReadOnly), reason: sql);
      }
      for (final f in ['a', 'b', 'c']) {
        expect(File('${dir.path}/$f.db').existsSync(), isFalse);
      }
    });

    test('temp objects and schema edits are refused', () {
      for (final sql in [
        'CREATE TEMP TABLE t (x)',
        ';CREATE TEMP VIEW v AS SELECT 1',
        'CREATE TEMP TRIGGER tr AFTER INSERT ON orders BEGIN SELECT 1; END',
        'WITH x AS (SELECT 1) INSERT INTO orders (item) SELECT * FROM x',
        'EXPLAIN QUERY PLAN DELETE FROM orders',
        'REPLACE INTO orders VALUES (1, 1)',
      ]) {
        expect(() => q(sql), refusedWith(ErrorCode.notReadOnly), reason: sql);
      }
      // SQLite refuses this one while it prepares, before isReadOnly.
      expect(
        () => q("UPDATE sqlite_schema SET sql = 'x'"),
        refusedWith(ErrorCode.sqlError),
      );
      expect(app.select('SELECT item FROM orders').single['item'], 'Coffee');
    });

    test('very long SQL is refused before it is prepared', () {
      final sql = 'SELECT 1 ${'-' * maxSqlLength}';
      expect(() => q(sql), refusedWith(ErrorCode.badRequest));
      expect(
        () => ops.checkWrite('DELETE FROM orders ${' ' * maxSqlLength}'),
        refusedWith(ErrorCode.badRequest),
      );
    });

    test('non-finite doubles come back tagged', () {
      // Cross-branch: core's CellSchema on feat/db-core accepts no
      // {type: 'real'} cell, so the daemon will reject this reply (FD-10).
      expect(q('SELECT 1e999, -1e999')['rows'], [
        [
          {'type': 'real', 'value': 'Infinity'},
          {'type': 'real', 'value': '-Infinity'},
        ],
      ]);
    });
  });

  test('FD-4: a wrong number of parameters is a bad request, not internal', () {
    expect(() => q('SELECT ?'), refusedWith(ErrorCode.badRequest));
    expect(() => q('SELECT ?', [1, 2]), refusedWith(ErrorCode.badRequest));
  });

  group('FD-5: schema survives one object the read connection cannot use', () {
    test('a view that uses a Drift function (REGEXP)', () {
      app.createFunction(
        functionName: 'regexp',
        argumentCount: const AllowedArgumentCount(2),
        function: (args) => true,
      );
      app.execute(
        "CREATE VIEW coffee AS SELECT * FROM orders WHERE item REGEXP 'C'",
      );
      final tables = ops.schema()['tables']! as List;
      expect(tables.map((t) => (t as Map)['name']), contains('orders'));
    });

    test('a virtual table whose module the read connection lacks', () {
      app.execute('''
          PRAGMA writable_schema = ON;
          INSERT INTO sqlite_schema VALUES ('table', 'vt', 'vt', 0,
            'CREATE VIRTUAL TABLE vt USING nosuchmod()');
          PRAGMA writable_schema = OFF;
        ''');
      ops.close();
      ops = ReadOps.open(path);
      final tables = ops.schema()['tables']! as List;
      expect(tables.map((t) => (t as Map)['name']), contains('orders'));
      final snap = ops.snapshot()['tables']! as List;
      expect(snap.map((t) => (t as Map)['name']), contains('orders'));
    });
  });

  test('FD-6: schema lists generated columns', () {
    app.execute(
      'CREATE TABLE g (id INTEGER PRIMARY KEY, a TEXT, '
      'b TEXT GENERATED ALWAYS AS (upper(a)) VIRTUAL)',
    );
    final g = (ops.schema()['tables']! as List)
        .cast<Map<String, Object?>>()
        .firstWhere((t) => t['name'] == 'g');
    final names = (g['columns']! as List).map((c) => (c as Map)['name']);
    expect(names, ['id', 'a', 'b']);
  });

  test('FD-7: snapshot keys are unique when a primary key holds NULLs', () {
    // A non-INTEGER PRIMARY KEY in a rowid table may hold NULL, more than
    // once (a SQLite quirk), so the key does not identify the row.
    app.execute('''
        CREATE TABLE k (code TEXT PRIMARY KEY, n INTEGER);
        INSERT INTO k VALUES (NULL, 1), (NULL, 2), ('a', 3);
      ''');
    final k = (ops.snapshot()['tables']! as List)
        .cast<Map<String, Object?>>()
        .firstWhere((t) => t['name'] == 'k');
    final keys = (k['rows']! as List).map((r) => '${(r as List).first}');
    expect(keys.toSet(), hasLength(keys.length));
  });

  test(
    'FD-8: a key from snapshot can be read back with rows (non-finite real)',
    () {
      app.execute('''
        CREATE TABLE r (v REAL PRIMARY KEY, x);
        INSERT INTO r VALUES (1e999, 'inf');
      ''');
      final r = (ops.snapshot()['tables']! as List)
          .cast<Map<String, Object?>>()
          .firstWhere((t) => t['name'] == 'r');
      final key = ((r['rows']! as List).single as List).first;
      final back = ops.rows('r', [key]);
      expect(back['missing'], isEmpty);
    },
    skip: 'FD-8 (known bug): decodeParam refuses {type: real} keys',
  );

  test(
    'FD-9: table names match the way SQLite matches them (any case)',
    () {
      expect(ops.rows('ORDERS', [1])['rows'], hasLength(1));
      expect(
        ops.checkWrite('DELETE FROM ORDERS WHERE id = 1')['table'],
        isNotNull,
      );
    },
    skip: 'FD-9 (known bug): rows and checkWrite compare names by case',
  );

  group('locks: rows with odd keys', () {
    setUp(() {
      app.execute('''
        -- NOT NULL keys: a nullable key is matched by rowid (FD-7).
        CREATE TABLE c (a TEXT NOT NULL, b INTEGER NOT NULL, v, PRIMARY KEY (a, b));
        INSERT INTO c VALUES ('x', 1, 'one'), ('[1]', 2, 'two');
      ''');
    });

    test('composite keys need an array of the right length', () {
      expect(() => ops.rows('c', ['x']), refusedWith(ErrorCode.badRequest));
      expect(
        () => ops.rows('c', [
          ['x'],
        ]),
        refusedWith(ErrorCode.badRequest),
      );
      expect(
        () => ops.rows('c', [
          ['x', 1, 2],
        ]),
        refusedWith(ErrorCode.badRequest),
      );
      expect(
        ops.rows('c', [
          ['[1]', 2],
          ['x', 1],
        ])['rows'],
        hasLength(2),
      );
    });

    test('objects and nested lists are bad keys; null is just missing', () {
      expect(
        () => ops.rows('orders', [
          {'a': 1},
        ]),
        refusedWith(ErrorCode.badRequest),
      );
      expect(
        () => ops.rows('orders', [
          [1],
        ]),
        refusedWith(ErrorCode.badRequest),
      );
      expect(ops.rows('orders', [null])['missing'], [null]);
      expect(ops.rows('orders', [1.0])['rows'], hasLength(1));
      expect(ops.rows('orders', [true])['rows'], hasLength(1));
    });

    test('1,000 keys pass and 1,001 are refused', () {
      final keys = List<Object?>.generate(1000, (i) => i);
      final r = ops.rows('orders', keys);
      expect((r['missing']! as List).length, 999);
      expect(
        () => ops.rows('orders', [...keys, 1000]),
        refusedWith(ErrorCode.badRequest),
      );
    });

    test('a blob over 64 KB is cut in a cell but whole in a key', () {
      app.execute(
        'CREATE TABLE b (k BLOB NOT NULL PRIMARY KEY, v BLOB);'
        'INSERT INTO b VALUES (zeroblob(70000), zeroblob(70000));',
      );
      final b = (ops.snapshot()['tables']! as List)
          .cast<Map<String, Object?>>()
          .firstWhere((t) => t['name'] == 'b');
      final key = ((b['rows']! as List).single as List).first! as Map;
      expect(key['bytes'], 70000);
      expect(key.containsKey('truncated'), isFalse);
      final back = ops.rows('b', [key]);
      final cell = ((back['rows']! as List).single as List)[1] as List;
      expect((cell[1]! as Map)['truncated'], isTrue);
      expect((cell[1]! as Map)['bytes'], 70000);
    });
  });
}
