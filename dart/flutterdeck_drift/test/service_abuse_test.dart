// Tester probes of the extension handlers (design note S1, S2, D2, D5).
// Tests marked `skip: 'FD-n ...'` are known bugs: they fail today
// (`dart test --run-skipped` shows it) and the skip goes when fixed.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart' show driftRuntimeOptions;
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/service.dart';
import 'package:test/test.dart';

import 'support.dart';

const _v1 = extensionPrefix;
const _runaway =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) '
    'SELECT count(*) FROM c';

void main() {
  late Directory dir;
  late AppDb app;
  late DriftDeckService service;
  late List<Map<String, Object?>> events;

  setUpAll(() => driftRuntimeOptions.dontWarnAboutMultipleDatabases = true);

  setUp(() async {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_svc_abuse');
    app = openAppDb('${dir.path}/app.sqlite');
    await app.addOrder('Coffee');
    events = [];
    service = DriftDeckService(post: (_, data) => events.add(data));
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
    DriftDeckService? via,
  ]) async {
    final reply = await (via ?? service).handle('$_v1$action', params);
    expect(reply['protocol'], protocolVersion);
    return (jsonDecode(jsonEncode(reply)) as Map).cast<String, Object?>();
  }

  Object? errorCode(Map<String, Object?> reply) =>
      (reply['error'] as Map?)?['code'];

  Future<int> appTimeoutMs() async =>
      (await app.customSelect('PRAGMA busy_timeout').getSingle())
              .data
              .values
              .single
          as int;

  group('FD-2: NUL bytes in SQL', () {
    // package:sqlite3's checkNoTail loops forever at a NUL (SQLite stops
    // reading there, so the offset never moves). The read isolate spins
    // until the budget kills it.
    test(
      'a query with a NUL is refused at once',
      () async {
        final watch = Stopwatch()..start();
        final r = await call('query', {'db': 'app', 'sql': 'SELECT 1\u0000'});
        expect(errorCode(r), ErrorCode.badRequest);
        expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );

    test(
      'an edit with a NUL is refused at once and changes nothing',
      () async {
        final watch = Stopwatch()..start();
        final r = await call('execute', {
          'db': 'app',
          'sql': 'DELETE FROM orders\u0000; DROP TABLE orders',
          'token': freshToken(),
        });
        expect(errorCode(r), ErrorCode.badRequest);
        expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
        expect(await app.count(), 1);
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );
  });

  test(
    'FD-3: a read queued behind a runaway read still gets an answer',
    () async {
      final slow = call('query', {'db': 'app', 'sql': _runaway});
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final quick = call('query', {'db': 'app', 'sql': 'SELECT 1'});
      expect(errorCode(await slow), ErrorCode.timeout);
      final r = await quick;
      expect(r['error'], isNull, reason: '$r');
      expect(r['rows'], [
        [1],
      ]);
    },
    timeout: const Timeout(Duration(seconds: 30)),
  );

  test('FD-11: the table event names the kind of the main statement', () async {
    final r = await call('execute', {
      'db': 'app',
      'sql': "WITH c AS (SELECT replace('a', 'a', 'b')) DELETE FROM orders",
      'token': freshToken(),
    });
    expect(r['changes'], 1);
    await Future<void>.delayed(eventDebounce * 3);
    expect(events.last['tables'], [
      {'name': 'orders', 'kind': 'delete'},
    ]);
  });

  group('execute: locks', () {
    test('RETURNING runs and counts the change', () async {
      final r = await call('execute', {
        'db': 'app',
        'sql': 'DELETE FROM orders WHERE id = 1 RETURNING *',
        'token': freshToken(),
      });
      expect(r, {'protocol': 1, 'changes': 1});
      expect(await app.count(), 0);
    });

    test('a view or a schema-qualified name is never a target', () async {
      await app.customStatement('CREATE VIEW v AS SELECT * FROM orders');
      for (final sql in [
        'DELETE FROM v',
        'REPLACE INTO v (id, item) VALUES (1, 1)',
        'DELETE FROM main.orders',
        'DELETE FROM "main"."orders"',
        ';DELETE FROM orders',
      ]) {
        final r = await call('execute', {
          'db': 'app',
          'sql': sql,
          'token': freshToken(),
        });
        expect(errorCode(r), isNotNull, reason: sql);
      }
      expect(await app.count(), 1);
    });

    test(
      'an edit may read other tables (it is the user\'s own edit)',
      () async {
        // Documents current behaviour: one target table, any reads.
        await app.customStatement("INSERT INTO raw VALUES ('Tea')");
        final r = await call('execute', {
          'db': 'app',
          'sql': 'INSERT INTO orders (item) SELECT x FROM raw',
          'token': freshToken(),
        });
        expect(r['changes'], 1);
      },
    );

    test('a token is used up even when the call fails', () async {
      final token = freshToken();
      final bad = await call('execute', {
        'db': 'nope',
        'sql': 'DELETE FROM orders',
        'token': token,
      });
      expect(errorCode(bad), ErrorCode.unknownDb);
      final again = await call('execute', {
        'db': 'app',
        'sql': 'DELETE FROM orders',
        'token': token,
      });
      expect(errorCode(again), ErrorCode.badToken);
      expect(await app.count(), 1);
    });

    test(
      'a new service (as after a hot restart) forgets used tokens',
      () async {
        // Documents FD-12: the app's single-use check lasts one isolate, not
        // one process, so the daemon must refuse reuse after a hot restart.
        final token = freshToken();
        Map<String, String> edit() => {
          'db': 'app',
          'sql': "INSERT INTO orders (item) VALUES ('Tea')",
          'token': token,
        };
        expect((await call('execute', edit()))['changes'], 1);
        final restarted = DriftDeckService(post: (_, _) {});
        addTearDown(restarted.dispose);
        restarted.add(app, 'app');
        expect((await call('execute', edit(), restarted))['changes'], 1);
        expect(await app.count(), 3);
      },
    );
  });

  group('protocol edges: locks', () {
    final bad = <String, (String, Map<String, String>, String)>{
      'schema without db': ('schema', {}, ErrorCode.unknownDb),
      'snapshot with empty db': ('snapshot', {'db': ''}, ErrorCode.unknownDb),
      'rows without table': (
        'rows',
        {'db': 'app', 'keys': '[1]'},
        ErrorCode.badRequest,
      ),
      'rows with keys not a list': (
        'rows',
        {'db': 'app', 'table': 'orders', 'keys': '{"a":1}'},
        ErrorCode.badRequest,
      ),
      'rows with an object key': (
        'rows',
        {'db': 'app', 'table': 'orders', 'keys': '[{"a":1}]'},
        ErrorCode.badRequest,
      ),
      'query with object params': (
        'query',
        {'db': 'app', 'sql': 'SELECT ?', 'params': '{"0":1}'},
        ErrorCode.badRequest,
      ),
      'query with a nested param': (
        'query',
        {'db': 'app', 'sql': 'SELECT ?', 'params': '[[1]]'},
        ErrorCode.badRequest,
      ),
      'query with a float tagged int': (
        'query',
        {
          'db': 'app',
          'sql': 'SELECT ?',
          'params': '[{"type":"int","value":"1e3"}]',
        },
        ErrorCode.badRequest,
      ),
      'query with a too-big tagged int': (
        'query',
        {
          'db': 'app',
          'sql': 'SELECT ?',
          'params': '[{"type":"int","value":"99999999999999999999"}]',
        },
        ErrorCode.badRequest,
      ),
      'query with a bad blob': (
        'query',
        {
          'db': 'app',
          'sql': 'SELECT ?',
          'params': '[{"type":"blob","base64":"%%"}]',
        },
        ErrorCode.badRequest,
      ),
      'query with limit 1.5': (
        'query',
        {'db': 'app', 'sql': 'SELECT 1', 'limit': '1.5'},
        ErrorCode.badRequest,
      ),
      'execute without sql': (
        'execute',
        {'db': 'app', 'token': ''},
        ErrorCode.badToken,
      ),
    };
    bad.forEach((label, c) {
      test('refuses: $label', () async {
        final r = await call(c.$1, c.$2);
        expect(errorCode(r), c.$3, reason: '$r');
      });
    });

    test('an unknown table in rows is not-found, not internal', () async {
      final r = await call('rows', {
        'db': 'app',
        'table': 'nope',
        'keys': '[1]',
      });
      expect(errorCode(r), ErrorCode.notFound);
    });

    test('every error reply carries a message and no stack', () async {
      final r = await call('query', {'db': 'app', 'sql': 'SELECT * FROM x'});
      final error = r['error']! as Map;
      expect(error.keys.toSet(), {'code', 'message'});
      expect('${error['message']}', isNot(contains('#0')));
    });
  });

  group('the app busy timeout (deviation 3): locks', () {
    test('register alone leaves it alone; the first read sets it', () async {
      expect(await appTimeoutMs(), 0);
      await call('list');
      expect(await appTimeoutMs(), 0, reason: 'list opens nothing');
      await call('schema', {'db': 'app'});
      expect(await appTimeoutMs(), appBusyTimeout.inMilliseconds);
    });

    test('an app timeout set before the first read is kept', () async {
      await app.customStatement('PRAGMA busy_timeout = 30000');
      await call('schema', {'db': 'app'});
      expect(await appTimeoutMs(), 30000);
    });

    test('a refused read never touches it', () async {
      await call('query', {'db': 'nope', 'sql': 'SELECT 1'});
      expect(await appTimeoutMs(), 0);
    });
  });

  test(
    're-adding a new database under the same name reads the new file',
    () async {
      // As after a hot restart: main() runs again and registers a new
      // GeneratedDatabase under the same name.
      expect(
        (await call('query', {
          'db': 'app',
          'sql': 'SELECT count(*) FROM orders',
        }))['rows'],
        [
          [1],
        ],
      );
      final next = openAppDb('${dir.path}/next.sqlite');
      addTearDown(next.close);
      await next.addOrder('A');
      await next.addOrder('B');
      service.add(next, 'app');
      expect(
        (await call('query', {
          'db': 'app',
          'sql': 'SELECT count(*) FROM orders',
        }))['rows'],
        [
          [2],
        ],
      );
    },
  );
}
