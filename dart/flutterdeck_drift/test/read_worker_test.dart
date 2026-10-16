import 'dart:async';
import 'dart:io';

import 'package:drift/drift.dart' show driftRuntimeOptions;
import 'package:flutterdeck_drift/src/native.dart';
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/read_worker.dart';
import 'package:flutterdeck_drift/src/service.dart' show ensureAppBusyTimeout;
import 'package:sqlite3/sqlite3.dart' show SqliteException, sqlite3;
import 'package:test/test.dart';

import 'support.dart';

/// Reads `orders` forever: holds a read lock on the table while it runs.
const runaway =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) '
    'SELECT count(*) FROM c, orders';

Matcher failsWith(String code) =>
    throwsA(isA<DriftDeckError>().having((e) => e.code, 'code', code));

void main() {
  setUpAll(() => driftRuntimeOptions.dontWarnAboutMultipleDatabases = true);

  late Directory dir;
  late String path;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_worker');
    path = '${dir.path}/app.sqlite';
  });

  tearDown(() => dir.deleteSync(recursive: true));

  Future<AppDb> openApp({required bool wal}) async {
    final app = openAppDb(path, wal: wal);
    await app.addOrder('Coffee');
    // As the service does before the first read (see service.dart).
    await ensureAppBusyTimeout(app);
    return app;
  }

  test('the bundled SQLite exports sqlite3_interrupt and sqlite3_limit', () {
    final db = sqlite3.openInMemory();
    addTearDown(db.close);
    // Interrupting an idle connection does nothing; this checks the lookup.
    expect(interruptConnection(db.handle.address), isTrue);
    // SQLite never lets the length limit go below 30.
    expect(limitLength(db.handle, 100), isTrue);
    expect(
      () => db.select("SELECT printf('%.*c', 200, 'x')"),
      throwsA(isA<SqliteException>()),
    );
  });

  test('runs reads in the isolate and answers with the result', () async {
    final app = await openApp(wal: false);
    final reader = DbReader(path);
    addTearDown(() async {
      await reader.close();
      await app.close();
    });

    final r = await reader.call('query', {
      'sql': 'SELECT item FROM orders',
      'params': const <Object?>[],
      'limit': 10,
    });
    expect(r['rows'], [
      ['Coffee'],
    ]);
    await expectLater(
      reader.call('query', {
        'sql': 'DELETE FROM orders',
        'params': const <Object?>[],
        'limit': 10,
      }),
      failsWith(ErrorCode.notReadOnly),
    );
  });

  for (final wal in [false, true]) {
    final mode = wal ? 'WAL' : 'rollback journal';

    test(
      '$mode: a runaway read stops in about 5 s and the app writes after',
      () async {
        final app = await openApp(wal: wal);
        final reader = DbReader(path);
        addTearDown(() async {
          await reader.close();
          await app.close();
        });

        final watch = Stopwatch()..start();
        await expectLater(
          reader.call('query', {
            'sql': runaway,
            'params': const <Object?>[],
            'limit': 10,
          }),
          failsWith(ErrorCode.timeout),
        );
        final took = watch.elapsed;
        expect(took, greaterThanOrEqualTo(readBudget));
        expect(took, lessThan(readBudget + interruptGrace));

        await app.addOrder('Tea');
        expect(await app.count(), 2);

        // A fresh reader takes over and sees the write.
        final r = await reader.call('query', {
          'sql': 'SELECT count(*) FROM orders',
          'params': const <Object?>[],
          'limit': 10,
        });
        expect(r['rows'], [
          [2],
        ]);
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );

    test(
      '$mode: the app writes while inspector reads run',
      () async {
        final app = await openApp(wal: wal);
        final reader = DbReader(path);
        addTearDown(() async {
          await reader.close();
          await app.close();
        });

        var stop = false;
        var reads = 0;
        final reading = () async {
          while (!stop) {
            await reader.call('query', {
              'sql': 'SELECT * FROM orders',
              'params': const <Object?>[],
              'limit': 1000,
            });
            reads++;
          }
        }();
        for (var i = 0; i < 50; i++) {
          await app.addOrder('Item $i');
        }
        stop = true;
        await reading;
        expect(await app.count(), 51);
        expect(reads, greaterThan(0));
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );
  }

  test(
    'an isolate that never returns is killed after the grace time',
    () async {
      final app = await openApp(wal: false);
      final worker = await ReadWorker.spawn(path);
      addTearDown(() async {
        await worker.close();
        await app.close();
      });
      final interrupted = <int>[];
      final real = ReadWorker.interrupt;
      ReadWorker.interrupt = (h) {
        interrupted.add(h);
        return true;
      };
      addTearDown(() => ReadWorker.interrupt = real);

      final watch = Stopwatch()..start();
      await expectLater(
        worker.call('sleep', {
          'ms': 4000,
        }, budget: const Duration(milliseconds: 200)),
        failsWith(ErrorCode.timeout),
      );
      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
      expect(interrupted, hasLength(1));
      expect(worker.isDead, isTrue);
      await expectLater(
        worker.call('schema', const {}),
        failsWith(ErrorCode.internal),
      );
    },
  );

  test('reads queue one at a time and each gets its own budget', () async {
    final app = await openApp(wal: false);
    final worker = await ReadWorker.spawn(path);
    addTearDown(() async {
      await worker.close();
      await app.close();
    });
    final first = worker.call('sleep', {'ms': 300});
    final second = worker.call('query', {
      'sql': 'SELECT 1',
      'params': const <Object?>[],
      'limit': 1,
    }, budget: const Duration(milliseconds: 250));
    await first;
    expect((await second)['rows'], [
      [1],
    ]);
  });

  test('a closed reader answers "stopped" and starts no new isolate', () async {
    final app = await openApp(wal: false);
    final reader = DbReader(path);
    addTearDown(app.close);
    final slow = reader.call('query', {
      'sql': runaway,
      'params': const <Object?>[],
      'limit': 10,
    });
    final stopped = expectLater(slow, failsWith(ErrorCode.internal));
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await reader.close();
    await stopped;
    await expectLater(
      reader.call('schema', const {}),
      failsWith(ErrorCode.internal),
    );
  });

  group('DbReader starts one isolate at a time (CR-1)', () {
    const quick = {
      'sql': 'SELECT count(*) FROM orders',
      'params': <Object?>[],
      'limit': 10,
    };

    Future<DbReader> timedOutReader() async {
      final reader = DbReader(path);
      await expectLater(
        reader.call('query', {
          'sql': runaway,
          'params': const <Object?>[],
          'limit': 10,
        }, budget: const Duration(milliseconds: 200)),
        failsWith(ErrorCode.timeout),
      );
      return reader;
    }

    test('two calls after a timeout share one new isolate', () async {
      final app = await openApp(wal: false);
      addTearDown(app.close);
      final reader = await timedOutReader();
      addTearDown(reader.close);
      final before = ReadWorker.spawnCount;
      final results = await Future.wait([
        reader.call('query', quick),
        reader.call('query', quick),
      ]);
      expect(results.map((r) => r['rows']), [
        [
          [1],
        ],
        [
          [1],
        ],
      ]);
      expect(ReadWorker.spawnCount - before, 1);
    });

    test('a call waiting during close starts no isolate', () async {
      final app = await openApp(wal: false);
      addTearDown(app.close);
      final reader = await timedOutReader();
      final before = ReadWorker.spawnCount;
      final waiting = expectLater(
        reader.call('query', quick),
        failsWith(ErrorCode.internal),
      );
      await reader.close();
      await waiting;
      expect(ReadWorker.spawnCount - before, 0);
    });
  });

  test('an unreadable file fails to start with unsupported', () async {
    File(path).writeAsStringSync('not a database at all' * 300);
    await expectLater(ReadWorker.spawn(path), failsWith(ErrorCode.unsupported));
  });
}
