import type { RowKey, TableHashes } from './db.js';

/** Changes in one table between two diff snapshots, by key. */
export interface TableHashDiff {
  added: RowKey[];
  removed: RowKey[];
  changed: { key: RowKey; columns: string[] }[];
}

/** JSON with object keys sorted, so equal cells give equal text whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A key as text that is equal exactly when the keys are equal (1 and '1' differ). */
export function rowKeyId(key: RowKey): string {
  return canonical(key);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Compares a table's hashes from a snapshot with its hashes now. Old values are never
 * kept, so a diff can name changed columns but show only new values (design note D5).
 */
export function diffTableHashes(
  before: TableHashes,
  after: TableHashes,
): TableHashDiff | { error: { code: 'schema-changed'; message: string } } {
  if (
    !sameList(before.columns, after.columns) ||
    !sameList(before.key, after.key) ||
    (before.rowid ?? false) !== (after.rowid ?? false)
  ) {
    return {
      error: {
        code: 'schema-changed',
        message: `${after.name}'s columns changed since the snapshot`,
      },
    };
  }
  const old = new Map<string, string[]>();
  for (const [key, hashes] of before.rows) old.set(rowKeyId(key), hashes);
  const added: RowKey[] = [];
  const changed: { key: RowKey; columns: string[] }[] = [];
  for (const [key, hashes] of after.rows) {
    const id = rowKeyId(key);
    const was = old.get(id);
    if (was === undefined) {
      added.push(key);
      continue;
    }
    old.delete(id);
    const columns = after.columns.filter((_, i) => was[i] !== hashes[i]);
    if (columns.length > 0) changed.push({ key, columns });
  }
  const removed: RowKey[] = [];
  for (const [key] of before.rows) if (old.has(rowKeyId(key))) removed.push(key);
  return { added, removed, changed };
}
