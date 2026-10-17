import type { TableInfo } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { changedRows, keyColumns, rowKey } from './keys.js';

const table = (over: Partial<TableInfo> = {}): TableInfo => ({
  name: 't',
  kind: 'table',
  columns: [
    { name: 'b', type: 'TEXT', nullable: false, pk: true, pkPosition: 2, default: null },
    { name: 'a', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
    { name: 'v', type: 'TEXT', nullable: true, pk: false, default: null },
  ],
  foreignKeys: [],
  indexes: [],
  ...over,
});

describe('keys', () => {
  it('orders key columns by their key position', () => {
    expect(keyColumns(table())).toEqual(['a', 'b']);
  });

  it('reads a row key as parameters, or nothing for views and blob keys', () => {
    expect(rowKey(table(), ['b', 'a', 'v'], ['x', 1, 'y'])).toEqual({
      columns: ['a', 'b'],
      values: [1, 'x'],
    });
    expect(rowKey(table({ kind: 'view' }), ['b', 'a', 'v'], ['x', 1, 'y'])).toBeUndefined();
    expect(
      rowKey(table(), ['b', 'a', 'v'], [{ type: 'blob', bytes: 1, base64: 'AA==' }, 1, 'y']),
    ).toBeUndefined();
    expect(rowKey(table(), ['v'], ['y'])).toBeUndefined();
  });

  it('finds new and changed rows by key, whatever their position', () => {
    const prev = {
      columns: ['id', 'v'],
      rows: [
        [1, 'a'],
        [2, 'b'],
      ],
    };
    const next = {
      columns: ['id', 'v'],
      rows: [
        [3, 'c'],
        [1, 'a'],
        [2, 'B'],
      ],
    };
    expect([...changedRows(['id'], prev, next)]).toEqual([0, 2]);
    expect([...changedRows([], prev, next)]).toEqual([0, 2]);
  });
});
