/// The read isolate and its controller.
///
/// Reads run in a dedicated isolate with its own read-only connection, so a
/// slow query never blocks the app's isolate or Drift's connection. At the
/// budget the controller calls `sqlite3_interrupt` on that connection (an
/// isolate blocked in a synchronous FFI call never sees a kill), waits up to
/// [interruptGrace] for the step to return, then has the isolate close its
/// connection, and kills the isolate last (design note S2).
library;

import 'dart:async';
import 'dart:isolate';

import 'native.dart';
import 'protocol.dart';
import 'read_ops.dart';

/// The read isolate stopped (after a timeout, a reset or a crash) before
/// this read ran or finished.
const readerStopped = DriftDeckError(ErrorCode.internal, 'The reader stopped');

const _tooLong = DriftDeckError(
  ErrorCode.timeout,
  'That query took too long and was stopped',
);

/// Runs one read operation in the read isolate. Public for tests.
Map<String, Object?> runReadOp(
  ReadOps ops,
  String op,
  Map<String, Object?> args,
) {
  switch (op) {
    case 'query':
      return ops.query(
        args['sql']! as String,
        (args['params'] as List<Object?>?) ?? const [],
        args['limit']! as int,
      );
    case 'schema':
      return ops.schema();
    case 'snapshot':
      return ops.snapshot();
    case 'rows':
      return ops.rows(args['table']! as String, args['keys']! as List<Object?>);
    case 'checkWrite':
      return ops.checkWrite(args['sql']! as String);
    case 'breakForTest':
      // Test hook: as if a statement had changed the connection itself.
      ops.broken = true;
      return const {};
    case 'sleep':
      // Test hook: blocks the isolate without SQLite, like a hung FFI call.
      final until = DateTime.now().add(
        Duration(milliseconds: args['ms']! as int),
      );
      while (DateTime.now().isBefore(until)) {}
      return const {};
  }
  throw DriftDeckError(ErrorCode.badRequest, 'Unknown read op $op');
}

void _readerMain(List<Object?> args) {
  final toController = args[0]! as SendPort;
  final path = args[1]! as String;
  final ReadOps ops;
  try {
    ops = ReadOps.open(path);
  } on DriftDeckError catch (e) {
    toController.send(['failed', e.code, e.message]);
    return;
  }
  final inbox = ReceivePort();
  toController.send(['ready', inbox.sendPort, ops.handleAddress]);
  // The connection is freed only on the controller's "close": the
  // controller may call sqlite3_interrupt on it until it has sent that, and
  // it sends nothing after (CR-2).
  inbox.listen((Object? message) {
    final m = message! as List<Object?>;
    if (m[0] == 'close') {
      ops.close();
      inbox.close();
      Isolate.exit();
    }
    // After "closing" only "close" is expected; the controller is dead.
    if (ops.broken) return;
    final id = m[0]! as int;
    List<Object?> reply;
    try {
      final result = runReadOp(
        ops,
        m[1]! as String,
        (m[2]! as Map).cast<String, Object?>(),
      );
      reply = [id, result];
    } on DriftDeckError catch (e) {
      reply = [id, null, e.code, e.message];
    } on Object {
      // Never send exception text: it can hold row values.
      reply = [id, null, ErrorCode.internal, 'The read failed'];
    }
    // "closing" goes first, so the controller is dead before the caller
    // sees the reply.
    if (ops.broken) toController.send(['closing']);
    toController.send(reply);
  });
}

/// The controlling side of one read isolate.
final class ReadWorker {
  ReadWorker._(this._isolate, this._toWorker, this._handle, this._ports);

  final Isolate _isolate;
  final SendPort _toWorker;
  final int _handle;
  final _Ports _ports;
  final _pending = <int, Completer<Map<String, Object?>>>{};
  var _nextId = 0;
  var _dead = false;
  Future<void> _queue = Future.value();

  /// Test hook: called with the connection handle instead of interrupting.
  static bool Function(int handle) interrupt = interruptConnection;

  bool get isDead => _dead;

  /// Test hook: how many read isolates this process has started.
  static int spawnCount = 0;

  static Future<ReadWorker> spawn(String path) async {
    spawnCount++;
    final ports = _Ports();
    final first = Completer<List<Object?>>();
    ports.messages.listen((Object? m) {
      if (!first.isCompleted) {
        first.complete(m! as List<Object?>);
      } else {
        ports.onMessage?.call(m! as List<Object?>);
      }
    });
    ports.exits.listen((_) {
      if (!first.isCompleted) {
        first.complete(['failed', ErrorCode.internal, 'The reader stopped']);
      }
      ports.onExit?.call();
    });
    final isolate = await Isolate.spawn(
      _readerMain,
      [ports.messages.sendPort, path],
      onExit: ports.exits.sendPort,
      onError: ports.exits.sendPort,
      debugName: 'flutterdeck_drift reader',
    );
    final hello = await first.future.timeout(
      readBudget,
      onTimeout: () => [
        'failed',
        ErrorCode.timeout,
        'The reader did not start',
      ],
    );
    if (hello[0] != 'ready') {
      isolate.kill(priority: Isolate.immediate);
      ports.close();
      throw DriftDeckError(hello[1]! as String, hello[2]! as String);
    }
    final worker = ReadWorker._(
      isolate,
      hello[1]! as SendPort,
      hello[2]! as int,
      ports,
    );
    ports.onMessage = worker._onMessage;
    ports.onExit = worker._onExit;
    return worker;
  }

