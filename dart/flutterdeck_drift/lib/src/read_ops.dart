/// Everything the read isolate does, on its own read-only connection.
///
/// These calls are synchronous FFI and can block; they only ever run inside
/// the read isolate, which the controlling isolate interrupts after
/// [readBudget] (see read_worker.dart).
library;

import 'package:sqlite3/sqlite3.dart';

import 'cells.dart';
import 'native.dart';
import 'protocol.dart';
import 'sql_guard.dart';

const _notADatabase = 26; // SQLITE_NOTADB
const _interrupted = 9; // SQLITE_INTERRUPT
const _busy = 5; // SQLITE_BUSY
const _busyMessage = 'The app is writing; try again';

/// Room for rows in a reply, leaving space for the envelope around them.
const _rowBudget = maxReplyBytes - 64 * 1024;

/// One table or view as the schema call and the diff see it.
final class _Entity {
  _Entity(this.name, this.kind, this.sql);

  final String name;
  final String kind; // 'table' or 'view'
  final String? sql;
}

final class ReadOps {
  ReadOps(this.db);

  final Database db;

  /// Opens [path] read-only, with no app functions, `query_only`, temp data
  /// in files, a small cache and a 16 MB value limit (design note S2).
  static ReadOps open(String path) {
    final Database db;
    try {
      db = sqlite3.open(path, mode: OpenMode.readOnly, mutex: true);
    } on SqliteException catch (e) {
      throw DriftDeckError(
        ErrorCode.unsupported,
        "Couldn't open the database file: ${e.message}",
      );
    }
    try {
      // First, because some pragmas below read the schema and so need a
      // lock: wait briefly while the app commits rather than failing.
      db.execute('PRAGMA busy_timeout = 1000');
      limitLength(db.handle, readLengthLimit);
      db.execute('PRAGMA temp_store = FILE');
      db.execute('PRAGMA cache_size = -2048');
      db.execute('PRAGMA query_only = 1');
      db.select('SELECT count(*) FROM sqlite_schema');
    } on SqliteException catch (e) {
      db.close();
      if (e.resultCode == _busy) {
        throw const DriftDeckError(ErrorCode.busy, _busyMessage);
      }
      if (e.resultCode == _notADatabase) {
        throw const DriftDeckError(
          ErrorCode.unsupported,
          'This database is encrypted or not a SQLite file, '
          'so FlutterDeck cannot read it.',
        );
      }
      throw DriftDeckError(
        ErrorCode.unsupported,
        "Couldn't read the database file: ${e.message}",
      );
    }
    return ReadOps(db);
  }

  /// The native connection, for `sqlite3_interrupt` from another isolate.
  int get handleAddress => db.handle.address;

  void close() => db.close();

  /// True once a statement changed the connection itself (an attached
  /// database, a setting): the read isolate then closes it and exits, and
  /// the next read gets a fresh connection.
  bool broken = false;

  /// Runs [action], maps SQLite errors to protocol errors, and makes sure no
  /// transaction stays open afterwards (design note D2, S4). If the
  /// connection is no longer as [open] left it, the answer is `internal`.
  T guarded<T>(T Function() action) {
    final result = _mapErrors(action);
    if (broken) {
      throw const DriftDeckError(
        ErrorCode.internal,
        'The read connection was reset',
      );
    }
    return result;
  }

  /// Defence in depth behind the guards: only main (and temp) attached,
  /// `query_only` and `temp_store=FILE` still set.
  void _checkConnection() {
    try {
      final names = db
          .select('PRAGMA database_list')
          .map((r) => r['name'])
          .toList();
      final queryOnly = db.select('PRAGMA query_only').first.values.first;
      final tempStore = db.select('PRAGMA temp_store').first.values.first;
      if (names.any((n) => n != 'main' && n != 'temp') ||
          queryOnly != 1 ||
          tempStore != 1) {
        broken = true;
      }
    } on SqliteException {
      broken = true;
    }
  }

