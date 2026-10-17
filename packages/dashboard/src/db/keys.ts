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

/** The key of a row as parameters, or undefined when it can't be sent (no key, blob keys). */
export function rowKey(
  table: TableInfo,
  columns: readonly string[],
  row: readonly Cell[],
): { columns: string[]; values: Param[] } | undefined {
  const key = keyColumns(table);
  if (key.length === 0 || table.kind !== 'table') return undefined;
  const values: Param[] = [];
  for (const name of key) {
    const at = columns.indexOf(name);
    if (at === -1) return undefined;
    const param = keyParam(row[at] ?? null);
    if (!param.ok) return undefined;
    values.push(param.value);
  }
  return { columns: key, values };
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
