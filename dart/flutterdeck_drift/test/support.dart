import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';

/// A hand-written stand-in for a generated Drift table, so the tests need no
/// code generation. Only the parts the package reads are real.
final class NamedTable extends Table
    with TableInfo<NamedTable, Map<String, Object?>> {
  NamedTable(this.attachedDatabase, this.actualTableName, [this._alias]);

  @override
  final GeneratedDatabase attachedDatabase;
  @override
  final String actualTableName;
  final String? _alias;

  @override
  List<GeneratedColumn<Object>> get $columns => const [];

  @override
  String get aliasedName => _alias ?? actualTableName;

  @override
  Map<String, Object?> map(Map<String, dynamic> data, {String? tablePrefix}) =>
      data;

  @override
  NamedTable createAlias(String alias) =>
      NamedTable(attachedDatabase, actualTableName, alias);
}

/// The app's database: `orders` and `lines` are Drift tables; `raw` exists in
/// SQLite only.
final class AppDb extends GeneratedDatabase {
  AppDb(super.executor);

  late final orders = NamedTable(this, 'orders');
  late final lines = NamedTable(this, 'lines');

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => [orders, lines];

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (m) async {
      await customStatement(
        'CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, '
        "item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')",
      );
      await customStatement(
        'CREATE TABLE lines (order_id INTEGER, n INTEGER, '
        'PRIMARY KEY (order_id, n))',
      );
      await customStatement('CREATE TABLE raw (x)');
    },
  );

  Future<void> addOrder(String item) => customInsert(
    'INSERT INTO orders (item) VALUES (?)',
    variables: [Variable.withString(item)],
    updates: {orders},
  );

  Future<int> count() async => (await customSelect(
    'SELECT count(*) AS n FROM orders',
  ).getSingle()).read<int>('n');
}

/// Opens [path] the way drift_flutter does: a background isolate, rollback
/// journal unless [wal], no busy timeout.
AppDb openAppDb(String path, {bool wal = false}) => AppDb(
  NativeDatabase.createInBackground(
    File(path),
    setup: (db) {
      if (wal) db.execute('PRAGMA journal_mode = WAL');
    },
  ),
);

/// A well-formed, never-used write token, made at run time.
String freshToken() {
  final random = Random.secure();
  final bytes = List<int>.generate(32, (_) => random.nextInt(256));
  return base64Url.encode(bytes).replaceAll('=', '');
}
