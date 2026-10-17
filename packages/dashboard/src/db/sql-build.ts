/**
 * The SQL the Database tab builds itself: table pages and the user's row edits. Names
 * are always quoted and values are always parameters, so neither a table name nor a
 * typed value can become SQL. The daemon's gate still checks every statement.
 */
import type { Cell } from '@project-deck/core';
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

function where(spec: RowFilter, extra?: Built): Built {
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
  if (extra !== undefined) {
    parts.push(extra.sql);
    params.push(...extra.params);
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

export interface KeysetSpec extends RowFilter {
  key: readonly string[];
  /** The key of the last row read; absent for the first page. */
  after?: readonly Param[];
  limit: number;
}

/**
 * One export page in key order, after the last key read. Unlike OFFSET, rows added or
 * removed meanwhile can't make the export repeat or skip a row. A composite key is
 * compared as a row value.
 */
export function keysetQuery(spec: KeysetSpec): Built {
  const keys = spec.key.map(quoteIdent);
  const after =
    spec.after === undefined
      ? undefined
      : keys.length === 1
        ? { sql: `${keys.join('')} > ?`, params: [...spec.after] }
        : {
            sql: `(${keys.join(', ')}) > (${keys.map(() => '?').join(', ')})`,
            params: [...spec.after],
          };
  const w = where(spec, after);
  return {
    sql: `SELECT * FROM ${quoteIdent(spec.table)}${w.sql} ORDER BY ${keys.join(', ')} LIMIT ?`,
    params: [...w.params, spec.limit],
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

/** A column's value as row details showed it, for the optimistic check (review L3). */
export interface ColumnCell {
  column: string;
  cell: Cell;
}

function hexOf(base64: string): string {
  // atob gives one char per byte (0–255), so char codes are the bytes.
  const bytes = atob(base64);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

/**
 * Conditions that hold only while each column still has the value row details read,
 * so a row deleted and added again with the same key isn't changed by mistake. Values
 * go in as parameters, tagged ints too. A blob is never sent whole, so it matches its
 * type, its size and the bytes that were sent (all of them, or the start). An infinity
 * can't be a parameter, so it is the literal SQLite reads as one; NaN is left out,
 * since SQLite stores NaN as NULL and no column can hold it.
 */
function unchanged(originals: readonly ColumnCell[], blobBytes: boolean): Built {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const { column, cell } of originals) {
    const c = quoteIdent(column);
    if (typeof cell !== 'object' || cell === null || cell.type === 'int') {
      parts.push(`${c} IS ?`);
      params.push(cell);
    } else if (cell.type === 'real') {
      if (cell.value === 'Infinity') parts.push(`${c} IS 9e999`);
      else if (cell.value === '-Infinity') parts.push(`${c} IS -9e999`);
    } else {
      parts.push(`typeof(${c}) = 'blob' AND length(${c}) IS ?`);
      params.push(cell.bytes);
      if (blobBytes && cell.base64 !== undefined) {
        const hex = hexOf(cell.base64);
        parts.push(`hex(substr(${c}, 1, ?)) IS ?`);
        params.push(hex.length / 2, hex);
      }
    }
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

/**
 * The most values one edit may send: the Drift package takes 999 (SQLite's old default
 * limit), the daemon 1000.
 */
export const MAX_EDIT_PARAMS = 999;

/** An edit whose row check can't fit in MAX_EDIT_PARAMS values. */
export class EditTooWideError extends Error {
  constructor(
    message = 'This table has too many columns to check the row safely; edit it with SQL in your own tools.',
  ) {
    super(message);
    this.name = 'EditTooWideError';
  }
}

/**
 * The row check that fits the cap: with every blob's bytes, or else with only the
 * blobs' type and size. It never runs an edit without the check (review L3).
 */
function fitted(before: number, originals: readonly ColumnCell[]): Built {
  for (const blobBytes of [true, false]) {
    const same = unchanged(originals, blobBytes);
    if (before + same.params.length <= MAX_EDIT_PARAMS) return same;
  }
  throw new EditTooWideError();
}

export function updateRow(
  table: string,
  key: RowKeyValues,
  changes: ColumnValue[],
  originals: readonly ColumnCell[] = [],
): Built {
  const k = keyWhere(key);
  const same = fitted(changes.length + k.params.length, originals);
  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${changes.map((c) => `${quoteIdent(c.column)} = ?`).join(', ')} WHERE ${k.sql}${same.sql}`,
    params: [...changes.map((c) => c.value), ...k.params, ...same.params],
  };
}

export function deleteRow(
  table: string,
  key: RowKeyValues,
  originals: readonly ColumnCell[] = [],
): Built {
  const k = keyWhere(key);
  const same = fitted(k.params.length, originals);
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE ${k.sql}${same.sql}`,
    params: [...k.params, ...same.params],
  };
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
