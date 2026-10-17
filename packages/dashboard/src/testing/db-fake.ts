import type { Cell, DbList, QueryResult, SavedQuery, TableInfo } from '@project-deck/core';
import { vi } from 'vitest';
import type { DbClient } from '../api/db-client.js';
import { DbApiError } from '../api/db-client.js';

const col = (name: string, type: string, pk = false) => ({
  name,
  type,
  nullable: !pk,
  pk,
  ...(pk ? { pkPosition: 1 } : {}),
  default: null,
});

export const ordersInfo: TableInfo = {
  name: 'orders',
  kind: 'table',
  columns: [
    col('id', 'INTEGER', true),
    col('item', 'TEXT'),
    col('status', 'TEXT'),
    col('customer_id', 'INTEGER'),
  ],
  foreignKeys: [{ from: 'customer_id', table: 'customers', to: 'id' }],
  indexes: [],
};

export const customersInfo: TableInfo = {
  name: 'customers',
  kind: 'table',
  columns: [col('id', 'INTEGER', true), col('name', 'TEXT')],
  foreignKeys: [],
  indexes: [],
};

export interface FakeDbData {
  list: DbList;
  tables: TableInfo[];
  rows: Record<string, Cell[][]>;
  saved: SavedQuery[];
  /** The saved queries' revision, 'none' before the first save (review R1). */
  revision: string;
}

export function fakeDbData(over: Partial<FakeDbData> = {}): FakeDbData {
  return {
    list: {
      databases: [{ name: 'app', backend: 'live', source: 'drift' }],
      sources: [{ id: 'drift', live: true, writable: true }],
      writesAllowed: false,
    },
    tables: [customersInfo, ordersInfo],
    rows: {
      orders: [
        [1, 'Coffee', 'pending', 1],
        [2, 'Tea', 'shipped', 2],
      ],
      customers: [
        [1, 'Ada'],
        [2, 'Grace'],
      ],
    },
    saved: [],
    revision: 'none',
    ...over,
  };
}

const TABLE = /FROM "((?:[^"]|"")+)"/;

/**
 * An in-memory `/api/db`: it answers the Database tab's own page, count and row
 * queries from `data.rows` (no real SQL), so component tests can drive every state.
 */
export function fakeDbClient(data: FakeDbData = fakeDbData()) {
  let saves = 0;
  const answer = (sql: string, params: unknown[] = []): QueryResult => {
    const name = TABLE.exec(sql)?.[1]?.replaceAll('""', '"') ?? '';
    const table = data.tables.find((t) => t.name === name);
    if (table === undefined) throw new DbApiError('sql-error', `no such table: ${name}`);
    let rows = data.rows[name] ?? [];
    const columns = table.columns.map((c) => c.name);
    const is = /WHERE "((?:[^"]|"")+)" IS \?/.exec(sql);
    if (is !== null) {
      const at = columns.indexOf(is[1] ?? '');
      rows = rows.filter((r) => r[at] === params[0]);
    }
    if (sql.startsWith('SELECT count(*)')) {
      return { columns: ['count(*)'], rows: [[rows.length]], truncated: false, durationMs: 1 };
    }
    if (sql.startsWith('SELECT 1 ')) {
      return {
        columns: ['1'],
        rows: rows.slice(0, 1).map(() => [1]),
        truncated: false,
        durationMs: 1,
      };
    }
    return { columns, rows, truncated: false, durationMs: 1 };
  };
  const client = {
    list: vi.fn<DbClient['list']>(() => Promise.resolve(data.list)),
    schema: vi.fn<DbClient['schema']>((db) =>
      Promise.resolve({
        db,
        tables: data.tables.map((t) => ({ ...t, rowCount: data.rows[t.name]?.length ?? 0 })),
      }),
    ),
    query: vi.fn<DbClient['query']>((input) => {
      try {
        return Promise.resolve(answer(input.sql, input.params));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }),
    snapshot: vi.fn<DbClient['snapshot']>(() =>
      Promise.resolve({ id: 'snap-1', takenAt: new Date(2026, 9, 17, 14, 2).getTime() }),
    ),
    diff: vi.fn<DbClient['diff']>((db) =>
      Promise.resolve({
        db,
        snapshotId: 'snap-1',
        takenAt: 0,
        tables: [],
        truncated: false,
        tablesOmitted: 0,
      }),
    ),
    refresh: vi.fn<DbClient['refresh']>(() => Promise.resolve()),
    requestEdit: vi.fn<DbClient['requestEdit']>((input) =>
      Promise.resolve({
        requestId: 'r'.repeat(32),
        db: input.db,
        sql: input.sql,
        params: input.params,
        tables: ['orders'],
        expiresAt: Date.now() + 60_000,
      }),
    ),
    confirmEdit: vi.fn<DbClient['confirmEdit']>(() => Promise.resolve({ changes: 1 })),
    cancelEdit: vi.fn<DbClient['cancelEdit']>(() => Promise.resolve()),
    chooseDevice: vi.fn<DbClient['chooseDevice']>(() => Promise.resolve(data.list)),
    savedQueries: vi.fn<DbClient['savedQueries']>(() =>
      Promise.resolve({ queries: data.saved, revision: data.revision }),
    ),
    saveQueries: vi.fn<DbClient['saveQueries']>((queries, revision) => {
      if (revision !== data.revision) {
        return Promise.reject(new DbApiError('conflict', 'The saved queries changed.'));
      }
      data.saved = queries;
      saves++;
      data.revision = saves.toString(16).padStart(64, '0');
      return Promise.resolve({ queries, revision: data.revision });
    }),
  } satisfies DbClient;
  return client;
}

export type FakeDbClient = ReturnType<typeof fakeDbClient>;

/** No databases at all: what the M2 tests see on the Database tab. */
export function emptyDbClient(): FakeDbClient {
  return fakeDbClient(
    fakeDbData({ list: { databases: [], sources: [], writesAllowed: false }, tables: [] }),
  );
}
