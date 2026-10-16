/**
 * The second hidden-column layer (tester findings SG-1, SG-3, SG-4): the authorizer
 * misses reads SQLite makes for itself, such as the comparison behind JOIN … USING or
 * NATURAL JOIN, a virtual generated column computed from a hidden one, and the order
 * of an index on a hidden column. The compiled program can't hide them: every value
 * comes out of a table or index cursor. So the gate lists the program (EXPLAIN, which
 * runs nothing) and refuses when an opcode reads a hidden column.
 */

/** One row of an EXPLAIN listing: the opcode and its first three operands. */
export interface Op {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
}

/** A b-tree in the main schema, by root page. Names are folded. */
export type BTree =
  | {
      kind: 'table';
      table: string;
      /** Column names in record (storage) order, as OP_Column numbers them. */
      storage: string[];
      /** The INTEGER PRIMARY KEY column, which is the rowid; undefined if none. */
      rowidAlias: string | undefined;
      withoutRowid: boolean;
    }
  | {
      kind: 'index';
      table: string;
      /** Key column names; '' for an expression. */
      columns: string[];
      partial: boolean;
    };

/** Opcodes that only count or close a cursor: they read no column value. */
const HARMLESS_ON_HIDDEN_CURSOR: ReadonlySet<string> = new Set(['Count', 'Close', 'ColumnsUsed']);
/** Opcodes that read, test or seek a table cursor's rowid. */
const ROWID_OPS: ReadonlySet<string> = new Set([
  'Rowid',
  'SeekRowid',
  'NotExists',
  'SeekGE',
  'SeekGT',
  'SeekLE',
  'SeekLT',
]);
/** Opcodes that take a cursor in p1 (the others use p1 for a register or a value). */
const CURSOR_OPS: ReadonlySet<string> = new Set([
  'Column',
  'Rowid',
  'IdxRowid',
  'Rewind',
  'Last',
  'Next',
  'Prev',
  'SeekGE',
  'SeekGT',
  'SeekLE',
  'SeekLT',
  'SeekRowid',
  'SeekScan',
  'SeekHit',
  'NotExists',
  'Found',
  'NotFound',
  'NoConflict',
  'IfNoHope',
  'IdxGE',
  'IdxGT',
  'IdxLE',
  'IdxLT',
  'DeferredSeek',
  'IfNullRow',
  'RowData',
  'Count',
  'Close',
  'ColumnsUsed',
  'FinishSeek',
]);

interface Cursor {
  tree: BTree;
  /** Opened for writing: the row an edit rewrites, which is read back unseen. */
  write: boolean;
}

/**
 * Returns "table.column" for the first hidden read in `ops`, else undefined.
 * `hidden` holds folded "table.column" pairs (generated columns built on hidden ones
 * included). `trees` maps main-schema root pages to their b-tree.
 */
export function findHiddenRead(
  ops: readonly Op[],
  trees: ReadonlyMap<number, BTree>,
  hidden: ReadonlySet<string>,
): string | undefined {
  const tablesWithHidden = new Set([...hidden].map((pair) => pair.slice(0, pair.indexOf('.'))));
  const isHidden = (table: string, column: string) => hidden.has(`${table}.${column}`);
  const cursors = new Map<number, Cursor>();

  // An index (or a WITHOUT ROWID table, stored as one) that orders or holds a hidden
  // value. Expression and partial indexes on a table with hidden columns count, since
  // the gate can't tell what their expressions read.
  const hiddenTree = (tree: BTree): string | undefined => {
    if (!tablesWithHidden.has(tree.table)) return undefined;
    if (tree.kind === 'index') {
      const named = tree.columns.find((c) => c !== '' && isHidden(tree.table, c));
      if (named !== undefined) return `${tree.table}.${named}`;
      if (tree.partial || tree.columns.includes('')) return `${tree.table} (an index on it)`;
      return undefined;
    }
    if (tree.withoutRowid) {
      const col = tree.storage.find((c) => isHidden(tree.table, c));
      return col === undefined ? undefined : `${tree.table}.${col}`;
    }
    return undefined;
  };

  for (const op of ops) {
    if (op.opcode === 'OpenRead' || op.opcode === 'OpenWrite' || op.opcode === 'ReopenIdx') {
      // p3 is the database: 0 main, 1 temp. Only main holds the app's schema.
      const tree = op.p3 === 0 ? trees.get(op.p2) : undefined;
      if (tree === undefined) cursors.delete(op.p1);
      else cursors.set(op.p1, { tree, write: op.opcode === 'OpenWrite' });
      continue;
    }
    if (op.opcode === 'OpenDup') {
      const source = cursors.get(op.p2);
      if (source !== undefined) cursors.set(op.p1, source);
      continue;
    }
    if (!CURSOR_OPS.has(op.opcode)) continue;
    const cursor = cursors.get(op.p1);
    if (cursor === undefined || cursor.write) continue;
    const { tree } = cursor;

    const wholeTree = hiddenTree(tree);
    if (wholeTree !== undefined) {
      if (HARMLESS_ON_HIDDEN_CURSOR.has(op.opcode)) continue;
      return wholeTree;
    }

    if (tree.kind === 'table') {
      if (op.opcode === 'Column') {
        const column = tree.storage[op.p2];
        if (column !== undefined && isHidden(tree.table, column)) {
          return `${tree.table}.${column}`;
        }
      }
      const alias = tree.rowidAlias;
      if (alias !== undefined && isHidden(tree.table, alias) && ROWID_OPS.has(op.opcode)) {
        return `${tree.table}.${alias}`;
      }
      continue;
    }
    // An index cursor on a table whose rowid is hidden: every index entry ends with it.
    const owner = [...trees.values()].find((t) => t.kind === 'table' && t.table === tree.table);
    const alias = owner?.kind === 'table' ? owner.rowidAlias : undefined;
    if (
      alias !== undefined &&
      isHidden(tree.table, alias) &&
      (op.opcode === 'IdxRowid' || op.opcode === 'DeferredSeek')
    ) {
      return `${tree.table}.${alias}`;
    }
  }
  return undefined;
}
