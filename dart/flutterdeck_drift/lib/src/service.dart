/// Handles the `ext.flutterdeck.drift.v1.*` calls and posts table events.
library;

import 'dart:async';

import 'package:drift/drift.dart';
import 'package:sqlite3/sqlite3.dart' show SqliteException;

import 'cells.dart';
import 'protocol.dart';
import 'read_worker.dart';
import 'sql_guard.dart';

/// Posts a VM service event (`dart:developer` `postEvent` in the app).
typedef EventPoster = void Function(String kind, Map<String, Object?> data);

/// How long the app's own connection waits for a lock before failing. Longer
/// than a read can hold one ([readBudget] plus [interruptGrace]).
const appBusyTimeout = Duration(seconds: 7);

/// How long table changes are gathered before one event goes out.
const eventDebounce = Duration(milliseconds: 100);

final _namePattern = RegExp(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$');
final _tokenPattern = RegExp(r'^[A-Za-z0-9_-]{43}$');

/// Checks a database name given to `register`.
bool isValidDbName(String name) => _namePattern.hasMatch(name);

final class _Ready {
  _Ready(this.reader);
  final DbReader reader;
}

final class _Entry {
  _Entry(this.name, this.db);

  final String name;
  final GeneratedDatabase db;
  StreamSubscription<Set<TableUpdate>>? updates;
  Timer? flush;
  final pending = <String, Set<UpdateKind?>>{};
  Future<_Ready>? ready;

  Future<void> dispose() async {
    await updates?.cancel();
    flush?.cancel();
    final r = ready;
    ready = null;
    if (r != null) {
      try {
        await (await r).reader.close();
      } on Object {
        // It never opened; nothing to close.
      }
    }
  }
}

final class DriftDeckService {
  DriftDeckService({required this.post});

  final EventPoster post;
  final _dbs = <String, _Entry>{};
  final _usedTokens = <String>{};

  /// Names of the registered databases.
  Iterable<String> get names => _dbs.keys;

  /// Adds [db] under [name]. The same pair again does nothing; another
  /// database under a used name replaces the old one.
  void add(GeneratedDatabase db, String name) {
    final old = _dbs[name];
    if (old != null) {
      if (identical(old.db, db)) return;
      unawaited(old.dispose());
    }
    final entry = _Entry(name, db);
    _dbs[name] = entry;
    entry.updates = db.tableUpdates().listen(
      (updates) => _queue(entry, updates),
      onError: (Object _) {},
    );
  }

  void _queue(_Entry entry, Set<TableUpdate> updates) {
    for (final u in updates) {
      entry.pending.putIfAbsent(u.table, () => <UpdateKind?>{}).add(u.kind);
    }
    entry.flush ??= Timer(eventDebounce, () => _flush(entry));
  }

  void _flush(_Entry entry) {
    entry.flush = null;
    final known = {for (final t in entry.db.allTables) t.actualTableName};
    final names = entry.pending.keys.where(known.contains).toList()..sort();
    final kinds = Map.of(entry.pending);
    entry.pending.clear();
    if (names.isEmpty || !identical(_dbs[entry.name], entry)) return;
    post(tablesEventKind, {
      'protocol': protocolVersion,
      'db': entry.name,
      'tables': [
        for (final n in names) {'name': n, 'kind': _kindName(kinds[n]!)},
      ],
    });
  }

  String _kindName(Set<UpdateKind?> kinds) {
    if (kinds.length != 1 || kinds.single == null) return 'unknown';
    return kinds.single!.name;
  }

  /// Answers one extension call. Never throws: failures become error replies.
  Future<Map<String, Object?>> handle(
    String method,
    Map<String, String> params,
  ) async {
    try {
      if (!method.startsWith(extensionPrefix)) {
        throw DriftDeckError(ErrorCode.badRequest, 'Unknown method $method');
      }
      final action = method.substring(extensionPrefix.length);
      return okReply(await _dispatch(action, params));
    } on DriftDeckError catch (e) {
      return errorReply(e);
    } on Object {
      // Never send exception text: it can hold row values.
      return errorReply(
        const DriftDeckError(ErrorCode.internal, 'The call failed'),
      );
    }
  }

  Future<Map<String, Object?>> _dispatch(
    String action,
    Map<String, String> params,
  ) async {
    switch (action) {
      case 'list':
        return {
          'databases': [
            for (final name in _dbs.keys) {'name': name},
          ],
        };
      case 'schema':
        return (await _ready(params)).reader.call('schema', const {});
      case 'query':
        final sql = _required(params, 'sql');
        return (await _ready(params)).reader.call('query', {
          'sql': sql,
          'params': decodeParams(params['params']),
          'limit': _limit(params['limit']),
        });
      case 'snapshot':
        return (await _ready(params)).reader.call('snapshot', const {});
      case 'rows':
        final table = _required(params, 'table');
        final keys = decodeKeys(params['keys']);
        return (await _ready(
          params,
        )).reader.call('rows', {'table': table, 'keys': keys});
      case 'execute':
        return _execute(params);
    }
    throw DriftDeckError(ErrorCode.badRequest, 'Unknown method $action');
  }

  String _required(Map<String, String> params, String key) {
    final value = params[key];
    if (value == null || value.isEmpty) {
      throw DriftDeckError(ErrorCode.badRequest, 'Missing $key');
    }
    if (value.length > maxSqlLength) {
      throw DriftDeckError(ErrorCode.badRequest, '$key is too long');
    }
    return value;
  }

  int _limit(String? text) {
    if (text == null || text.isEmpty) return defaultRowLimit;
    final n = int.tryParse(text);
    if (n == null || n < 1 || n > maxRowLimit) {
      throw const DriftDeckError(
        ErrorCode.badRequest,
        'limit must be 1 to $maxRowLimit',
      );
    }
    return n;
  }

  _Entry _entry(Map<String, String> params) {
    final name = params['db'];
    final entry = name == null ? null : _dbs[name];
    if (entry == null) {
      throw DriftDeckError(ErrorCode.unknownDb, 'No database named $name');
    }
    return entry;
  }

  Future<_Ready> _ready(Map<String, String> params) {
    final entry = _entry(params);
    final pending = entry.ready ??= _open(entry.db);
    // A failed open is retried on the next call.
    return pending.catchError((Object e) {
      if (identical(entry.ready, pending)) entry.ready = null;
      throw e;
    });
  }

  /// Finds the database file through the app's own connection, refuses
  /// in-memory and encrypted databases, and makes sure the app's writes wait
  /// out a read instead of failing (design note D2).
  Future<_Ready> _open(GeneratedDatabase db) async {
    final list = await db.customSelect('PRAGMA database_list').get();
    final main = list.where((r) => r.data['name'] == 'main').firstOrNull;
    final file = main?.data['file'];
    if (file is! String || file.isEmpty) {
      throw const DriftDeckError(
        ErrorCode.unsupported,
        'This is an in-memory database, so FlutterDeck cannot open it.',
      );
    }
    if (await _isEncrypted(db)) {
      throw const DriftDeckError(
        ErrorCode.unsupported,
        'This database is encrypted (SQLCipher), so FlutterDeck cannot open it.',
      );
    }
    await ensureAppBusyTimeout(db);
    return _Ready(DbReader(file));
  }

  Future<bool> _isEncrypted(GeneratedDatabase db) async {
    try {
      final rows = await db.customSelect('PRAGMA cipher_version').get();
      return rows.any((r) => '${r.data.values.firstOrNull ?? ''}'.isNotEmpty);
    } on Object {
      return false;
    }
  }

  Future<Map<String, Object?>> _execute(Map<String, String> params) async {
    final token = params['token'];
    if (token == null || !_tokenPattern.hasMatch(token)) {
      throw const DriftDeckError(
        ErrorCode.badToken,
        'Changes need a confirm in the dashboard',
      );
    }
    if (!_usedTokens.add(token)) {
      throw const DriftDeckError(
        ErrorCode.badToken,
        'This confirm was already used',
      );
    }
    final entry = _entry(params);
    final sql = _required(params, 'sql');
    final args = decodeParams(params['params']);
    final ready = await _ready(params);
    final checked = await ready.reader.call('checkWrite', {'sql': sql});
    final table = checked['table']! as String;
    final kind = switch (tokenize(sql)
        .map((t) => t.word)
        .firstWhere(
          (w) => const {'INSERT', 'REPLACE', 'UPDATE', 'DELETE'}.contains(w),
          orElse: () => '',
        )) {
      'UPDATE' => UpdateKind.update,
      'DELETE' => UpdateKind.delete,
      _ => UpdateKind.insert,
    };
    final db = entry.db;
    final int changes;
    try {
      changes = await db.transaction(() async {
        await db.customStatement(sql, args);
        final row = await db.customSelect('SELECT changes() AS n').getSingle();
        return row.read<int>('n');
      });
    } on Object catch (e) {
      throw DriftDeckError(ErrorCode.sqlError, _sqliteMessage(e));
    }
    db.notifyUpdates({TableUpdate(table, kind: kind)});
    return {'changes': changes};
  }

  String _sqliteMessage(Object e) {
    if (e is SqliteException) return e.message;
    // Drift's background isolate wraps errors in DriftRemoteException, whose
    // library is experimental; read its cause without importing it.
    try {
      final Object? cause = (e as dynamic).remoteCause;
      if (cause is SqliteException) return cause.message;
    } on NoSuchMethodError {
      // Not a remote error.
    }
    return "Couldn't save the change";
  }

  /// Stops every read isolate and event subscription.
  Future<void> dispose() async {
    final entries = _dbs.values.toList();
    _dbs.clear();
    for (final e in entries) {
      await e.dispose();
    }
  }
}

/// Decodes the `keys` parameter: a JSON array of keys, each one value or a
/// list of values for a composite key.
List<Object?> decodeKeys(String? json) {
  final keys = decodeParamsRaw(json);
  if (keys.isEmpty) {
    throw const DriftDeckError(ErrorCode.badRequest, 'Missing keys');
  }
  if (keys.length > maxKeysPerCall) {
    throw const DriftDeckError(ErrorCode.badRequest, 'Too many keys');
  }
  return keys;
}

/// Sets a busy timeout on the app's connection when it has none, so a write
/// that meets an inspector read waits for it (at most [readBudget] plus
/// [interruptGrace]) instead of failing with "database is locked". Debug
/// builds only, like everything in this package.
Future<void> ensureAppBusyTimeout(GeneratedDatabase db) async {
  final row = await db.customSelect('PRAGMA busy_timeout').getSingle();
  final current = row.data.values.firstOrNull;
  if (current is int && current > 0) return;
  await db.customStatement(
    'PRAGMA busy_timeout = ${appBusyTimeout.inMilliseconds}',
  );
}
