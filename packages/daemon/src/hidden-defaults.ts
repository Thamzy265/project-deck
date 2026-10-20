/**
 * `PRAGMA table_info` and `table_xinfo` show every column's default, and a default can be
 * a real value (a shared key, a test account). For Claude, the default of a hidden
 * (table, column) pair is cleared (review R1). The table-valued forms are refused by the
 * gate instead (`claude` rules), since their rows can't be matched to a table.
 */
import type { QueryResult } from '@project-deck/core';

/** SQLite folds ASCII letters only when it compares names. */
export const fold = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `PRAGMA [main.]table_info(<table>)` or `= <table>`, in any of SQLite's quotes. */
const PRAGMA_TABLE =
  /^\s*PRAGMA\s+(?:(?:main|temp|"main"|"temp")\s*\.\s*)?table_x?info\s*(?:\(|=)\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)\s*\)?\s*;?\s*$/i;

function unquote(name: string): string {
  const first = name[0];
  if (first === '"') return name.slice(1, -1).replaceAll('""', '"');
  if (first === "'") return name.slice(1, -1).replaceAll("''", "'");
  if (first === '`' || first === '[') return name.slice(1, -1);
  return name;
}

/** The table a plain table_info/table_xinfo PRAGMA names; undefined for anything else. */
export function pragmaTable(sql: string): string | undefined {
  const quoted = PRAGMA_TABLE.exec(sql)?.[1];
  return quoted === undefined ? undefined : unquote(quoted);
}

/**
 * Clears `dflt_value` for hidden columns. When the PRAGMA's table can't be read from the
 * statement (a comment in it, say), every column named like any hidden column is cleared,
 * and without a `name` column every default is: it fails closed.
 */
export function clearHiddenDefaults(
  sql: string,
  result: QueryResult,
  hidden: readonly { table: string; column: string }[],
): QueryResult {
  const dflt = result.columns.indexOf('dflt_value');
  if (dflt < 0 || hidden.length === 0) return result;
  const table = pragmaTable(sql);
  const names = new Set(
    hidden
      .filter((h) => table === undefined || fold(h.table) === fold(table))
      .map((h) => fold(h.column)),
  );
  if (names.size === 0) return result;
  const name = result.columns.indexOf('name');
  const rows = result.rows.map((row) => {
    const cell = name < 0 ? undefined : row[name];
    const hide = name < 0 || (typeof cell === 'string' && names.has(fold(cell)));
    return hide ? row.map((c, i) => (i === dflt ? null : c)) : row;
  });
  return { ...result, rows };
}
