import 'dart:io';
import 'dart:typed_data';

import 'package:flutterdeck_drift/src/cells.dart';
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/read_ops.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

Matcher refusedWith(String code) =>
    throwsA(isA<DriftDeckError>().having((e) => e.code, 'code', code));

void main() {
  late Directory dir;
  late String path;
  late Database app;
  late ReadOps ops;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_ops');
    path = '${dir.path}/app.sqlite';
    app = sqlite3.open(path);
    app.execute('''
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX orders_status ON orders (status);
      CREATE TABLE lines (
        order_id INTEGER NOT NULL REFERENCES orders (id),
        n INTEGER NOT NULL,
        qty REAL,
        PRIMARY KEY (order_id, n)
      ) WITHOUT ROWID;
      CREATE TABLE notes (body TEXT, data BLOB);
      CREATE VIEW pending AS SELECT * FROM orders WHERE status = 'pending';
      CREATE VIRTUAL TABLE docs USING fts5(body);
      INSERT INTO orders (item, created_at) VALUES ('Coffee', 1), ('Tea', 2);
      UPDATE orders SET status = 'shipped' WHERE id = 2;
      INSERT INTO lines VALUES (1, 1, 2.5), (1, 2, NULL);
      INSERT INTO notes VALUES ('big', 9223372036854775807), ('blob', x'0102');
      INSERT INTO docs VALUES ('hello world');
    ''');
    ops = ReadOps.open(path);
  });

  tearDown(() {
    ops.close();
    app.close();
    dir.deleteSync(recursive: true);
  });

  group('query', () {
    test('returns typed cells, columns and timing', () {
      final r = ops.query(
        "SELECT id, item, 2.5 AS d, NULL AS n, x'0102' AS b, "
        '9007199254740993 AS big FROM orders WHERE id = ?',
        [1],
        10,
      );
      expect(r['columns'], ['id', 'item', 'd', 'n', 'b', 'big']);
      expect(r['rows'], [
        [
          1,
          'Coffee',
          2.5,
          null,
          {'type': 'blob', 'bytes': 2, 'base64': 'AQI='},
          {'type': 'int', 'value': '9007199254740993'},
        ],
      ]);
      expect(r['truncated'], isFalse);
      expect(r['durationMs'], isA<num>());
    });

    test('caps rows at the limit and says so', () {
      final r = ops.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
        'WHERE x < 100) SELECT x FROM c',
        const [],
        10,
      );
      expect(r['rows'], hasLength(10));
      expect(r['truncated'], isTrue);
    });

    test('caps the reply at 8 MB and says so', () {
      final r = ops.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
        "WHERE x < 5000) SELECT printf('%.*c', 4000, 'x') FROM c",
        const [],
        maxRowLimit,
      );
      expect(r['truncated'], isTrue);
      expect(jsonSize(r['rows']), lessThanOrEqualTo(maxReplyBytes));
    });

    test('runs EXPLAIN and the allowed pragmas', () {
      expect(
        ops.query('EXPLAIN QUERY PLAN SELECT * FROM orders', const [], 10),
        containsPair('truncated', false),
      );
      final r = ops.query('PRAGMA table_info(orders)', const [], 10);
      expect(r['rows'], hasLength(4));
    });

    final refusals = <String, String>{
      "INSERT INTO orders (item, created_at) VALUES ('x', 1)":
          ErrorCode.notReadOnly,
      'DELETE FROM orders RETURNING *': ErrorCode.notReadOnly,
      'WITH x AS (SELECT 1) DELETE FROM orders': ErrorCode.notReadOnly,
      'UPDATE orders SET item = 1 RETURNING id': ErrorCode.notReadOnly,
      'EXPLAIN DELETE FROM orders': ErrorCode.notReadOnly,
      'BEGIN': ErrorCode.notReadOnly,
      'BEGIN IMMEDIATE': ErrorCode.notReadOnly,
      'SAVEPOINT s': ErrorCode.notReadOnly,
      'COMMIT': ErrorCode.notReadOnly,
      "ATTACH '/tmp/x.db' AS x": ErrorCode.notReadOnly,
      'DETACH main': ErrorCode.notReadOnly,
      'PRAGMA writable_schema=1': ErrorCode.notReadOnly,
      'PRAGMA query_only=0': ErrorCode.notReadOnly,
      'PRAGMA user_version=3': ErrorCode.notReadOnly,
      'VACUUM': ErrorCode.notReadOnly,
      "VACUUM INTO '/tmp/copy.db'": ErrorCode.notReadOnly,
      'CREATE TABLE x (a)': ErrorCode.notReadOnly,
      'DROP TABLE orders': ErrorCode.notReadOnly,
      'SELECT 1; DROP TABLE orders': ErrorCode.notReadOnly,
      'SELECT 1; SELECT 2': ErrorCode.notReadOnly,
      '': ErrorCode.notReadOnly,
    };
    refusals.forEach((sql, code) {
      test('refuses: $sql', () {
        expect(() => ops.query(sql, const [], 10), refusedWith(code));
        expect(ops.db.autocommit, isTrue);
        final count = app.select('SELECT count(*) AS n FROM orders');
        expect(count.first['n'], 2, reason: 'nothing changed');
      });
    });

    test('the file path and raw pages are not readable', () {
      for (final sql in [
        'SELECT file FROM pragma_database_list',
        'SELECT * FROM dbstat',
        'SELECT * FROM sqlite_dbpage',
      ]) {
        expect(
          () => ops.query(sql, const [], 10),
          refusedWith(ErrorCode.notReadOnly),
          reason: sql,
        );
      }
    });

    test('a data-changing CTE is a syntax error, never a write', () {
      expect(
        () => ops.query(
          'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
          const [],
          10,
        ),
        refusedWith(ErrorCode.sqlError),
      );
    });

    test('app functions are not registered on the read connection', () {
      expect(
        () => ops.query("SELECT moor_contains('a', 'b')", const [], 10),
        refusedWith(ErrorCode.sqlError),
      );
    });

    test('values longer than 16 MB fail instead of allocating', () {
      expect(
        () => ops.query('SELECT zeroblob(20000000)', const [], 10),
        refusedWith(ErrorCode.sqlError),
      );
      expect(
        () => ops.query("SELECT printf('%.*c', 1e9, 'x')", const [], 10),
        refusedWith(ErrorCode.sqlError),
      );
    });

    test('the connection is read-only even past the guard', () {
      // Belt and braces: this would only matter if both guards failed.
      expect(
        () => ops.db.execute(
          "INSERT INTO orders (item, created_at) VALUES ('x', 1)",
        ),
        throwsA(isA<SqliteException>()),
      );
    });
  });

  test('schema: an unusable view gets its own error entry', () {
    app.createFunction(
      functionName: 'regexp',
      argumentCount: const AllowedArgumentCount(2),
      function: (args) => true,
    );
    app.execute("CREATE VIEW c AS SELECT * FROM orders WHERE item REGEXP 'C'");
    final tables = (ops.schema()['tables']! as List)
        .cast<Map<String, Object?>>();
    final c = tables.firstWhere((t) => t['name'] == 'c');
    expect(c['kind'], 'view');
    expect(c['columns'], isEmpty);
    expect(c['error'], {
      'code': ErrorCode.unsupported,
      'message': contains('no such function: REGEXP'),
    });
    expect(
      tables.firstWhere((t) => t['name'] == 'orders').containsKey('error'),
      isFalse,
    );
  });

  group('connection check', () {
    // Defence in depth behind the guards (FD-1): if anything ever changes
    // the read connection itself, the next answer is internal and the
    // connection is marked for a reset.
    for (final change in [
      "ATTACH '%dir/app.sqlite' AS x",
      'PRAGMA query_only = 0',
      'PRAGMA temp_store = MEMORY',
    ]) {
      test('notices: $change', () {
        ops.db.execute(change.replaceAll('%dir', dir.path));
        expect(
          () => ops.query('SELECT 1', const [], 10),
          refusedWith(ErrorCode.internal),
        );
        expect(ops.broken, isTrue);
      });
    }

    test('a normal read leaves the connection usable', () {
      ops.query('SELECT * FROM orders', const [], 10);
      ops.schema();
      ops.snapshot();
      expect(ops.broken, isFalse);
    });
  });

  group('schema', () {
    test('lists tables and views with columns, keys and indexes', () {
      final tables = (ops.schema()['tables']! as List)
          .cast<Map<String, Object?>>();
      final names = tables.map((t) => t['name']).toList();
      expect(names, ['docs', 'lines', 'notes', 'orders', 'pending']);
      expect(names.where((n) => '$n'.startsWith('docs_')), isEmpty);
      expect(names.where((n) => '$n'.startsWith('sqlite_')), isEmpty);

      final orders = tables.firstWhere((t) => t['name'] == 'orders');
      expect(orders['kind'], 'table');
      expect(orders['rowCount'], 2);
      expect(orders['sql'], startsWith('CREATE TABLE orders'));
      expect(orders['columns'], [
        {
          'name': 'id',
          'type': 'INTEGER',
          'nullable': false,
          'pk': true,
          'pkPosition': 1,
          'default': null,
        },
        {
          'name': 'item',
          'type': 'TEXT',
          'nullable': false,
          'pk': false,
          'default': null,
        },
        {
          'name': 'status',
          'type': 'TEXT',
          'nullable': false,
          'pk': false,
          'default': "'pending'",
        },
        {
          'name': 'created_at',
          'type': 'INTEGER',
          'nullable': false,
          'pk': false,
          'default': null,
        },
      ]);
      expect(orders['indexes'], [
        {
          'name': 'orders_status',
          'unique': false,
          'columns': ['status'],
        },
      ]);

      final lines = tables.firstWhere((t) => t['name'] == 'lines');
      expect(lines['foreignKeys'], [
        {'from': 'order_id', 'table': 'orders', 'to': 'id'},
      ]);
      final pending = tables.firstWhere((t) => t['name'] == 'pending');
      expect(pending['kind'], 'view');
      expect(pending.containsKey('rowCount'), isFalse);
    });
  });

  test('schema: only rowid aliases and WITHOUT ROWID keys are never null', () {
    app.execute('''
      CREATE TABLE pairs (a INTEGER, b TEXT, PRIMARY KEY (a, b));
      CREATE TABLE strict_pairs (a INTEGER, b TEXT, PRIMARY KEY (a, b))
        WITHOUT ROWID;
      CREATE TABLE alias (id INTEGER PRIMARY KEY, t TEXT);
    ''');
    final tables = (ops.schema()['tables']! as List)
        .cast<Map<String, Object?>>();
    Map<String, bool> nullable(String name) => {
      for (final c
          in (tables.firstWhere((t) => t['name'] == name)['columns']! as List)
              .cast<Map<String, Object?>>())
        c['name']! as String: c['nullable']! as bool,
    };
    expect(nullable('pairs'), {'a': true, 'b': true});
    expect(nullable('strict_pairs'), {'a': false, 'b': false});
    expect(nullable('alias'), {'id': false, 't': true});
  });

  group('snapshot', () {
    Map<String, Object?> table(Map<String, Object?> snap, String name) =>
        (snap['tables']! as List).cast<Map<String, Object?>>().firstWhere(
          (t) => t['name'] == name,
        );

    test('hashes each column per key and skips views and shadow tables', () {
      final snap = ops.snapshot();
      expect(snap['takenAt'], isA<int>());
      final names = (snap['tables']! as List).map((t) => (t as Map)['name']);
      expect(names, isNot(contains('pending')));
      expect(names.where((n) => '$n'.startsWith('docs_')), isEmpty);

      final orders = table(snap, 'orders');
      expect(orders['key'], ['id']);
      expect(orders['columns'], ['id', 'item', 'status', 'created_at']);
      expect(orders.containsKey('rowid'), isFalse);
      final rows = (orders['rows']! as List).cast<List<Object?>>();
      expect(rows.map((r) => r[0]), [1, 2]);
      expect(rows[0][1], [
        cellHash(1),
        cellHash('Coffee'),
        cellHash('pending'),
        cellHash(1),
      ]);
      expect(ops.db.autocommit, isTrue, reason: 'transaction ended');
    });

    test('composite keys are JSON arrays in key order', () {
      final lines = table(ops.snapshot(), 'lines');
      expect(lines['key'], ['order_id', 'n']);
      final rows = (lines['rows']! as List).cast<List<Object?>>();
      expect(rows.map((r) => r[0]), [
        [1, 1],
        [1, 2],
      ]);
      expect((rows[1][1]! as List)[2], cellHash(null));
    });

    test('tables without a key use the rowid and say so', () {
      final notes = table(ops.snapshot(), 'notes');
      expect(notes['rowid'], isTrue);
      expect(notes['key'], ['rowid']);
      final rows = (notes['rows']! as List).cast<List<Object?>>();
      expect(rows.map((r) => r[0]), [1, 2]);
    });

    test('a change shows only in the changed column hash', () {
      final before = table(ops.snapshot(), 'orders');
      app.execute("UPDATE orders SET status = 'cancelled' WHERE id = 1");
      final after = table(ops.snapshot(), 'orders');
      final b = ((before['rows']! as List)[0] as List)[1] as List;
      final a = ((after['rows']! as List)[0] as List)[1] as List;
      expect(
        [for (var i = 0; i < a.length; i++) a[i] != b[i]],
        [false, false, true, false],
      );
    });

    test('a table over 10,000 rows is reported too large, by name', () {
      app.execute(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
        'WHERE x < 10001) INSERT INTO notes (body) SELECT x FROM c',
      );
      final snap = ops.snapshot();
      final notes = table(snap, 'notes');
      expect(notes['error'], {
        'code': ErrorCode.tooLarge,
        'message': 'Too large to diff: more than 10000 rows in notes',
      });
      expect(table(snap, 'orders')['rows'], hasLength(2));
    });

    test('the whole snapshot over 8 MB is refused', () {
      app.execute(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
        "WHERE x < 9000) INSERT INTO lines SELECT 100, x, x FROM c",
      );
      for (var i = 0; i < 20; i++) {
        app.execute('CREATE TABLE wide$i AS SELECT * FROM lines');
      }
      expect(ops.snapshot, refusedWith(ErrorCode.tooLarge));
      expect(ops.db.autocommit, isTrue);
    });
  });

  group('rows', () {
    test('fetches values by key, including composite and missing keys', () {
      final r = ops.rows('orders', [2, 1, 99]);
      expect(r['columns'], ['id', 'item', 'status', 'created_at']);
      expect(r['rows'], [
        [
          2,
          [2, 'Tea', 'shipped', 2],
        ],
        [
          1,
          [1, 'Coffee', 'pending', 1],
        ],
      ]);
      expect(r['missing'], [99]);

      final lines = ops.rows('lines', [
        [1, 2],
      ]);
      expect(lines['rows'], [
        [
          [1, 2],
          [1, 2, null],
        ],
      ]);
    });

    test('rowid tables and tagged keys work', () {
      final r = ops.rows('notes', [
        {'type': 'int', 'value': '2'},
      ]);
      expect((r['rows']! as List).single, [
        {'type': 'int', 'value': '2'},
        [
          'blob',
          {'type': 'blob', 'bytes': 2, 'base64': 'AQI='},
        ],
      ]);
      expect(r['rowid'], isTrue);
    });

    test('refuses unknown tables, views and bad keys', () {
      expect(() => ops.rows('nope', [1]), refusedWith(ErrorCode.notFound));
      expect(() => ops.rows('pending', [1]), refusedWith(ErrorCode.notFound));
      expect(() => ops.rows('lines', [1]), refusedWith(ErrorCode.badRequest));
      expect(
        () => ops.rows('orders', List.filled(maxKeysPerCall + 1, 1)),
        refusedWith(ErrorCode.badRequest),
      );
    });
  });

  group('checkWrite', () {
    test('passes one edit on a known table', () {
      expect(ops.checkWrite("UPDATE orders SET status = 'x' WHERE id = 1"), {
        'table': 'orders',
        'verb': 'UPDATE',
      });
    });

    test('refuses more than one statement, unknown tables and non-edits', () {
      expect(
        () => ops.checkWrite('DELETE FROM orders; DROP TABLE orders'),
        refusedWith(ErrorCode.notAllowed),
      );
      expect(
        () => ops.checkWrite('DELETE FROM nope'),
        refusedWith(ErrorCode.notFound),
      );
      expect(
        () => ops.checkWrite('DROP TABLE orders'),
        refusedWith(ErrorCode.notAllowed),
      );
      expect(
        () => ops.checkWrite("ATTACH 'x' AS y"),
        refusedWith(ErrorCode.notAllowed),
      );
    });
  });

  group('open', () {
    test('a file that is not SQLite is unsupported', () {
      final bad = File('${dir.path}/bad.sqlite')
        ..writeAsBytesSync(Uint8List.fromList(List.filled(4096, 7)));
      expect(() => ReadOps.open(bad.path), refusedWith(ErrorCode.unsupported));
    });

    test('a missing file is unsupported', () {
      expect(
        () => ReadOps.open('${dir.path}/missing.sqlite'),
        refusedWith(ErrorCode.unsupported),
      );
    });
  });
}
