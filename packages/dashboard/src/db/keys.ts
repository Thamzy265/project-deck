import type { Cell, TableInfo } from '@project-deck/core';
import type { Param } from './cells.js';
import { keyParam } from './cells.js';

/** The table's primary-key columns in key order; empty for views and tables without one. */
export function keyColumns(table: TableInfo): string[] {
  return table.columns
    .filter((c) => c.pk)
    .sort((a, b) => (a.pkPosition ?? 0) - (b.pkPosition ?? 0))
    .map((c) => c.name);
}

export interface RowKeyValues {
  columns: string[];
  values: Param[];
}

/** Why a row can't be edited: the tooltip of the disabled Edit and Delete row buttons. */
export const NO_KEY = 'This row has no primary key to find it by';
export const NULL_KEY = 'Its primary key is null, which can match more than one row';
export const ODD_KEY = "Its primary key can't be sent: it is a blob or an odd number";

/**
 * The key of a row as parameters, or why it can't find this row only: no key, or a key
 * value that may match more rows. SQLite lets a rowid table hold NULL in a non-INTEGER
 * primary key more than once, so `"k" IS NULL` would match them all (TAB-1).
 */
export function rowKeyOrReason(
  table: TableInfo,
  columns: readonly string[],
  row: readonly Cell[],
): { key: RowKeyValues } | { reason: string } {
  const key = keyColumns(table);
  if (key.length === 0 || table.kind !== 'table') return { reason: NO_KEY };
  const values: Param[] = [];
  for (const name of key) {
    const at = columns.indexOf(name);
    if (at === -1) return { reason: NO_KEY };
    const cell = row[at] ?? null;
    if (cell === null) return { reason: NULL_KEY };
    const param = keyParam(cell);
    if (!param.ok) return { reason: ODD_KEY };
    values.push(param.value);
  }
  return { key: { columns: key, values } };
}

/** The key of a row as parameters, or undefined when it can't find this row only. */
export function rowKey(
  table: TableInfo,
  columns: readonly string[],
  row: readonly Cell[],
): RowKeyValues | undefined {
  const r = rowKeyOrReason(table, columns, row);
  return 'key' in r ? r.key : undefined;
}

/** Text that is equal exactly when two rows have the same key (or, without one, the same cells). */
export function rowIdentity(
  key: readonly string[],
  columns: readonly string[],
  row: readonly Cell[],
): string {
  if (key.length === 0) return JSON.stringify(row);
  return JSON.stringify(key.map((k) => row[columns.indexOf(k)] ?? null));
}

/** Rows of `next` that are new or changed since `prev` (UI spec: they flash). */
export function changedRows(
  key: readonly string[],
  prev: { columns: readonly string[]; rows: readonly (readonly Cell[])[] },
  next: { columns: readonly string[]; rows: readonly (readonly Cell[])[] },
): Set<number> {
  const before = new Map<string, string>();
  for (const row of prev.rows) before.set(rowIdentity(key, prev.columns, row), JSON.stringify(row));
  const out = new Set<number>();
  next.rows.forEach((row, i) => {
    const was = before.get(rowIdentity(key, next.columns, row));
    if (was !== JSON.stringify(row)) out.add(i);
  });
  return out;
}
