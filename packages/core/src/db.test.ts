import { describe, expect, it } from 'vitest';
import {
  DbDiffInput,
  DbDiffResponse,
  DbEditConfirmInput,
  DbEditRequestResponse,
  DbExecuteInput,
  DbExecuteResponse,
  DbListInput,
  DbListResponse,
  DbQueryInput,
  DbSchemaInput,
  DbSchemaResponse,
  DbSnapshotInput,
  DbSnapshotResponse,
  McpDbQueryInput,
  WsMessageSchema,
  makeDbQueryInput,
} from './api.js';
import {
  CellSchema,
  DASHBOARD_MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
  DbInfoSchema,
  MAX_SQL_LENGTH,
  MCP_MAX_QUERY_LIMIT,
  QueryResultSchema,
  TableInfoSchema,
} from './db.js';

const orders = {
  name: 'orders',
  kind: 'table',
  sql: "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer INTEGER REFERENCES customers(id), status TEXT NOT NULL DEFAULT 'pending')",
  columns: [
    { name: 'id', type: 'INTEGER', nullable: true, pk: true, pkPosition: 1, default: null },
    { name: 'customer', type: 'INTEGER', nullable: true, pk: false, default: null },
    { name: 'status', type: 'TEXT', nullable: false, pk: false, default: "'pending'" },
  ],
  foreignKeys: [{ from: 'customer', table: 'customers', to: 'id' }],
  indexes: [{ name: 'orders_status', columns: ['status'], unique: false }],
  rowCount: 2,
};

