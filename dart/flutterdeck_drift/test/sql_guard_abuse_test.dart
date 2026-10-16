// Tester probes of the token guard (design note "Trust boundaries and abuse
// cases"; ADR 0005). Tests marked `skip: 'FD-n ...'` are known bugs: they fail
// today (`dart test --run-skipped` shows it) and the skip goes when fixed.
import 'package:flutterdeck_drift/src/sql_guard.dart';
import 'package:test/test.dart';

void main() {
  group('readGuard: empty statements before the real one', () {
    // SQLite skips empty statements (a lone `;`) when it prepares, so the
    // statement that runs is the one after them. The guard reads only the
    // first token, which is `;`, and lets these through (FD-1).
    for (final sql in [
      ";ATTACH 'other.sqlite' AS x",
      "; ATTACH 'other.sqlite' AS x",
      ";;DETACH x",
      "/* c */ ; ATTACH 'other.sqlite' AS x",
      '-- c\n;PRAGMA query_only=0',
      ';PRAGMA writable_schema=1',
      ';BEGIN',
      ';SAVEPOINT s',
      ';EXPLAIN PRAGMA query_only=0',
    ]) {
      test(
        'refuses: ${sql.replaceAll('\n', r'\n')}',
        () => expect(readGuard(sql), isNotNull),
        skip: 'FD-1 (known bug): a leading ";" hides the first keyword',
      );
    }
  });

  group('readGuard: tricks SQLite does not accept either', () {
    // Regression locks: these pass the token guard, but SQLite itself
    // rejects them, so the guard's view and SQLite's view never disagree on
    // a statement that runs. They would matter if the tokenizer changed.
    test('a vertical tab is not whitespace for SQLite or the guard', () {
      final tokens = tokenize("\x0bATTACH 'x' AS y");
      expect(tokens.first.text, '\x0b');
    });

    test('non-ASCII letters never make a keyword', () {
      // U+0131 (dotless i) upper-cases to I in Dart, so the guard refuses
      // more than SQLite would, never less.
      expect(readGuard('begın'), contains('transaction'));
      expect(readGuard(' ATTACH x'), isNull);
    });

    test('keywords hidden in comments, strings and identifiers', () {
      expect(readGuard("/* ATTACH */ SELECT 'ATTACH'"), isNull);
      expect(readGuard('SELECT "BEGIN" FROM [ATTACH]'), isNull);
      expect(readGuard('/*/ ATTACH x AS y'), contains('empty'));
      expect(readGuard('/**/ATTACH x AS y'), contains('adds a database'));
      expect(readGuard('--\nATTACH x AS y'), contains('adds a database'));
      expect(readGuard('--\rATTACH x AS y'), contains('empty'));
    });

    test('pragmas with a value in parentheses are refused', () {
      for (final sql in [
        'PRAGMA query_only(0)',
        'PRAGMA writable_schema(1)',
        'PRAGMA table_info(orders) = 1',
        'PRAGMA table_info(=)',
        'PRAGMA table_info((orders)=(1))',
        'PRAGMA "table_info"(orders)',
        'EXPLAIN QUERY PLAN PRAGMA query_only(0)',
      ]) {
        expect(readGuard(sql), contains('setting'), reason: sql);
      }
    });

    test('EXPLAIN alone or with QUERY PLAN alone is empty', () {
      expect(readGuard('EXPLAIN'), contains('empty'));
      expect(readGuard('EXPLAIN QUERY PLAN'), contains('empty'));
    });
  });

  group('writeTarget: abuse shapes', () {
    for (final sql in [
      ';DELETE FROM orders',
      'DELETE FROM "main".orders',
      'DELETE FROM main . orders',
      'DELETE FROM temp.orders',
      'INSERT OR REPLACE INTO main.orders VALUES (1)',
      'UPDATE OR ROLLBACK main.orders SET a = 1',
      'REPLACE INTO [main].[orders] VALUES (1)',
      "INSERT INTO 'orders' VALUES (1)",
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'WITH RECURSIVE x(n) AS (SELECT 1) VACUUM',
      'DELETE orders',
      'INSERT orders VALUES (1)',
      'UPDATE',
      'DELETE FROM',
    ]) {
      test('refuses: $sql', () {
        final target = writeTarget(sql);
        expect(target.error, isNotNull);
        expect(target.table, isNull);
      });
    }

    test('a CTE that mentions write words still finds the main verb', () {
      expect(
        writeTarget(
          "WITH a(x) AS (SELECT 'DELETE'), b AS (SELECT 1) "
          'UPDATE orders SET status = 1',
        ).table,
        'orders',
      );
    });
  });
}