  T _mapErrors<T>(T Function() action) {
    try {
      return action();
    } on SqliteException catch (e) {
      if (e.resultCode == _interrupted) {
        throw const DriftDeckError(
          ErrorCode.timeout,
          'That query took too long and was stopped',
        );
      }
      if (e.resultCode == _busy) {
        throw const DriftDeckError(ErrorCode.busy, _busyMessage);
      }
      throw DriftDeckError(ErrorCode.sqlError, e.message);
    } on ArgumentError {
      // package:sqlite3 throws this for a wrong number of parameters. Its
      // message can hold the values, so it is not sent (FD-4).
      throw const DriftDeckError(
        ErrorCode.badRequest,
        "The parameters don't match the query",
      );
    } finally {
      if (!db.autocommit) {
        try {
          db.execute('ROLLBACK');
        } on SqliteException {
          broken = true;
        }
      }
      _checkConnection();
    }
  }

  /// Refuses SQL that is too long or holds a NUL. SQLite stops reading at a
  /// NUL, and package:sqlite3's `checkNoTail` then loops forever (FD-2).
  void _checkSqlText(String sql) {
    if (sql.length > maxSqlLength) {
      throw const DriftDeckError(ErrorCode.badRequest, 'The SQL is too long');
    }
    if (sql.contains('\u0000')) {
      throw const DriftDeckError(
        ErrorCode.badRequest,
        'The SQL holds a NUL character',
      );
    }
  }

  /// Runs one reading statement and returns at most [limit] typed rows.
  Map<String, Object?> query(String sql, List<Object?> params, int limit) {
    _checkSqlText(sql);
    final reason = readGuard(sql);
    if (reason != null) {
      throw DriftDeckError(
        ErrorCode.notReadOnly,
        'Only reading queries run here: $reason',
      );
    }
    return guarded(() {
      final stmt = _prepareOne(sql);
      try {
        if (!stmt.isReadOnly) {
          throw const DriftDeckError(
            ErrorCode.notReadOnly,
            'Only reading queries run here: it would change data',
          );
        }
        final watch = Stopwatch()..start();
        final cursor = stmt.selectCursor(params);
        final rows = <List<Object?>>[];
        var bytes = 0;
        var truncated = false;
        while (cursor.moveNext()) {
          if (rows.length >= limit) {
            truncated = true;
            break;
          }
          final row = [for (final v in cursor.current.values) encodeCell(v)];
          bytes += jsonSize(row) + 1;
          if (bytes > _rowBudget) {
            truncated = true;
            break;
          }
          rows.add(row);
        }
        final columns = cursor.columnNames;
        return {
          'columns': columns,
          'rows': rows,
          'truncated': truncated,
          'durationMs': watch.elapsedMicroseconds / 1000,
        };
      } finally {
        stmt.close();
      }
    });
  }

  PreparedStatement _prepareOne(String sql) {
    try {
      return db.prepare(sql, checkNoTail: true);
    } on ArgumentError catch (e) {
      final multi = '${e.message}'.contains('trailing');
      throw DriftDeckError(
        ErrorCode.notReadOnly,
        multi
            ? 'Only one statement runs at a time: it has more than one statement'
            : 'The query is empty',
      );
    }
  }

  /// Tables and views, without SQLite's own and FTS shadow tables.
  List<_Entity> _entities() {
    final shadow = <String>{};
    try {
      for (final row in db.select('PRAGMA main.table_list')) {
        if (row['type'] == 'shadow') shadow.add(row['name'] as String);
      }
    } on SqliteException {
      // PRAGMA table_list needs SQLite 3.37; without it nothing is skipped.
    }
    return [
      for (final row in db.select(
        "SELECT type, name, sql FROM main.sqlite_schema "
        "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        'ORDER BY name',
      ))
        if (!shadow.contains(row['name']))
          _Entity(
            row['name'] as String,
            row['type'] as String,
            row['sql'] as String?,
          ),
    ];
  }

  /// Whether [table] is a WITHOUT ROWID table, as SQLite itself reports it
  /// (the `wr` column of `PRAGMA table_list`). Reading the CREATE text was
  /// fooled by a default value or a comment holding the words (CR-3).
  bool _isWithoutRowid(String table) {
    final rows = db.select(
      "SELECT wr FROM pragma_table_list(?) WHERE schema = 'main'",
      [table],
    );
    return rows.isNotEmpty && rows.first['wr'] == 1;
  }

