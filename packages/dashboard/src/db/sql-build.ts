/**
 * The SQL the Database tab builds itself: table pages and the user's row edits. Names
 * are always quoted and values are always parameters, so neither a table name nor a
 * typed value can become SQL. The daemon's gate still checks every statement.
 */
import type { Param } from './cells.js';

export interface Built {
  sql: string;
  params: Param[];
}

/** A name in double quotes, safe in SQL whatever it holds. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Text for `LIKE ? ESCAPE '\'` that matches itself only. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface RowFilter {
  table: string;
  columns: readonly string[];
  /** Free text, matched anywhere in any column. */
  filter?: string;
  /** One value of one column, from a foreign-key link. */
  match?: { column: string; value: Param };
}

function where(spec: RowFilter): Built {
  const parts: string[] = [];
  const params: Param[] = [];
  if (spec.match !== undefined) {
    parts.push(`${quoteIdent(spec.match.column)} IS ?`);
    params.push(spec.match.value);
  }
  const text = spec.filter ?? '';
  if (text !== '' && spec.columns.length > 0) {
    const like = `%${escapeLike(text)}%`;
    parts.push(
      `(${spec.columns
        .map((c) => {
          params.push(like);
          return `CAST(${quoteIdent(c)} AS TEXT) LIKE ? ESCAPE '\\'`;
        })
        .join(' OR ')})`,
    );
  }
  return { sql: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`, params };
}

export interface PageSpec extends RowFilter {
  /** Key columns: the order when nothing else is chosen, and the tie-break. */
  key: readonly string[];
  sort?: { column: string; dir: 'asc' | 'desc' };
  offset: number;
  limit: number;
}

export function pageQuery(spec: PageSpec): Built {
  const w = where(spec);
  const order: string[] = [];
  if (spec.sort !== undefined) {
    order.push(`${quoteIdent(spec.sort.column)}${spec.sort.dir === 'desc' ? ' DESC' : ''}`);
  }
  for (const k of spec.key) if (k !== spec.sort?.column) order.push(quoteIdent(k));
  const orderBy = order.length === 0 ? '' : ` ORDER BY ${order.join(', ')}`;
  return {
    sql: `SELECT * FROM ${quoteIdent(spec.table)}${w.sql}${orderBy} LIMIT ? OFFSET ?`,
    params: [...w.params, spec.limit, spec.offset],
  };
}

export function countQuery(spec: RowFilter): Built {
  const w = where(spec);
  return { sql: `SELECT count(*) FROM ${quoteIdent(spec.table)}${w.sql}`, params: w.params };
}

export interface RowKeyValues {
  columns: readonly string[];
  values: readonly Param[];
}

export interface ColumnValue {
  column: string;
  value: Param;
}

function keyWhere(key: RowKeyValues): Built {
  return {
    sql: key.columns.map((c) => `${quoteIdent(c)} IS ?`).join(' AND '),
    params: [...key.values],
  };
}

export function updateRow(table: string, key: RowKeyValues, changes: ColumnValue[]): Built {
  const k = keyWhere(key);
  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${changes.map((c) => `${quoteIdent(c.column)} = ?`).join(', ')} WHERE ${k.sql}`,
    params: [...changes.map((c) => c.value), ...k.params],
  };
}

export function deleteRow(table: string, key: RowKeyValues): Built {
  const k = keyWhere(key);
  return { sql: `DELETE FROM ${quoteIdent(table)} WHERE ${k.sql}`, params: k.params };
}

export function insertRow(table: string, values: ColumnValue[]): Built {
  if (values.length === 0)
    return { sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`, params: [] };
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${values.map((v) => quoteIdent(v.column)).join(', ')}) VALUES (${values.map(() => '?').join(', ')})`,
    params: values.map((v) => v.value),
  };
}

/** SQLite's affinity rules (datatype3, 3.1): which declared types hold numbers. */
function numericAffinity(type: string): boolean {
  const t = type.toUpperCase();
  if (t.includes('INT')) return true;
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT') || t.includes('BLOB')) {
    return false;
  }
  return (
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('NUM') ||
    t.includes('DEC') ||
    t.includes('BOOL') ||
    t.includes('DATE')
  );
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * What the user typed, as a parameter: a number for numeric columns when it reads as
 * one exactly (integers past 2^53 stay text, which the column's affinity converts),
 * text otherwise.
 */
export function inputParam(text: string, declaredType: string): Param {
  if (!numericAffinity(declaredType) || !NUMBER.test(text)) return text;
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return text;
  return n;
}