  /// Runs [op] in the read isolate, one at a time, within [budget].
  Future<Map<String, Object?>> call(
    String op,
    Map<String, Object?> args, {
    Duration budget = readBudget,
  }) {
    final result = _queue.then((_) => _run(op, args, budget));
    _queue = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  Future<Map<String, Object?>> _run(
    String op,
    Map<String, Object?> args,
    Duration budget,
  ) async {
    if (_dead) {
      throw readerStopped;
    }
    final id = _nextId++;
    final done = Completer<Map<String, Object?>>();
    _pending[id] = done;
    _toWorker.send([id, op, args]);

    Timer? grace;
    var fired = false;
    final budgetTimer = Timer(budget, () {
      if (_dead || done.isCompleted) return;
      fired = true;
      ReadWorker.interrupt(_handle);
      grace = Timer(interruptGrace, () {
        // The step did not return: give up on this isolate.
        _fail(id, _tooLong);
        _stop();
      });
    });
    try {
      final result = await done.future;
      if (fired) _stop();
      return result;
    } on DriftDeckError {
      if (!fired) rethrow;
      _stop();
      throw _tooLong;
    } finally {
      budgetTimer.cancel();
      grace?.cancel();
      _pending.remove(id);
    }
  }

  void _fail(int id, DriftDeckError error) {
    final c = _pending.remove(id);
    if (c != null && !c.isCompleted) c.completeError(error);
  }

  void _onMessage(List<Object?> m) {
    if (m[0] == 'closing') {
      _stop();
      return;
    }
    final c = _pending.remove(m[0]! as int);
    if (c == null || c.isCompleted) return;
    if (m[1] != null) {
      c.complete((m[1]! as Map).cast<String, Object?>());
    } else {
      c.completeError(DriftDeckError(m[2]! as String, m[3]! as String));
    }
  }

  void _onExit() {
    _dead = true;
    for (final id in _pending.keys.toList()) {
      _fail(id, readerStopped);
    }
    _ports.close();
  }

  /// Closes the connection in the isolate, then kills the isolate if it has
  /// not exited after [interruptGrace].
  void _stop() {
    if (_dead) return;
    _dead = true;
    _toWorker.send(['close']);
    Timer(interruptGrace, () {
      _isolate.kill(priority: Isolate.immediate);
      _ports.close();
    });
  }

  /// Stops the read isolate. Pending reads fail. A read still running is
  /// interrupted first, because the isolate can't exit while it is blocked
  /// in SQLite.
  Future<void> close() async {
    if (!_dead && _pending.isNotEmpty) ReadWorker.interrupt(_handle);
    for (final id in _pending.keys.toList()) {
      _fail(id, readerStopped);
    }
    _stop();
  }
}

final class _Ports {
  final messages = ReceivePort('flutterdeck_drift reader');
  final exits = ReceivePort('flutterdeck_drift reader exit');
  void Function(List<Object?>)? onMessage;
  void Function()? onExit;

  void close() {
    messages.close();
    exits.close();
  }
}

/// Keeps one live read isolate for a database file, starting a new one after
/// the last was stopped.
final class DbReader {
  DbReader(this.path);

  final String path;
  Future<ReadWorker>? _worker;

  var _closed = false;

  /// Runs [op] on the live read isolate. A read that met a stopped isolate
  /// (for example queued behind a runaway read) runs once more on a fresh
  /// one; reads change nothing, so that is safe (FD-3).
  Future<Map<String, Object?>> call(
    String op,
    Map<String, Object?> args, {
    Duration budget = readBudget,
  }) async {
    for (var attempt = 0; ; attempt++) {
      final worker = await _live();
      try {
        return await worker.call(op, args, budget: budget);
      } on DriftDeckError catch (e) {
        if (attempt > 0 || _closed || !identical(e, readerStopped)) rethrow;
      }
    }
  }

  /// The live read isolate. Starting one is single-flight: calls that find
  /// the last isolate dead all wait for the same new one, and nothing starts
  /// once [close] was called (CR-1).
  Future<ReadWorker> _live() async {
    while (true) {
      if (_closed) throw readerStopped;
      var pending = _worker;
      if (pending == null) {
        final spawned = ReadWorker.spawn(path);
        _worker = pending = spawned;
        // A failed start is tried again on the next call.
        spawned.then<void>(
          (_) {},
          onError: (Object _) {
            if (identical(_worker, spawned)) _worker = null;
          },
        );
      }
      final ReadWorker w;
      try {
        w = await pending;
      } on DriftDeckError {
        if (_closed) throw readerStopped;
        rethrow;
      }
      if (_closed) throw readerStopped;
      // Another call already replaced it while this one waited.
      if (!identical(_worker, pending)) continue;
      if (!w.isDead) return w;
      _worker = null;
    }
  }

  Future<void> close() async {
    _closed = true;
    final w = _worker;
    _worker = null;
    if (w != null) {
      try {
        await (await w).close();
      } on Object {
        // Never started; nothing to stop.
      }
    }
  }
}
