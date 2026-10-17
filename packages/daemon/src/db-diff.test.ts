import type { DbInspector, KeyedRows, RowHashes, TableInfo } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { CLAUDE_DIFF_CAPS, buildDiff } from './db-diff.js';

const H = (n: number): string => n.toString(16).padStart(16, '0');
const before: RowHashes = {
  takenAt: 1,
  tables: [{ name: 'users', columns: ['id', 'email', 'name'], key: ['id'], rows: [] }],
};
const after: RowHashes = {
  takenAt: 2,
  tables: [
    {
      name: 'users',
      columns: ['id', 'email', 'name'],
      key: ['id'],
      rows: [[1, [H(1), H(2), H(3)]]],
    },
  ],
};

function answering(reply: KeyedRows): DbInspector {
  return {
    id: 'probe',
    live: true,
    writable: false,
    listDatabases: () => Promise.resolve([]),
    schema: () => Promise.resolve([] as TableInfo[]),
    schemaSql: () => Promise.resolve([]),
    query: () => Promise.reject(new Error('unused')),
    rowsByKey: () => Promise.resolve(reply),
  };
}

describe('buildDiff reads rows by column name (DB-1)', () => {
  it('refuses a table whose rows come back with other columns than the snapshot', async () => {
    for (const columns of [
      ['id', 'name'],
      ['id', 'email', 'name', 'phone'],
      ['id', 'name', 'name'],
    ]) {
      const inspector = answering({
        columns,
        key: ['id'],
        rows: [[1, columns.map(() => 'ann@example.com')]],
        missing: [],
        truncated: false,
      });
      const { tables } = await buildDiff(inspector, 'app', before, after, CLAUDE_DIFF_CAPS, [
        { table: 'users', column: 'email' },
      ]);
      expect(tables, columns.join()).toEqual([
        expect.objectContaining({
          table: 'users',
          error: expect.objectContaining({ code: 'schema-changed' }) as unknown,
        }),
      ]);
      expect(JSON.stringify(tables)).not.toContain('ann@example.com');
    }
  });

  it('refuses a row with fewer cells than the reply names', async () => {
    const inspector = answering({
      columns: ['id', 'email', 'name'],
      key: ['id'],
      rows: [[1, [1, 'ann@example.com']]],
      missing: [],
      truncated: false,
    });
    const { tables } = await buildDiff(inspector, 'app', before, after, CLAUDE_DIFF_CAPS, []);
    expect(tables[0]?.error?.code).toBe('schema-changed');
  });
});
