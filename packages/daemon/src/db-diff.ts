/**
 * Builds a diff answer from two hash snapshots (design note D5): compares hashes, then
 * reads values only for the added and changed rows it will show, by key. Caps differ by
 * caller (D6), and Claude never sees hidden columns (D2).
 */
import type {
  Cell,
  DbInspector,
  RowHashes,
  RowKey,
  TableDiff,
  TableHashes,
} from '@project-deck/core';
import { MAX_KEYS_PER_CALL, diffTableHashes, rowKeyId } from '@project-deck/core';

export interface DiffCaps {
  /** Rows shown per table (added, then changed, then removed). */
  rowsPerTable: number;
  /** Tables shown. */
  tables: number;
}

/** D6: Claude 50 rows per table and 20 tables; the dashboard 200 rows per table (UI spec). */
export const CLAUDE_DIFF_CAPS: DiffCaps = { rowsPerTable: 50, tables: 20 };
export const DASHBOARD_DIFF_CAPS: DiffCaps = { rowsPerTable: 200, tables: Infinity };

/** What Claude sees in place of a key that holds a hidden column. */
export const HIDDEN = '[hidden]';

type Hashes = RowHashes['tables'][number];

/** SQLite folds ASCII letters only when it compares names. */
const fold = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

function empty(name: string, columns: string[], key: string[], rowid: boolean): TableDiff {
  return {
    table: name,
    columns,
    key,
    matchedByRowid: rowid,
    added: [],
    removed: [],
    changed: [],
    counts: { added: 0, removed: 0, changed: 0 },
    truncated: false,
  };
}

const asTable = (t: Hashes | undefined): TableHashes | undefined =>
  t === undefined || 'error' in t ? undefined : t;

/** Values by key for the keys asked, in batches the backends accept. */
async function readRows(
  inspector: DbInspector,
  db: string,
  table: string,
  keys: RowKey[],
): Promise<Map<string, Cell[]>> {
  const rows = new Map<string, Cell[]>();
  if (inspector.rowsByKey === undefined) return rows;
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
    const reply = await inspector.rowsByKey(db, table, keys.slice(i, i + MAX_KEYS_PER_CALL));
    for (const [key, cells] of reply.rows) rows.set(rowKeyId(key), cells);
  }
  return rows;
}

export async function buildDiff(
  inspector: DbInspector,
  db: string,
  before: RowHashes,
  after: RowHashes,
  caps: DiffCaps,
  hidden: readonly { table: string; column: string }[] | undefined,
): Promise<{ tables: TableDiff[]; truncated: boolean }> {
  const old = new Map(before.tables.map((t) => [t.name, t]));
  const names = [
    ...after.tables.map((t) => t.name),
    ...before.tables.map((t) => t.name).filter((n) => !after.tables.some((t) => t.name === n)),
  ];
  const now = new Map(after.tables.map((t) => [t.name, t]));
  const out: TableDiff[] = [];
  let truncated = false;
  for (const name of names) {
    const a = now.get(name);
    const b = old.get(name);
    const problem =
      (a !== undefined && 'error' in a ? a.error : undefined) ??
      (b !== undefined && 'error' in b ? b.error : undefined);
    if (problem !== undefined) {
      out.push({
        ...empty(name, [], [], false),
        ...(problem.code === 'too-large' ? { tooLarge: true } : {}),
        error: problem,
      });
      continue;
    }
    const at = asTable(a);
    const bt = asTable(b);
    const shape = at ?? bt;
    if (shape === undefined) continue;
    // A table created or dropped since the snapshot: every row added or removed.
    const result = diffTableHashes(bt ?? { ...shape, rows: [] }, at ?? { ...shape, rows: [] });
    if ('error' in result) {
      out.push({
        ...empty(name, shape.columns, shape.key, shape.rowid ?? false),
        error: result.error,
      });
      continue;
    }
    const hiddenHere = new Set(
      (hidden ?? []).filter((h) => fold(h.table) === fold(name)).map((h) => fold(h.column)),
    );
    const visible = shape.columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !hiddenHere.has(fold(c)));
    const keyHidden = shape.key.some((k) => hiddenHere.has(fold(k)));
    // A change only in hidden columns would tell Claude that hidden data changed.
    const changed = result.changed
      .map((ch) => ({ ...ch, columns: ch.columns.filter((c) => !hiddenHere.has(fold(c))) }))
      .filter((ch) => ch.columns.length > 0);
    const counts = {
      added: result.added.length,
      removed: result.removed.length,
      changed: changed.length,
    };
    if (counts.added + counts.removed + counts.changed === 0) continue;
    if (out.length >= caps.tables) {
      truncated = true;
      break;
    }
    let room = caps.rowsPerTable;
    const take = <T>(list: T[]): T[] => {
      const shown = list.slice(0, Math.max(room, 0));
      room -= shown.length;
      return shown;
    };
    const addedKeys = take(result.added);
    const changedShown = take(changed);
    const removedKeys = take(result.removed);
    const values = await readRows(inspector, db, name, [
      ...addedKeys,
      ...changedShown.map((c) => c.key),
    ]);
    const row = (key: RowKey): Cell[] | undefined =>
      values.get(rowKeyId(key))?.filter((_, i) => visible.some((v) => v.i === i));
    const shownKey = (key: RowKey): RowKey => (keyHidden ? HIDDEN : key);
    const table: TableDiff = {
      ...empty(
        name,
        visible.map((v) => v.c),
        shape.key,
        shape.rowid ?? false,
      ),
      added: addedKeys.flatMap((key) => {
        const cells = row(key);
        return cells === undefined ? [] : [{ key: shownKey(key), row: cells }];
      }),
      changed: changedShown.flatMap((ch) => {
        const cells = row(ch.key);
        return cells === undefined
          ? []
          : [{ key: shownKey(ch.key), row: cells, columns: ch.columns }];
      }),
      removed: removedKeys.map((key) => ({ key: shownKey(key) })),
      counts,
      truncated:
        addedKeys.length + changedShown.length + removedKeys.length <
        counts.added + counts.changed + counts.removed,
    };
    out.push(table);
  }
  return { tables: out, truncated };
}
