import type { DbDiff, TableDiff } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { diffModel } from './diff-model.js';

const table = (over: Partial<TableDiff> = {}): TableDiff => ({
  table: 'orders',
  columns: ['id', 'item', 'status'],
  key: ['id'],
  matchedByRowid: false,
  added: [],
  removed: [],
  changed: [],
  counts: { added: 0, removed: 0, changed: 0 },
  truncated: false,
  ...over,
});

const diff = (tables: TableDiff[]): DbDiff => ({
  db: 'app',
  snapshotId: 'snap-1',
  takenAt: 0,
  tables,
  truncated: false,
  tablesOmitted: 0,
});

describe('diffModel', () => {
  it('says each change in symbols and words, counts first, changed columns marked', () => {
    const model = diffModel(
      diff([
        table({
          added: [{ key: 3, row: [3, 'Cake', 'pending'] }],
          changed: [{ key: 1, row: [1, 'Coffee', 'shipped'], columns: ['status'] }],
          removed: [{ key: 2 }],
          counts: { added: 1, changed: 1, removed: 1 },
        }),
      ]),
    );
    expect(model.empty).toBe(false);
    const [orders] = model.tables;
    expect(orders?.summary).toBe('1 added, 1 changed, 1 removed');
    expect(orders?.rows).toEqual([
      {
        kind: 'added',
        symbol: '+',
        word: 'added',
        key: 'id 3',
        gone: false,
        cells: [
          { column: 'id', text: '3', changed: false },
          { column: 'item', text: 'Cake', changed: false },
          { column: 'status', text: 'pending', changed: false },
        ],
      },
      {
        kind: 'changed',
        symbol: '~',
        word: 'changed',
        key: 'id 1',
        gone: false,
        cells: [
          { column: 'id', text: '1', changed: false },
          { column: 'item', text: 'Coffee', changed: false },
          { column: 'status', text: 'shipped', changed: true },
        ],
      },
      { kind: 'removed', symbol: '−', word: 'removed', key: 'id 2', gone: false, cells: [] },
    ]);
    expect(orders?.more).toBe(0);
  });

  it('says "and N more" past the per-table cap', () => {
    const added = Array.from({ length: 200 }, (_, i) => ({ key: i, row: [i, 'x', 'y'] }));
    const [orders] = diffModel(
      diff([table({ added, counts: { added: 540, removed: 0, changed: 0 }, truncated: true })]),
    ).tables;
    expect(orders?.rows).toHaveLength(200);
    expect(orders?.more).toBe(340);
  });

  it('marks rows that were gone again by the time their values were read', () => {
    const [orders] = diffModel(
      diff([
        table({
          added: [{ key: 9, row: null }],
          changed: [{ key: 1, row: null, columns: ['status'] }],
          counts: { added: 1, removed: 0, changed: 1 },
        }),
      ]),
    ).tables;
    expect(orders?.rows.map((r) => [r.word, r.gone, r.cells])).toEqual([
      ['added', true, []],
      ['changed', true, []],
    ]);
  });

  it('names composite keys and row ids', () => {
    const [t] = diffModel(
      diff([
        table({
          key: ['a', 'b'],
          removed: [{ key: ['x', 2] }],
          counts: { added: 0, removed: 1, changed: 0 },
        }),
      ]),
    ).tables;
    expect(t?.rows[0]?.key).toBe('a x, b 2');
    const [r] = diffModel(
      diff([
        table({
          key: ['rowid'],
          matchedByRowid: true,
          removed: [{ key: 7 }],
          counts: { added: 0, removed: 1, changed: 0 },
        }),
      ]),
    ).tables;
    expect(r?.rows[0]?.key).toBe('row id 7');
    expect(r?.note).toBe('matched by row id');
  });

  it('explains tables it could not compare', () => {
    const model = diffModel(
      diff([
        table({ table: 'big', tooLarge: true, error: { code: 'too-large', message: 'x' } }),
        table({
          table: 'orders',
          error: { code: 'schema-changed', message: "orders's columns changed since the snapshot" },
        }),
        table({ table: 'odd', error: { code: 'unavailable', message: 'The app stopped.' } }),
      ]),
    );
    expect(model.tables.map((t) => t.error)).toEqual([
      'Too large to compare: more than 10,000 rows in big',
      "orders's columns changed since the snapshot",
      "Couldn't compare: The app stopped.",
    ]);
    expect(model.empty).toBe(false);
  });

  it('is empty when no table changed', () => {
    expect(diffModel(diff([])).empty).toBe(true);
  });
});
