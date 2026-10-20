import type { QueryResult } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { clearHiddenDefaults, pragmaTable } from './hidden-defaults.js';

const info = (rows: QueryResult['rows']): QueryResult => ({
  columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
  rows,
  truncated: false,
  durationMs: 0,
});
const hidden = [{ table: 'Users', column: 'API_KEY' }];

describe('pragmaTable', () => {
  it.each([
    ['PRAGMA table_info(users)', 'users'],
    ["pragma TABLE_XINFO('users');", 'users'],
    ['PRAGMA main.table_info("we""ird")', 'we"ird'],
    ['PRAGMA table_info = [users]', 'users'],
    ['PRAGMA table_info(`users`)', 'users'],
  ])('reads the table of %s', (sql, table) => {
    expect(pragmaTable(sql)).toBe(table);
  });

  it.each(['PRAGMA /* c */ table_info(users)', 'PRAGMA index_list(users)', 'SELECT 1'])(
    'reads none from %s',
    (sql) => {
      expect(pragmaTable(sql)).toBeUndefined();
    },
  );
});

describe('clearHiddenDefaults (review R1)', () => {
  const rows = [
    [0, 'id', 'INTEGER', 1, null, 1],
    [1, 'api_key', 'TEXT', 0, "'k1'", 0],
    [2, 'plan', 'TEXT', 0, "'free'", 0],
  ];

  it('clears the hidden column of the named table only, matching names like SQLite', () => {
    expect(clearHiddenDefaults('PRAGMA table_info(users)', info(rows), hidden).rows).toEqual([
      rows[0],
      [1, 'api_key', 'TEXT', 0, null, 0],
      rows[2],
    ]);
    expect(clearHiddenDefaults('PRAGMA table_info(orders)', info(rows), hidden).rows).toEqual(rows);
  });

  it('clears by column name in any table when the table cannot be read (fails closed)', () => {
    const out = clearHiddenDefaults('PRAGMA /* x */ table_info(orders)', info(rows), hidden);
    expect(out.rows[1]?.[4]).toBeNull();
    expect(out.rows[2]?.[4]).toBe("'free'");
  });

  it('clears every default when there is no name column', () => {
    const out = clearHiddenDefaults(
      'PRAGMA table_info(users)',
      { ...info(rows), columns: ['cid', 'x', 'type', 'notnull', 'dflt_value', 'pk'] },
      hidden,
    );
    expect(out.rows.map((r) => r[4])).toEqual([null, null, null]);
  });
});