describe('database shapes', () => {
  it('describe a table with columns, defaults, keys and indexes', () => {
    expect(TableInfoSchema.parse(orders)).toEqual(orders);
  });

  it('describe a view, and a foreign key to the implicit primary key', () => {
    const view = {
      name: 'pending',
      kind: 'view',
      columns: [{ name: 'id', type: '', nullable: true, pk: false, default: null }],
      foreignKeys: [{ from: 'customer', table: 'customers', to: null }],
      indexes: [],
    };
    expect(TableInfoSchema.parse(view)).toEqual(view);
    expect(TableInfoSchema.safeParse({ ...view, kind: 'trigger' }).success).toBe(false);
  });

  it('carry an error for a table the backend could only partly read', () => {
    const unusable = {
      name: 'coffee',
      kind: 'view',
      columns: [],
      foreignKeys: [],
      indexes: [],
      error: {
        code: 'unsupported',
        message: "FlutterDeck can't read coffee: no such function: REGEXP",
      },
    };
    expect(TableInfoSchema.parse(unusable)).toEqual(unusable);
    const uncounted = {
      ...orders,
      rowCount: undefined,
      error: { code: 'timeout', message: 'Rows not counted' },
    };
    expect(TableInfoSchema.parse(uncounted).error).toEqual(uncounted.error);
    expect(TableInfoSchema.safeParse({ ...orders, error: { code: 'x' } }).success).toBe(false);
    expect(TableInfoSchema.safeParse({ ...orders, error: 'broken' }).success).toBe(false);
  });

  it('say whether a database is live or a snapshot, with the time it was taken', () => {
    expect(DbInfoSchema.parse({ name: 'app', backend: 'live' })).toEqual({
      name: 'app',
      backend: 'live',
    });
    expect(
      DbInfoSchema.parse({ name: 'app.sqlite', backend: 'snapshot', takenAt: 1_760_000_000_000 }),
    ).toMatchObject({ takenAt: 1_760_000_000_000 });
    expect(DbInfoSchema.safeParse({ name: 'app', backend: 'file' }).success).toBe(false);
  });

  it('type every cell: null, numbers, text, big integers as text, blobs with a size', () => {
    const cells = [
      null,
      42,
      1.5,
      'pending',
      { type: 'int', value: '9007199254740993' },
      { type: 'blob', bytes: 3, base64: 'AQID' },
      { type: 'blob', bytes: 1_000_000, base64: 'AQID', truncated: true },
    ];
    for (const cell of cells) expect(CellSchema.parse(cell)).toEqual(cell);
    for (const bad of [
      { type: 'int', value: '1.5' },
      { type: 'blob', bytes: -1 },
      [1],
      { nested: true },
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(CellSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('carry non-finite doubles as text, the form flutterdeck_drift sends', () => {
    for (const value of ['Infinity', '-Infinity', 'NaN']) {
      const cell = { type: 'real', value };
      expect(CellSchema.parse(cell)).toEqual(cell);
    }
    for (const bad of [
      { type: 'real', value: '1.5' },
      { type: 'real', value: 'infinity' },
      { type: 'real', value: Number.NaN },
    ]) {
      expect(CellSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('carry truncation and duration on a query result', () => {
    const result = { columns: ['n'], rows: [[3]], truncated: false, durationMs: 4 };
    expect(QueryResultSchema.parse(result)).toEqual(result);
    expect(QueryResultSchema.safeParse({ ...result, rows: [[{ x: 1 }]] }).success).toBe(false);
  });
});

describe('database API inputs', () => {
  it('cap the query limit at 1,000 for the dashboard and 500 for Claude', () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(100);
    expect(DASHBOARD_MAX_QUERY_LIMIT).toBe(1000);
    expect(MCP_MAX_QUERY_LIMIT).toBe(500);
    const base = { db: 'app', sql: 'select 1' };
    expect(DbQueryInput.safeParse({ ...base, limit: 1000 }).success).toBe(true);
    expect(DbQueryInput.safeParse({ ...base, limit: 1001 }).success).toBe(false);
    expect(McpDbQueryInput.safeParse({ ...base, limit: 500 }).success).toBe(true);
    expect(McpDbQueryInput.safeParse({ ...base, limit: 501 }).success).toBe(false);
    expect(makeDbQueryInput(10).safeParse({ ...base, limit: 11 }).success).toBe(false);
    expect(DbQueryInput.safeParse({ ...base, limit: 0 }).success).toBe(false);
  });

  it('refuse a limit factory outside 1 to the dashboard cap', () => {
    expect(() => makeDbQueryInput(0)).toThrow();
    expect(() => makeDbQueryInput(DASHBOARD_MAX_QUERY_LIMIT + 1)).toThrow();
  });

  it('bound SQL text, database names and parameters', () => {
    expect(MAX_SQL_LENGTH).toBe(100_000);
    const sql = 'x'.repeat(MAX_SQL_LENGTH + 1);
    expect(DbQueryInput.safeParse({ db: 'app', sql }).success).toBe(false);
    expect(DbExecuteInput.safeParse({ db: 'app', sql }).success).toBe(false);
    expect(DbSchemaInput.safeParse({ db: 'x'.repeat(129) }).success).toBe(false);
    expect(
      DbExecuteInput.safeParse({ db: 'app', sql: 'delete from t', params: [{}] }).success,
    ).toBe(false);
  });

  it('accept db_list with no arguments', () => {
    expect(DbListInput.parse({})).toEqual({});
  });

  it('take an optional label on db_snapshot and an optional snapshot on db_diff', () => {
    expect(DbSnapshotInput.parse({ db: 'app', label: 'before' })).toEqual({
      db: 'app',
      label: 'before',
    });
    expect(DbDiffInput.parse({ db: 'app' })).toEqual({ db: 'app' });
    expect(DbDiffInput.parse({ db: 'app', snapshotId: 'snap-1' }).snapshotId).toBe('snap-1');
    for (const snapshotId of ['', 'has space', 'x'.repeat(65), '../x']) {
      expect(DbDiffInput.safeParse({ db: 'app', snapshotId }).success, snapshotId).toBe(false);
    }
  });
});

describe('database API responses', () => {
  it('list databases and serve a schema', () => {
    const list = {
      databases: [{ name: 'app', backend: 'live', source: 'drift' }],
      sources: [{ id: 'drift', live: true, writable: true }],
      writesAllowed: false,
    };
    expect(DbListResponse.parse(list)).toEqual(list);
    expect(DbSchemaResponse.parse({ db: 'app', tables: [orders] }).tables).toHaveLength(1);
  });

  it('name a snapshot and report a diff per table: keys, new values and counts', () => {
    expect(
      DbSnapshotResponse.parse({ id: 'snap-1', db: 'app', takenAt: 1, label: 'before' }),
    ).toMatchObject({ id: 'snap-1' });
    const diff = {
      db: 'app',
      snapshotId: 'snap-1',
      takenAt: 1,
      tables: [
        {
          table: 'orders',
          columns: ['id', 'status'],
          key: ['id'],
          matchedByRowid: false,
          added: [{ key: 3, row: [3, 'pending'] }],
          removed: [{ key: 2 }],
          changed: [{ key: 1, row: [1, 'shipped'], columns: ['status'] }],
          counts: { added: 1, removed: 1, changed: 1 },
          truncated: false,
        },
        {
          table: 'events',
          columns: [],
          key: [],
          matchedByRowid: false,
          added: [],
          removed: [],
          changed: [],
          counts: { added: 0, removed: 0, changed: 0 },
          truncated: false,
          tooLarge: true,
          error: { code: 'too-large', message: 'Too large to compare' },
        },
      ],
    };
    expect(DbDiffResponse.parse(diff)).toEqual(diff);
    // Old values are never kept (design note D5), so a diff carries no `before` rows.
    const withBefore = structuredClone(diff);
    Object.assign(withBefore.tables[0]?.changed[0] ?? {}, { before: [1, 'pending'] });
    expect(DbDiffResponse.parse(withBefore).tables[0]?.changed[0]).not.toHaveProperty('before');
  });

  it('list databases with their sources and whether writes are on', () => {
    const list = {
      databases: [
        { name: 'app', backend: 'live', source: 'drift' },
        { name: 'app_flutter/app.sqlite', backend: 'snapshot', source: 'sqlite-file' },
      ],
      sources: [
        { id: 'drift', live: true, writable: true },
        {
          id: 'sqlite-file',
          live: false,
          writable: false,
          error: { code: 'not-debuggable', message: 'Not debuggable' },
        },
      ],
      writesAllowed: false,
    };
    expect(DbListResponse.parse(list)).toEqual(list);
  });

  it('bind an edit to a request id, then confirm it with the same SQL', () => {
    const pending = {
      requestId: 'a'.repeat(32),
      db: 'app',
      sql: 'UPDATE orders SET status = ? WHERE id = ?',
      params: ['shipped', 1],
      tables: ['orders'],
      expiresAt: 60_000,
    };
    expect(DbEditRequestResponse.parse(pending)).toEqual(pending);
    const confirm = { requestId: pending.requestId, sql: pending.sql, params: pending.params };
    expect(DbEditConfirmInput.parse(confirm)).toEqual(confirm);
    expect(DbEditConfirmInput.safeParse({ ...confirm, requestId: 'x' }).success).toBe(false);
    expect(DbExecuteResponse.parse({ changes: 1 })).toEqual({ changes: 1 });
  });

  it('carry table changes on the websocket', () => {
    const msg = { type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } };
    expect(WsMessageSchema.parse(msg)).toEqual(msg);
  });
});
