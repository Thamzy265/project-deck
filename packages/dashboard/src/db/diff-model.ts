/**
 * What the Diff view shows, worked out from the daemon's answer (UI spec, Diff view):
 * per table, counts first, then rows with a symbol and a word (+ added, ~ changed,
 * − removed), so colour is never the only sign; changed columns are marked; rows past
 * the cap are counted as "and N more".
 */
import type { Cell, DbDiff, RowKey, TableDiff } from '@project-deck/core';
import { cellText } from './cells.js';

export type DiffKind = 'added' | 'changed' | 'removed';

const SYMBOL: Record<DiffKind, '+' | '~' | '−'> = { added: '+', changed: '~', removed: '−' };

export interface DiffCell {
  column: string;
  text: string;
  changed: boolean;
}

export interface DiffRowModel {
  kind: DiffKind;
  symbol: '+' | '~' | '−';
  word: DiffKind;
  /** e.g. "id 3", "a x, b 2", "row id 7". */
  key: string;
  /** True when the row was gone again by the time its values were read. */
  gone: boolean;
  cells: DiffCell[];
}

export interface DiffTableModel {
  table: string;
  columns: string[];
  summary: string;
  rows: DiffRowModel[];
  /** Rows counted but not shown (per-table cap). */
  more: number;
  note?: string;
  error?: string;
}

function keyPart(cell: Cell): string {
  return cellText(cell).text;
}

function keyText(t: TableDiff, key: RowKey): string {
  if (t.matchedByRowid) return `row id ${keyPart(Array.isArray(key) ? (key[0] ?? null) : key)}`;
  const values = Array.isArray(key) ? key : [key];
  return t.key.map((name, i) => `${name} ${keyPart(values[i] ?? null)}`).join(', ');
}

function cells(t: TableDiff, row: Cell[], changed: readonly string[] = []): DiffCell[] {
  return t.columns.map((column, i) => ({
    column,
    text: cellText(row[i] ?? null).text,
    changed: changed.includes(column),
  }));
}

function tableError(t: TableDiff): string | undefined {
  if (t.tooLarge === true) return `Too large to compare: more than 10,000 rows in ${t.table}`;
  if (t.error === undefined) return undefined;
  if (t.error.code === 'schema-changed') return t.error.message;
  return `Couldn't compare: ${t.error.message}`;
}

function tableModel(t: TableDiff): DiffTableModel {
  const row = (
    kind: DiffKind,
    key: RowKey,
    values: Cell[] | null | undefined,
    changed?: string[],
  ) => ({
    kind,
    symbol: SYMBOL[kind],
    word: kind,
    key: keyText(t, key),
    gone: values === null,
    cells: values === null || values === undefined ? [] : cells(t, values, changed),
  });
  const rows: DiffRowModel[] = [
    ...t.added.map((a) => row('added', a.key, a.row)),
    ...t.changed.map((c) => row('changed', c.key, c.row, c.columns)),
    ...t.removed.map((r) => row('removed', r.key, undefined)),
  ];
  const total = t.counts.added + t.counts.changed + t.counts.removed;
  const error = tableError(t);
  return {
    table: t.table,
    columns: t.columns,
    summary: `${t.counts.added} added, ${t.counts.changed} changed, ${t.counts.removed} removed`,
    rows,
    more: Math.max(0, total - rows.length),
    ...(t.matchedByRowid ? { note: 'matched by row id' } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

export function diffModel(diff: DbDiff): {
  tables: DiffTableModel[];
  empty: boolean;
  omitted: number;
} {
  const tables = diff.tables.map(tableModel);
  return { tables, empty: tables.length === 0, omitted: diff.tablesOmitted };
}
