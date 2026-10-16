import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/service.dart';
import 'package:test/test.dart';

import 'support.dart';

const _v1 = extensionPrefix;

void main() {
  late Directory dir;
  late String path;
  late AppDb app;
  late DriftDeckService service;
  late List<Map<String, Object?>> events;

  setUpAll(() => driftRuntimeOptions.dontWarnAboutMultipleDatabases = true);

  setUp(() async {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_service');
    path = '${dir.path}/app.sqlite';
    app = openAppDb(path);
    await app.addOrder('Coffee');
    events = [];
    service = DriftDeckService(
      post: (kind, data) {
        expect(kind, tablesEventKind);
        events.add(data);
      },
    );
    service.add(app, 'app');
  });

  tearDown(() async {
    await service.dispose();
    await app.close();
    dir.deleteSync(recursive: true);
  });

  Future<Map<String, Object?>> call(
    String action, [
    Map<String, String> params = const {},
  ]) async {
    final reply = await service.handle('$_v1$action', params);
    expect(reply['protocol'], protocolVersion);
    // Every reply must survive JSON as the VM service sends it.
    return (jsonDecode(jsonEncode(reply)) as Map).cast<String, Object?>();
  }

  Object? errorCode(Map<String, Object?> reply) =>
      (reply['error'] as Map?)?['code'];

  group('calls', () {
    test('list names the registered databases', () async {
      expect(await call('list'), {
        'protocol': 1,
        'databases': [
          {'name': 'app'},
        ],
      });
    });

    test('schema and query go through the read isolate', () async {
      final schema = await call('schema', {'db': 'app'});
      final names = (schema['tables']! as List).map((t) => (t as Map)['name']);
      expect(names, ['lines', 'orders', 'raw']);

      final r = await call('query', {
        'db': 'app',
        'sql': 'SELECT item FROM orders WHERE id = ?',
        'params': '[1]',
        'limit': '5',
      });
      expect(r['rows'], [
        ['Coffee'],
      ]);
      expect(r['truncated'], isFalse);
    });

    test('snapshot and rows answer by key', () async {
      final snap = await call('snapshot', {'db': 'app'});
      final orders = (snap['tables']! as List)
          .cast<Map<String, Object?>>()
          .firstWhere((t) => t['name'] == 'orders');
      expect(orders['key'], ['id']);
      final rows = await call('rows', {
        'db': 'app',
        'table': 'orders',
        'keys': '[1]',
      });
      expect(rows['rows'], [
        [
          1,
          [1, 'Coffee', 'pending'],
        ],
      ]);
    });

    test('a write refused as a read changes nothing', () async {
      final r = await call('query', {
        'db': 'app',
        'sql': 'DELETE FROM orders RETURNING *',
      });
      expect(errorCode(r), ErrorCode.notReadOnly);
      expect(await app.count(), 1);
    });

    final bad = <String, Map<String, String>>{
      'unknown db': {'db': 'nope', 'sql': 'SELECT 1'},
      'no db': {'sql': 'SELECT 1'},
      'no sql': {'db': 'app'},
      'limit 0': {'db': 'app', 'sql': 'SELECT 1', 'limit': '0'},
      'limit too big': {'db': 'app', 'sql': 'SELECT 1', 'limit': '5001'},
      'limit not a number': {'db': 'app', 'sql': 'SELECT 1', 'limit': 'x'},
      'params not JSON': {'db': 'app', 'sql': 'SELECT ?', 'params': '['},
      'sql too long': {'db': 'app', 'sql': 'SELECT ${'1' * maxSqlLength}'},
    };
    final expected = {
      'unknown db': ErrorCode.unknownDb,
      'no db': ErrorCode.unknownDb,
    };
    bad.forEach((label, params) {
      test('query refuses: $label', () async {
        final r = await call('query', params);
        expect(errorCode(r), expected[label] ?? ErrorCode.badRequest);
        expect(r.containsKey('rows'), isFalse);
      });
    });

    test('rows refuses missing or too many keys', () async {
      for (final keys in [null, '[]', jsonEncode(List.filled(1001, 1))]) {
        final r = await call('rows', {
          'db': 'app',
          'table': 'orders',
          'keys': ?keys,
        });
        expect(errorCode(r), ErrorCode.badRequest, reason: '$keys');
      }
    });

    test('an unknown method is a bad request', () async {
      final r = await service.handle('${_v1}drop', const {});
      expect(errorCode(r), ErrorCode.badRequest);
      final other = await service.handle('ext.other.x', const {});
      expect(errorCode(other), ErrorCode.badRequest);
    });

    test('an in-memory database is unsupported, with a message', () async {
      final memory = AppDb(NativeDatabase.memory());
      addTearDown(memory.close);
      service.add(memory, 'mem');
      final r = await call('schema', {'db': 'mem'});
      expect(r['error'], {
        'code': ErrorCode.unsupported,
        'message':
            'This is an in-memory database, so FlutterDeck cannot open it.',
      });
    });
  });

  group('events', () {
    test('changes within 100 ms become one event per database', () async {
      await app.addOrder('Tea');
      await app.addOrder('Cake');
      expect(events, isEmpty, reason: 'debounced');
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events, [
        {
          'protocol': 1,
          'db': 'app',
          'tables': [
            {'name': 'orders', 'kind': 'insert'},
          ],
        },
      ]);
    });

    test('mixed kinds say unknown, and only Drift tables are named', () async {
      app.notifyUpdates({
        const TableUpdate('orders', kind: UpdateKind.update),
        const TableUpdate('orders', kind: UpdateKind.delete),
        const TableUpdate('lines'),
        const TableUpdate('raw', kind: UpdateKind.insert),
        const TableUpdate('sqlite_sequence', kind: UpdateKind.insert),
      });
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events.single['tables'], [
        {'name': 'lines', 'kind': 'unknown'},
        {'name': 'orders', 'kind': 'unknown'},
      ]);
    });

    test('no event when only unknown tables change', () async {
      app.notifyUpdates({const TableUpdate('raw')});
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events, isEmpty);
    });

    test('adding the same database again does not double events', () async {
      service.add(app, 'app');
      await app.addOrder('Tea');
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events, hasLength(1));
    });

    test('another database under the same name replaces the old', () async {
      final other = openAppDb('${dir.path}/other.sqlite');
      addTearDown(other.close);
      service.add(other, 'app');
      await app.addOrder('Tea');
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events, isEmpty);
      await other.addOrder('Tea');
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events, hasLength(1));
    });
  });

  group('execute', () {
    test('refuses without a well-formed token', () async {
      for (final token in [null, '', 'short', '${freshToken()}x', '!' * 43]) {
        final r = await call('execute', {
          'db': 'app',
          'sql': 'DELETE FROM orders',
          'token': ?token,
        });
        expect(errorCode(r), ErrorCode.badToken, reason: '$token');
      }
      expect(await app.count(), 1);
    });

    test('notifies tables a trigger or cascade may change (CR-4)', () async {
      await app.customStatement(
        'CREATE TRIGGER orders_lines AFTER UPDATE ON orders BEGIN '
        'INSERT OR IGNORE INTO lines VALUES (NEW.id, 1); END',
      );
      final r = await call('execute', {
        'db': 'app',
        'sql': "UPDATE orders SET status = 'shipped'",
        'token': freshToken(),
      });
      expect(r['changes'], 1);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events.single['tables'], [
        {'name': 'lines', 'kind': 'unknown'},
        {'name': 'orders', 'kind': 'update'},
      ]);
    });

    test('REPLACE is reported as an update', () async {
      final r = await call('execute', {
        'db': 'app',
        'sql': "INSERT OR REPLACE INTO orders (id, item) VALUES (1, 'Tea')",
        'token': freshToken(),
      });
      expect(r['changes'], 1);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(events.single['tables'], [
        {'name': 'orders', 'kind': 'update'},
      ]);
    });

    test('runs one edit, reports changes and notifies Drift', () async {
      final watched = app
          .customSelect('SELECT status FROM orders', readsFrom: {app.orders})
          .watch()
          .map((rows) => rows.map((r) => r.read<String>('status')).toList());
      final seen = <List<String>>[];
      final sub = watched.listen(seen.add);
      addTearDown(sub.cancel);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final r = await call('execute', {
        'db': 'app',
        'sql': 'UPDATE orders SET status = ? WHERE id = ?',
        'params': '["shipped", 1]',
        'token': freshToken(),
      });
      expect(r, {'protocol': 1, 'changes': 1});
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(seen.last, ['shipped']);
      expect(events.single['tables'], [
        {'name': 'orders', 'kind': 'update'},
      ]);
    });

    test('a token works once', () async {
      final token = freshToken();
      Future<Map<String, Object?>> run() => call('execute', {
        'db': 'app',
        'sql': "INSERT INTO orders (item) VALUES ('Tea')",
        'token': token,
      });
      expect((await run())['changes'], 1);
      expect(errorCode(await run()), ErrorCode.badToken);
      expect(await app.count(), 2);
    });

    test('a refused edit does not use up its token (CR-6)', () async {
      final token = freshToken();
      final failures = <Map<String, String>>[
        {'db': 'nope', 'sql': 'DELETE FROM orders', 'token': token},
        {'db': 'app', 'token': token},
        {
          'db': 'app',
          'sql': 'DELETE FROM orders',
          'params': '[',
          'token': token,
        },
        {'db': 'app', 'sql': 'DROP TABLE orders', 'token': token},
        {'db': 'app', 'sql': 'DELETE FROM nope', 'token': token},
      ];
      for (final params in failures) {
        final r = await call('execute', params);
        expect(errorCode(r), isNot(ErrorCode.badToken), reason: '$params');
      }
      final ok = await call('execute', {
        'db': 'app',
        'sql': "INSERT INTO orders (item) VALUES ('Tea')",
        'token': token,
      });
      expect(ok['changes'], 1);
    });

    test('two edits racing with one token run once', () async {
      final token = freshToken();
      Future<Map<String, Object?>> run() => call('execute', {
        'db': 'app',
        'sql': "INSERT INTO orders (item) VALUES ('Tea')",
        'token': token,
      });
      final both = await Future.wait([run(), run()]);
      expect(both.where((r) => r['changes'] == 1), hasLength(1));
      expect(
        both.where((r) => errorCode(r) == ErrorCode.badToken),
        hasLength(1),
      );
      expect(await app.count(), 2);
    });

    final refused = <String, String>{
      'DROP TABLE orders': ErrorCode.notAllowed,
      "ATTACH 'x.db' AS x": ErrorCode.notAllowed,
      'VACUUM': ErrorCode.notAllowed,
      'PRAGMA user_version = 9': ErrorCode.notAllowed,
      'BEGIN': ErrorCode.notAllowed,
      'DELETE FROM orders; DROP TABLE orders': ErrorCode.notAllowed,
      'DELETE FROM nope': ErrorCode.notFound,
      'SELECT 1': ErrorCode.notAllowed,
    };
    refused.forEach((sql, code) {
      test('refuses: $sql', () async {
        final r = await call('execute', {
          'db': 'app',
          'sql': sql,
          'token': freshToken(),
        });
        expect(errorCode(r), code);
        expect(await app.count(), 1);
        final tables = await app
            .customSelect("SELECT name FROM sqlite_schema WHERE type='table'")
            .get();
        expect(tables.map((t) => t.read<String>('name')), contains('orders'));
      });
    });

    test('a failing edit reports SQLite\'s message and rolls back', () async {
      final r = await call('execute', {
        'db': 'app',
        'sql': 'INSERT INTO orders (id, item) VALUES (1, ?)',
        'params': '["dup"]',
        'token': freshToken(),
      });
      expect(r['error'], {
        'code': ErrorCode.sqlError,
        'message': contains('UNIQUE constraint failed'),
      });
      expect(await app.count(), 1);
    });
  });

  group('locks', () {
    for (final wal in [false, true]) {
      final mode = wal ? 'WAL' : 'rollback journal';
      test(
        '$mode: the app writes while a runaway read runs',
        () async {
          final walPath = '${dir.path}/locks.sqlite';
          final db = openAppDb(walPath, wal: wal);
          addTearDown(db.close);
          await db.addOrder('Coffee');
          service.add(db, 'locks');

          final read = call('query', {
            'db': 'locks',
            'sql':
                'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 '
                'FROM c) SELECT count(*) FROM c, orders',
          });
          await Future<void>.delayed(const Duration(milliseconds: 500));
          final watch = Stopwatch()..start();
          await db.addOrder('Tea');
          final waited = watch.elapsed;
          expect(errorCode(await read), ErrorCode.timeout);
          expect(await db.count(), 2);
          if (wal) expect(waited, lessThan(const Duration(seconds: 1)));
        },
        timeout: const Timeout(Duration(seconds: 30)),
      );
    }

    test('the app writes during a diff snapshot', () async {
      for (var i = 0; i < 2000; i++) {
        await app.addOrder('Item $i');
      }
      final snap = call('snapshot', {'db': 'app'});
      final writes = [for (var i = 0; i < 20; i++) app.addOrder('Late $i')];
      await Future.wait(writes);
      final orders = ((await snap)['tables']! as List)
          .cast<Map<String, Object?>>()
          .firstWhere((t) => t['name'] == 'orders');
      final n = (orders['rows']! as List).length;
      // One consistent read: before, between or after the app's commits.
      expect(n, inInclusiveRange(2001, 2021));
      expect(await app.count(), 2021);
    });

    test('a busy timeout is set on the app only when it has none', () async {
      Future<int> timeout(AppDb db) async =>
          (await db.customSelect('PRAGMA busy_timeout').getSingle())
                  .data
                  .values
                  .single
              as int;
      expect(await timeout(app), 0);
      await ensureAppBusyTimeout(app);
      expect(await timeout(app), appBusyTimeout.inMilliseconds);

      final own = openAppDb('${dir.path}/own.sqlite');
      addTearDown(own.close);
      await own.customStatement('PRAGMA busy_timeout = 250');
      await ensureAppBusyTimeout(own);
      expect(await timeout(own), 250);
    });

    test(
      'a WAL app keeps no busy timeout: its writes never wait for reads',
      () async {
        final wal = openAppDb('${dir.path}/wal.sqlite', wal: true);
        addTearDown(wal.close);
        await wal.addOrder('Coffee');
        await ensureAppBusyTimeout(wal);
        final row = await wal.customSelect('PRAGMA busy_timeout').getSingle();
        expect(row.data.values.single, 0);
      },
    );
  });
}
