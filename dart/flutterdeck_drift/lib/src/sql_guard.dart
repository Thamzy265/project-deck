/// A second, token-level guard in front of SQLite's own checks.
///
/// The read connection is opened read-only with `query_only`, and every read
/// must report `isReadOnly`. SQLite still calls `BEGIN`, `ATTACH` and some
/// `PRAGMA` writes read-only, so those are refused here by their leading
/// keywords. Tokens are only used for that and for finding a write's target
/// table: whether SQL is valid is always SQLite's decision.
library;

/// One SQL token. Comments and whitespace are dropped.
final class SqlToken {
  const SqlToken(this.text);

  final String text;

  /// The token as a keyword (upper case), or '' for quoted text.
  String get word {
    final first = text.codeUnitAt(0);
    return _isWordStart(first) ? text.toUpperCase() : '';
  }

  @override
  String toString() => text;
}

bool _isWordStart(int c) =>
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c == 0x5f ||
    c >= 0x80;

bool _isWordPart(int c) =>
    _isWordStart(c) || (c >= 0x30 && c <= 0x39) || c == 0x24;

bool _isSpace(int c) =>
    c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d || c == 0x0c;

/// Splits [sql] into tokens the way SQLite's tokenizer groups them, closely
/// enough to read leading keywords and identifiers.
List<SqlToken> tokenize(String sql) {
  final tokens = <SqlToken>[];
  var i = 0;
  final n = sql.length;
  while (i < n) {
    final c = sql.codeUnitAt(i);
    if (_isSpace(c)) {
      i++;
    } else if (c == 0x2d && i + 1 < n && sql.codeUnitAt(i + 1) == 0x2d) {
      final end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
    } else if (c == 0x2f && i + 1 < n && sql.codeUnitAt(i + 1) == 0x2a) {
      final end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c == 0x27 || c == 0x22 || c == 0x60) {
      final end = _closeQuote(sql, i, c);
      tokens.add(SqlToken(sql.substring(i, end)));
      i = end;
    } else if (c == 0x5b) {
      final end = sql.indexOf(']', i);
      final stop = end < 0 ? n : end + 1;
      tokens.add(SqlToken(sql.substring(i, stop)));
      i = stop;
    } else if (_isWordPart(c)) {
      var j = i + 1;
      while (j < n && _isWordPart(sql.codeUnitAt(j))) {
        j++;
      }
      tokens.add(SqlToken(sql.substring(i, j)));
      i = j;
    } else {
      tokens.add(SqlToken(sql[i]));
      i++;
    }
  }
  return tokens;
}

int _closeQuote(String sql, int start, int quote) {
  var i = start + 1;
  while (i < sql.length) {
    if (sql.codeUnitAt(i) == quote) {
      if (i + 1 < sql.length && sql.codeUnitAt(i + 1) == quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

const _transactionWords = {
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
};

/// Pragmas a read may use, and only in the `name(argument)` form (ADR 0005).
const _readPragmas = {
  'TABLE_INFO',
  'TABLE_XINFO',
  'INDEX_LIST',
  'INDEX_INFO',
  'FOREIGN_KEY_LIST',
};

/// Returns why [sql] may not run as a read, or null when the token check
/// passes. SQLite's `isReadOnly` check still follows.
String? readGuard(String sql) {
  var tokens = tokenize(sql);
  if (tokens.isEmpty) return 'the query is empty';
  if (tokens.first.word == 'EXPLAIN') {
    tokens = tokens.sublist(1);
    if (tokens.length >= 2 &&
        tokens[0].word == 'QUERY' &&
        tokens[1].word == 'PLAN') {
      tokens = tokens.sublist(2);
    }
    if (tokens.isEmpty) return 'the query is empty';
  }
  final first = tokens.first.word;
  if (_transactionWords.contains(first)) {
    return 'it controls a transaction';
  }
  if (first == 'ATTACH' || first == 'DETACH') return 'it adds a database';
  if (first == 'PRAGMA') {
    if (tokens.last.text == ';') tokens = tokens.sublist(0, tokens.length - 1);
    final ok =
        tokens.length >= 4 &&
        _readPragmas.contains(tokens[1].word) &&
        tokens[2].text == '(' &&
        tokens.last.text == ')';
    if (!ok || tokens.any((t) => t.text == '=')) {
      return 'it reads or changes a setting';
    }
  }
  return null;
}

/// The table a write changes, or why the write is refused.
final class WriteTarget {
  const WriteTarget.table(String this.table) : error = null;
  const WriteTarget.refused(String this.error) : table = null;

  final String? table;
  final String? error;
}

const _onlyEdits = 'only INSERT, UPDATE and DELETE on one table run as edits';

/// Finds the target of a single-row edit from the dashboard. Only `INSERT`,
/// `REPLACE`, `UPDATE` and `DELETE` (optionally after a `WITH` clause) on a
/// table named without a schema pass; schema changes, `ATTACH`, `VACUUM`,
/// `PRAGMA` and transaction control never do (ADR 0005).
WriteTarget writeTarget(String sql) {
  final tokens = tokenize(sql);
  var i = 0;
  if (tokens.isNotEmpty && tokens.first.word == 'WITH') {
    var depth = 0;
    i = 1;
    for (; i < tokens.length; i++) {
      final t = tokens[i].text;
      if (t == '(') depth++;
      if (t == ')') depth--;
      if (depth == 0 &&
          const {
            'INSERT',
            'REPLACE',
            'UPDATE',
            'DELETE',
            'SELECT',
          }.contains(tokens[i].word)) {
        break;
      }
    }
  }
  String? word(int k) => k < tokens.length ? tokens[k].word : null;
  if (i >= tokens.length) return const WriteTarget.refused(_onlyEdits);

  int? nameAt;
  switch (word(i)) {
    case 'INSERT':
      var k = i + 1;
      if (word(k) == 'OR') k += 2;
      if (word(k) == 'INTO') nameAt = k + 1;
    case 'REPLACE':
      if (word(i + 1) == 'INTO') nameAt = i + 2;
    case 'UPDATE':
      var k = i + 1;
      if (word(k) == 'OR') k += 2;
      nameAt = k;
    case 'DELETE':
      if (word(i + 1) == 'FROM') nameAt = i + 2;
  }
  if (nameAt == null || nameAt >= tokens.length) {
    return const WriteTarget.refused(_onlyEdits);
  }
  if (nameAt + 1 < tokens.length && tokens[nameAt + 1].text == '.') {
    return const WriteTarget.refused('name the table without a schema');
  }
  final name = unquoteIdent(tokens[nameAt].text);
  if (name == null) return const WriteTarget.refused(_onlyEdits);
  return WriteTarget.table(name);
}

/// The identifier a token names, or null if the token is not one.
String? unquoteIdent(String token) {
  if (token.isEmpty) return null;
  final c = token.codeUnitAt(0);
  if (c == 0x22 || c == 0x60) {
    if (token.length < 2 || token.codeUnitAt(token.length - 1) != c) {
      return null;
    }
    final q = String.fromCharCode(c);
    return token.substring(1, token.length - 1).replaceAll('$q$q', q);
  }
  if (c == 0x5b) {
    if (!token.endsWith(']')) return null;
    return token.substring(1, token.length - 1);
  }
  if (_isWordStart(c)) return token;
  return null;
}

/// Quotes an identifier for SQL text.
String quoteIdent(String name) => '"${name.replaceAll('"', '""')}"';
