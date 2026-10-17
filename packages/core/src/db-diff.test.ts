import { describe, expect, it } from 'vitest';
import type { TableHashes } from './db.js';
import { DbError, RowHashesSchema, KeyedRowsSchema, isDbError } from './db.js';
import { diffTableHashes, rowKeyId } from './db-diff.js';

const H = (n: number): string => n.toString(16).padStart(16, '0');

function table(rows: [unknown, string[]][], over: Partial<TableHashes> = {}): TableHashes {
  return {
    name: 'orders',
    columns: ['id', 'item', 'status'],
    key: ['id'],
    rows,
    ...over,
  } as TableHashes;
}

describe('diffTableHashes', () => {
  it('names added, removed and changed rows, with the changed columns', () => {
    const before = table([
      [1, [H(1), H(2), H(3)]],
      [2, [H(4), H(5), H(6)]],
    ]);
    const after = table([
      [1, [H(1), H(2), H(9)]],
      [3, [H(7), H(8), H(3)]],
    ]);
    expect(diffTableHashes(before, after)).toEqual({
      added: [3],
      removed: [2],
      changed: [{ key: 1, columns: ['status'] }],
    });
  });

  it('matches composite keys and blob keys by value, not by object identity', () => {
    const blob = { type: 'blob', bytes: 2, base64: 'AQI=' };
    const before = table([[[1, blob], [H(1)]]], { columns: ['a'], key: ['k1', 'k2'] });
    const after = table([[[1, { base64: 'AQI=', bytes: 2, type: 'blob' }], [H(1)]]], {
      columns: ['a'],
      key: ['k1', 'k2'],
    });
    expect(diffTableHashes(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('refuses to compare a table whose columns or key changed', () => {
    const before = table([[1, [H(1), H(2), H(3)]]]);
    expect(diffTableHashes(before, table([], { columns: ['id', 'item'] }))).toEqual({
      error: { code: 'schema-changed', message: "orders's columns changed since the snapshot" },
    });
    expect(diffTableHashes(before, table([], { key: ['rowid'], rowid: true }))).toMatchObject({
      error: { code: 'schema-changed' },
    });
  });

  it('keeps 1, 1.0 and "1" apart as keys', () => {
    expect(rowKeyId(1)).not.toBe(rowKeyId('1'));
    expect(rowKeyId({ type: 'int', value: '1' })).not.toBe(rowKeyId(1));
    expect(rowKeyId([1, 'a'])).toBe(rowKeyId([1, 'a']));
  });
});

describe('row hash shapes', () => {
  it('accept the recorded flutterdeck_drift snapshot reply, with per-table errors', () => {
    const reply = {
      takenAt: 1792176214286,
      tables: [
        { name: 'lines', columns: ['order_id', 'n'], key: ['rowid'], rowid: true, rows: [] },
        {
          name: 'orders',
          columns: ['id', 'item', 'status'],
          key: ['id'],
          rows: [[1, ['529a2ddc8ff5355f', '2e1d5ff04220d18e', 'b8413ec34aa45d35']]],
        },
        { name: 'big', error: { code: 'too-large', message: 'Too large to diff' } },
      ],
    };
    expect(RowHashesSchema.parse(reply)).toEqual(reply);
    const bad = {
      ...reply,
      tables: [{ name: 'x', columns: [], key: ['id'], rows: [[1, ['zz']]] }],
    };
    expect(RowHashesSchema.safeParse(bad).success).toBe(false);
  });

  it('accept the recorded rows reply', () => {
    const reply = {
      columns: ['id', 'item', 'status'],
      key: ['id'],
      rows: [[3, [3, 'Cake', 'pending']]],
      missing: [99],
      truncated: false,
    };
    expect(KeyedRowsSchema.parse(reply)).toEqual(reply);
  });
});

describe('DbError', () => {
  it('carries a code and is recognised across copies of core', () => {
    const err = new DbError('busy', 'The app is writing; try Refresh.');
    expect(err.code).toBe('busy');
    expect(isDbError(err)).toBe(true);
    expect(isDbError({ name: 'DbError', code: 'busy', message: 'x' })).toBe(false);
    expect(isDbError(new Error('x'))).toBe(false);
  });
});
