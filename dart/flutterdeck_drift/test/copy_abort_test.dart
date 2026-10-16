// A copy that is cut off mid-way must not leak the app's database (R3-1):
// an unfinished sqlite3_backup keeps both connections alive as zombies, so
// the file descriptor and an in-memory copy of up to 50 MB of end-user data
// would stay for the life of the process.
import 'dart:io';
import 'dart:ffi';

import 'package:ffi/ffi.dart';
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/read_ops.dart';
import 'package:flutterdeck_drift/src/read_worker.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import 'fds.dart';

/// A ~39 MB rollback-journal database.
String bigDatabase(Directory dir) {
  final path = '${dir.path}/big.sqlite';
  final db = sqlite3.open(path);
  db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.execute(
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c '
    "WHERE x < 75000) INSERT INTO t (v) SELECT printf('%.500c', 'x') FROM c",
  );
  db.close();
  return path;
}

void main() {
  late Directory dir;
  late String path;

  setUpAll(() {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_abort');
    path = bigDatabase(dir);
  });

  tearDownAll(() => dir.deleteSync(recursive: true));

  group('a stop that arrives before the first step (R4-2)', () {
    late Pointer<Int32> control;
    late ReadOps ops;

    setUp(() {
      control = calloc<Int32>(2);
      ops = ReadOps.open(path, control: control);
    });

    tearDown(() {
      ReadOps.afterCopyStep = null;
      ops.close();
      calloc.free(control);
    });

    Matcher stopped() => throwsA(
      isA<DriftDeckError>().having(
        (e) => e.message,
        'message',
        'The reader stopped',
      ),
    );

    test('a stop set before the copy starts takes no step', () {
      // The controller set the flag just before the isolate said "copying".
      control[0] = 1;
      expect(() => ops.query('SELECT 1', const [], 1), stopped());
      expect(ops.backupsStarted, 0, reason: 'no backup was even started');
      expect(control[1], 0);
    });

    test('a stop ends a wait for the app\'s lock at once', () {
      final app = sqlite3.open(path);
      addTearDown(app.close);
      app.execute('BEGIN EXCLUSIVE');
      addTearDown(() => app.execute('ROLLBACK'));
      control[0] = 1;
      final watch = Stopwatch()..start();
      expect(() => ops.query('SELECT 1', const [], 1), stopped());
      // At most one wait of the file connection's own 1 s busy timeout,
      // not the 5 s copy budget.
      expect(watch.elapsed, lessThan(const Duration(milliseconds: 1500)));
    });
  });

  test('a copy told to stop finishes its backup: no zombie is left', () {
    final baseline = openDescriptors(path);
    final control = calloc<Int32>(2);
    addTearDown(() => calloc.free(control));
    final ops = ReadOps.open(path, control: control);
    var steps = 0;
    var copyingSeen = false;
    ReadOps.afterCopyStep = () {
      copyingSeen = control[1] == 1;
      if (++steps == 5) control[0] = 1;
    };
    addTearDown(() => ReadOps.afterCopyStep = null);
    expect(
      () => ops.query('SELECT 1', const [], 1),
      throwsA(
        isA<DriftDeckError>().having(
          (e) => e.message,
          'message',
          'The reader stopped',
        ),
      ),
    );
    expect(copyingSeen, isTrue, reason: 'the phase flag says "copying"');
    expect(control[1], 0, reason: 'and is cleared when the copy ends');
    expect(steps, 5);
    // An unfinished backup would keep the closed file connection alive as a
    // zombie holding the descriptor.
    ops.close();
    expect(openDescriptors(path), baseline);
  });

  test(
    'closing a reader mid-copy, with the app writing, leaks nothing',
    () async {
      final writer = sqlite3.open(path);
      addTearDown(writer.close);
      writer.execute('PRAGMA busy_timeout = 1000');
      final baseline = openDescriptors(path);
      const count = {
        'sql': 'SELECT count(*) FROM t',
        'params': <Object?>[],
        'limit': 1,
      };
      // A first read starts the read isolate and makes a copy.
      final reader = DbReader(path);
      expect((await reader.call('query', count))['rows'], [
        [75000],
      ]);
      var writing = true;
      final churn = () async {
        while (writing) {
          writer.execute("UPDATE t SET v = 'x' || random() WHERE id = 1");
          await Future<void>.delayed(Duration.zero);
        }
      }();

      // The app's writes make the next read copy again, and keep restarting
      // that copy; the reader is closed 30 ms into it.
      final read = reader
          .call('slowCopyForTest', const {})
          .then<Object?>((r) => r, onError: (Object e) => e);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await reader.close();
      expect(await read, isA<DriftDeckError>());
      writing = false;
      await churn;

      final rssDuring = ProcessInfo.currentRss;
      final released = await collectUntil(
        () => openDescriptors(path) == baseline,
      );
      // ignore: avoid_print
      print(
        'RSS after the close ${rssDuring ~/ 1048576} MB, '
        'after release ${ProcessInfo.currentRss ~/ 1048576} MB',
      );
      expect(released, isTrue, reason: 'descriptor still open: a zombie');
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );
}