  /// Every table and view with columns, keys, indexes and row counts.
  Map<String, Object?> schema() {
    return guarded(() {
      final tables = <Map<String, Object?>>[];
      final counting = Stopwatch()..start();
      for (final e in _entities()) {
        tables.add(
          _unlessUnusable(e, () {
            final info = db.select(
              'SELECT name, type, "notnull", dflt_value, pk '
              // xinfo lists generated columns too; hidden = 1 marks a
              // virtual table's hidden columns (FD-6).
              'FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid',
              [e.name],
            );
            final pkCount = info.where((c) => (c['pk'] as int) > 0).length;
            final withoutRowid = _isWithoutRowid(e.name);
            final columns = [
              for (final c in info)
                {
                  'name': c['name'],
                  'type': c['type'] ?? '',
                  'nullable':
                      c['notnull'] == 0 &&
                      !_neverNull(
                        c,
                        pkCount: pkCount,
                        withoutRowid: withoutRowid,
                      ),
                  'pk': (c['pk'] as int) > 0,
                  if ((c['pk'] as int) > 0) 'pkPosition': c['pk'],
                  'default': c['dflt_value']?.toString(),
                },
            ];
            final foreignKeys = [
              for (final f in db.select(
                'SELECT "from", "table", "to" FROM pragma_foreign_key_list(?) '
                'ORDER BY id, seq',
                [e.name],
              ))
                {'from': f['from'], 'table': f['table'], 'to': f['to']},
            ];
            final indexes = [
              for (final i in db.select(
                'SELECT name, "unique" FROM pragma_index_list(?) ORDER BY name',
                [e.name],
              ))
                {
                  'name': i['name'],
                  'unique': i['unique'] == 1,
                  'columns': [
                    for (final c in db.select(
                      'SELECT name FROM pragma_index_info(?) ORDER BY seqno',
                      [i['name']],
                    ))
                      c['name'] ?? '',
                  ],
                },
            ];
            final count = e.kind == 'table'
                ? _boundedCount(e.name, counting)
                : null;
            return {
              'name': e.name,
              'kind': e.kind,
              'sql': ?e.sql,
              'columns': columns,
              'rowCount': ?count?.rows,
              'foreignKeys': foreignKeys,
              'indexes': indexes,
              'error': ?count?.error?.toJson(),
            };
          }),
        );
      }
      return {'tables': tables};
    });
  }

  /// Runs [describe] for one table or view. If the read connection cannot use
  /// it (a view calling an app function, a virtual table whose module is
  /// missing), the entry says why instead of failing the whole call (FD-5).
  /// A timeout or busy error still stops the call.
  Map<String, Object?> _unlessUnusable(
    _Entity e,
    Map<String, Object?> Function() describe,
  ) {
    try {
      return describe();
    } on SqliteException catch (err) {
      if (err.resultCode == _interrupted || err.resultCode == _busy) rethrow;
      return {
        'name': e.name,
        'kind': e.kind,
        'sql': ?e.sql,
        'columns': const <Object?>[],
        'foreignKeys': const <Object?>[],
        'indexes': const <Object?>[],
        'error': DriftDeckError(
          ErrorCode.unsupported,
          "FlutterDeck can't read ${e.name}: ${err.message}",
        ).toJson(),
      };
    }
  }

  /// Key columns SQLite never stores NULL in, though not declared NOT NULL:
  /// a rowid alias (`INTEGER PRIMARY KEY`) and keys of WITHOUT ROWID tables.
  bool _neverNull(
    Row column, {
    required int pkCount,
    required bool withoutRowid,
  }) {
    if ((column['pk'] as int) == 0) return false;
    if (withoutRowid) return true;
    return pkCount == 1 && '${column['type']}'.toUpperCase() == 'INTEGER';
  }

  /// Time all row counts of one schema call may take together (CR-5).
  static Duration countBudget = const Duration(seconds: 2);

  /// Most rows one count scans; a bigger table reports no count.
  static int countCap = 1000000;

