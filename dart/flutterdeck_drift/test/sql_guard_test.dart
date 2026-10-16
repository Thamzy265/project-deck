import 'package:flutterdeck_drift/src/sql_guard.dart';
import 'package:test/test.dart';

void main() {
  group('tokenize', () {
    test('skips comments and keeps quoted text whole', () {
      final tokens = tokenize(
        "-- lead\n/* block */ SELECT 'a;b', \"c d\" FROM [e f] WHERE x = `g`",
      );
      expect(tokens.map((t) => t.text).toList(), [
        'SELECT',
        "'a;b'",
        ',',
        '"c d"',
        'FROM',
        '[e f]',
        'WHERE',
        'x',
        '=',
        '`g`',
      ]);
    });

    test('an unterminated string or comment runs to the end', () {
      expect(tokenize("SELECT 'abc").map((t) => t.text), ['SELECT', "'abc"]);
      expect(tokenize('SELECT 1 /* open').map((t) => t.text), ['SELECT', '1']);
    });

    test('doubled quotes stay inside one token', () {
      expect(tokenize("SELECT 'it''s'").map((t) => t.text), [
        'SELECT',
        "'it''s'",
      ]);
    });
  });

  group('readGuard', () {
    for (final sql in [
      'SELECT * FROM orders',
      '  select 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'EXPLAIN QUERY PLAN SELECT * FROM orders',
      'PRAGMA table_info(orders)',
      'PRAGMA table_xinfo("orders")',
      'PRAGMA index_list(orders)',
      'PRAGMA index_info(idx)',
      'PRAGMA foreign_key_list(orders)',
      "SELECT 'BEGIN; ATTACH' AS x",
      'VALUES (1), (2)',
    ]) {
      test('allows: $sql', () => expect(readGuard(sql), isNull));
    }

    final refused = <String, String>{
      'BEGIN': 'transaction',
      'begin immediate': 'transaction',
      'COMMIT': 'transaction',
      'END': 'transaction',
      'ROLLBACK': 'transaction',
      'SAVEPOINT a': 'transaction',
      'RELEASE a': 'transaction',
      "ATTACH 'x.db' AS x": 'adds a database',
      'DETACH x': 'adds a database',
      'PRAGMA writable_schema=1': 'setting',
      'PRAGMA query_only = 0': 'setting',
      'PRAGMA foreign_keys': 'setting',
      'PRAGMA table_info = orders': 'setting',
      'PRAGMA main.table_info(orders)': 'setting',
      'EXPLAIN PRAGMA writable_schema=1': 'setting',
      'EXPLAIN BEGIN': 'transaction',
      '': 'empty',
      '  -- only a comment': 'empty',
    };
    refused.forEach((sql, reason) {
      test('refuses: $sql', () {
        final result = readGuard(sql);
        expect(result, isNotNull);
        expect(result, contains(reason));
      });
    });
  });

  group('readGuard: file paths and raw pages', () {
    for (final sql in [
      'SELECT * FROM pragma_database_list',
      'SELECT file FROM PRAGMA_DATABASE_LIST()',
      'SELECT * FROM "pragma_database_list"',
      'SELECT * FROM main.pragma_database_list',
      'PRAGMA database_list',
      'SELECT * FROM dbstat',
      'SELECT * FROM [DBSTAT]',
      'SELECT * FROM sqlite_dbpage',
      'WITH x AS (SELECT * FROM dbstat) SELECT * FROM x',
    ]) {
      test('refuses: $sql', () => expect(readGuard(sql), isNotNull));
    }

    test('allows the words inside strings', () {
      expect(readGuard("SELECT 'dbstat', 'pragma_database_list'"), isNull);
    });
  });

  group('writeGuard', () {
    for (final sql in [
      "INSERT INTO orders (item) VALUES ('x')",
      'insert or replace into "orders" (id) values (1)',
      'REPLACE INTO orders (id) VALUES (1)',
      "UPDATE orders SET status = 'shipped' WHERE id = 1",
      'UPDATE OR IGNORE orders SET item = 1',
      'DELETE FROM orders WHERE id = 1',
      'WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN x',
    ]) {
      test('allows: $sql', () {
        final target = writeTarget(sql);
        expect(target.error, isNull);
        expect(target.table, 'orders');
      });
    }

    for (final sql in [
      'SELECT 1',
      'DROP TABLE orders',
      'CREATE TABLE x (a)',
      'ALTER TABLE orders ADD c',
      'VACUUM',
      "VACUUM INTO 'x'",
      "ATTACH 'x' AS y",
      'PRAGMA user_version = 3',
      'BEGIN',
      'ANALYZE',
      'REINDEX',
      'INSERT INTO main.orders VALUES (1)',
      '',
    ]) {
      test('refuses: $sql', () {
        final target = writeTarget(sql);
        expect(target.error, isNotNull);
        expect(target.table, isNull);
      });
    }

    test('names the verb at its position, not a function name', () {
      expect(
        writeTarget("UPDATE t SET a = replace(a, 'x', 'y')").verb,
        'UPDATE',
      );
      expect(
        writeTarget(
          "WITH c AS (SELECT replace('a', 'a', 'b')) DELETE FROM t",
        ).verb,
        'DELETE',
      );
      expect(writeTarget('insert or replace into t values (1)').verb, 'INSERT');
      expect(writeTarget('REPLACE INTO t VALUES (1)').verb, 'REPLACE');
      expect(writeTarget('DROP TABLE t').verb, isNull);
    });

    test('unquotes the target table name', () {
      expect(writeTarget('DELETE FROM "my ""t"""').table, 'my "t"');
      expect(writeTarget('DELETE FROM [my t]').table, 'my t');
      expect(writeTarget('DELETE FROM `t`').table, 't');
    });
  });

  test('quoteIdent doubles quotes', () {
    expect(quoteIdent('a"b'), '"a""b"');
  });
}
