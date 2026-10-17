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

/** The reply's columns don't match the snapshot's: the schema changed mid-diff. */
class ColumnsChanged extends Error {}

/**
 * Values by key for the keys asked, in batches the backends accept, each row as a map
 * from the reply's own column names. A reply whose columns aren't the snapshot's is
 * refused: mapping by position could put a hidden value in a visible slot (DB-1).
 */
async function readRows(
  inspector: DbInspector,
  db: string,
  table: string,
  columns: readonly string[],
  keys: RowKey[],
): Promise<Map<string, Map<string, Cell>>> {
  const rows = new Map<string, Map<string, Cell>>();
  if (inspector.rowsByKey === undefined || keys.length === 0) return rows;
  const expected = [...columns].sort().join('\u0000');
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
    const reply = await inspector.rowsByKey(db, table, keys.slice(i, i + MAX_KEYS_PER_CALL));
    if (
      new Set(reply.columns).size !== reply.columns.length ||
      [...reply.columns].sort().join('\u0000') !== expected
    ) {
      throw new ColumnsChanged();
    }
    for (const [key, cells] of reply.rows) {
      if (cells.length !== reply.columns.length) throw new ColumnsChanged();
      rows.set(rowKeyId(key), new Map(reply.columns.map((c, j) => [c, cells[j] ?? null])));
    }
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
    const visible = shape.columns.filter((c) => !hiddenHere.has(fold(c))).map((c) => ({ c }));
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
    let values: Map<string, Map<string, Cell>>;
    try {
      values = await readRows(inspector, db, name, shape.columns, [
        ...addedKeys,
        ...changedShown.map((c) => c.key),
      ]);
    } catch (err) {
      if (!(err instanceof ColumnsChanged)) throw err;
      out.push({
        ...empty(name, [], [], false),
        error: {
          code: 'schema-changed',
          message: `${name}'s columns changed while comparing; take a new snapshot`,
        },
      });
      continue;
    }
    const row = (key: RowKey): Cell[] | undefined => {
      const cells = values.get(rowKeyId(key));
      return cells === undefined ? undefined : visible.map((v) => cells.get(v.c) ?? null);
    };
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