  /// Counts [table] unless the schema call has spent [countBudget] already,
  /// and scans at most [countCap] + 1 rows, so one huge table can't use up
  /// the whole read budget. A count it can't give comes back as an error
  /// for that table only, with its columns intact.
  ({int? rows, DriftDeckError? error}) _boundedCount(
    String table,
    Stopwatch spent,
  ) {
    if (spent.elapsed >= countBudget) {
      return (
        rows: null,
        error: const DriftDeckError(
          ErrorCode.timeout,
          'Rows not counted: counting the tables took too long',
        ),
      );
    }
    final n =
        db.select(
              'SELECT count(*) AS n FROM (SELECT 1 FROM '
              'main.${quoteIdent(table)} LIMIT ?)',
              [countCap + 1],
            ).first['n']
            as int;
    if (n > countCap) {
      return (
        rows: null,
        error: DriftDeckError(
          ErrorCode.tooLarge,
          'Rows not counted: more than $countCap rows',
        ),
      );
    }
    return (rows: n, error: null);
  }

  /// Names the key columns of [table]: its primary key in key order, or a
  /// rowid alias when it has none, or when a key column of a rowid table may
  /// hold NULL. SQLite lets such a key repeat NULL, so it would not tell
  /// rows apart (FD-7).
  ({List<String> key, bool rowid, List<String> columns}) _keyOf(String table) {
    final info = db.select(
      'SELECT name, type, "notnull", pk FROM pragma_table_xinfo(?) '
      'WHERE hidden <> 1 ORDER BY cid',
      [table],
    );
    final columns = [for (final c in info) c['name'] as String];
    final pk = [
      for (final c
          in info.where((c) => (c['pk'] as int) > 0).toList()
            ..sort((a, b) => (a['pk'] as int).compareTo(b['pk'] as int)))
        c['name'] as String,
    ];
    final withoutRowid = _isWithoutRowid(table);
    final pkCount = pk.length;
    final keyMayBeNull = info.any(
      (c) =>
          (c['pk'] as int) > 0 &&
          c['notnull'] == 0 &&
          !_neverNull(c, pkCount: pkCount, withoutRowid: withoutRowid),
    );
    if (pk.isNotEmpty && !keyMayBeNull) {
      return (key: pk, rowid: false, columns: columns);
    }
    final lower = columns.map((c) => c.toLowerCase()).toSet();
    for (final alias in const ['rowid', '_rowid_', 'oid']) {
      if (!lower.contains(alias)) {
        return (key: [alias], rowid: true, columns: columns);
      }
    }
    throw DriftDeckError(
      ErrorCode.unsupported,
      '$table has no primary key and hides its row id',
    );
  }

  Object? _keyJson(List<Object?> values) => values.length == 1
      ? encodeKeyCell(values.single)
      : [for (final v in values) encodeKeyCell(v)];

  /// Per table, a map of key → one hash per column, all read in one short
  /// read transaction that ends before the reply (design note D5).
  Map<String, Object?> snapshot() {
    return guarded(() {
      final takenAt = DateTime.now().millisecondsSinceEpoch;
      final tables = <Map<String, Object?>>[];
      var bytes = 0;
      db.execute('BEGIN');
      try {
        for (final e in _entities()) {
          if (e.kind != 'table') continue;
          try {
            final (table, size) = _snapshotTable(e, _rowBudget - bytes);
            bytes += size;
            tables.add(table);
          } on SqliteException catch (err) {
            if (err.resultCode == _interrupted || err.resultCode == _busy) {
              rethrow;
            }
            tables.add({
              'name': e.name,
              'error': DriftDeckError(
                ErrorCode.unsupported,
                "FlutterDeck can't read ${e.name}: ${err.message}",
              ).toJson(),
            });
          }
        }
      } finally {
        if (!db.autocommit) db.execute('COMMIT');
      }
      return {'takenAt': takenAt, 'tables': tables};
    });
  }

  /// One table of a snapshot, in at most [room] bytes of JSON, and the
  /// bytes it used. The table is read once: rows past the per-table cap stop
  /// the scan.
  (Map<String, Object?>, int) _snapshotTable(_Entity e, int room) {
    var bytes = 0;
    final ({List<String> key, bool rowid, List<String> columns}) shape;
    try {
      shape = _keyOf(e.name);
    } on DriftDeckError catch (err) {
      return ({'name': e.name, 'error': err.toJson()}, 0);
    }
    final select = [
      ...shape.key.map(quoteIdent),
      ...shape.columns.map(quoteIdent),
    ].join(', ');
    final rows = <Object?>[];
    final keyCount = shape.key.length;
    final stmt = db.prepare(
      'SELECT $select FROM main.${quoteIdent(e.name)} LIMIT ?',
    );
    try {
      final cursor = stmt.selectCursor([maxSnapshotRowsPerTable + 1]);
      while (cursor.moveNext()) {
        if (rows.length == maxSnapshotRowsPerTable) {
          final tooLarge = DriftDeckError(
            ErrorCode.tooLarge,
            'Too large to diff: more than $maxSnapshotRowsPerTable rows '
            'in ${e.name}',
          );
          return ({'name': e.name, 'error': tooLarge.toJson()}, 0);
        }
        final values = cursor.current.values;
        final entry = [
          _keyJson(values.sublist(0, keyCount)),
          [for (final v in values.skip(keyCount)) cellHash(v)],
        ];
        bytes += jsonSize(entry) + 1;
        if (bytes > room) {
          throw const DriftDeckError(
            ErrorCode.tooLarge,
            'Too large to diff: the snapshot is over 8 MB',
          );
        }
        rows.add(entry);
      }
    } finally {
      stmt.close();
    }
    return (
      {
        'name': e.name,
        'columns': shape.columns,
        'key': shape.key,
        if (shape.rowid) 'rowid': true,
        'rows': rows,
      },
      bytes,
    );
  }

  /// The table's name as the schema spells it. SQLite matches names without
  /// regard to ASCII case, so this does too (FD-9).
  String _tableNamed(String name) {
    final wanted = asciiLower(name);
    for (final e in _entities()) {
      if (e.kind == 'table' && asciiLower(e.name) == wanted) return e.name;
    }
    throw DriftDeckError(ErrorCode.notFound, 'No table named $name');
  }

  /// Row values of the table [name] for the given keys, read by key.
  Map<String, Object?> rows(String name, List<Object?> keys) {
    if (keys.length > maxKeysPerCall) {
      throw const DriftDeckError(ErrorCode.badRequest, 'Too many keys');
    }
    return guarded(() {
      final table = _tableNamed(name);
      final shape = _keyOf(table);
      final where = shape.key.map((k) => '${quoteIdent(k)} IS ?').join(' AND ');
      final stmt = db.prepare(
        'SELECT ${shape.columns.map(quoteIdent).join(', ')} '
        'FROM main.${quoteIdent(table)} WHERE $where',
      );
      try {
        final out = <Object?>[];
        final missing = <Object?>[];
        var bytes = 0;
        var truncated = false;
        for (final key in keys) {
          final parts = shape.key.length == 1 ? [key] : key;
          if (parts is! List || parts.length != shape.key.length) {
            throw const DriftDeckError(ErrorCode.badRequest, 'Bad key');
          }
          final params = [for (final p in parts) decodeParam(p)];
          final result = stmt.select(params);
          if (result.isEmpty) {
            missing.add(key);
            continue;
          }
          final entry = [
            key,
            [for (final v in result.first.values) encodeCell(v)],
          ];
          bytes += jsonSize(entry) + 1;
          if (bytes > _rowBudget) {
            truncated = true;
            break;
          }
          out.add(entry);
        }
        return {
          'columns': shape.columns,
          'key': shape.key,
          if (shape.rowid) 'rowid': true,
          'rows': out,
          'missing': missing,
          'truncated': truncated,
        };
      } finally {
        stmt.close();
      }
    });
  }

  /// Checks an edit before it runs on the app's connection: one statement
  /// that SQLite can prepare, on a table that exists (ADR 0005 writes).
  Map<String, Object?> checkWrite(String sql) {
    _checkSqlText(sql);
    final target = writeTarget(sql);
    final targetTable = target.table;
    if (targetTable == null) {
      throw DriftDeckError(ErrorCode.notAllowed, 'Not run: ${target.error}');
    }
    return guarded(() {
      final table = _tableNamed(targetTable);
      final PreparedStatement stmt;
      try {
        stmt = db.prepare(sql, checkNoTail: true);
      } on ArgumentError {
        throw const DriftDeckError(
          ErrorCode.notAllowed,
          'Not run: it has more than one statement',
        );
      }
      stmt.close();
      return {'table': table, 'verb': target.verb};
    });
  }
}
