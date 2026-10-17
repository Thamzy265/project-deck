import { FakeAppExtensions } from '@project-deck/core/testing';
import { EXTENSION_PREFIX, PROTOCOL_VERSION, TABLES_EVENT } from '../protocol.js';

type Body = Record<string, unknown>;
export type FakeDriftHandler = (params: Record<string, string>) => Body;

/**
 * Reply bodies from the recorded session in
 * packages/connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json
 * (flutterdeck_drift 1, Dart 3.12.2, recorded 2026-10-16), without the envelope.
 */
export const RECORDED_SCHEMA: Body = {
  tables: [
    {
      name: 'lines',
      kind: 'table',
      sql: 'CREATE TABLE lines (order_id INTEGER, n INTEGER, PRIMARY KEY (order_id, n))',
      columns: [
        {
          name: 'order_id',
          type: 'INTEGER',
          nullable: true,
          pk: true,
          pkPosition: 1,
          default: null,
        },
        { name: 'n', type: 'INTEGER', nullable: true, pk: true, pkPosition: 2, default: null },
      ],
      rowCount: 0,
      foreignKeys: [],
      indexes: [{ name: 'sqlite_autoindex_lines_1', unique: true, columns: ['order_id', 'n'] }],
    },
    {
      name: 'orders',
      kind: 'table',
      sql: "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')",
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
        { name: 'item', type: 'TEXT', nullable: false, pk: false, default: null },
        { name: 'status', type: 'TEXT', nullable: false, pk: false, default: "'pending'" },
      ],
      rowCount: 2,
      foreignKeys: [],
      indexes: [],
    },
  ],
  sqlSchema: [
    "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')",
    'CREATE TABLE sqlite_sequence(name,seq)',
    'CREATE TABLE lines (order_id INTEGER, n INTEGER, PRIMARY KEY (order_id, n))',
  ],
};

export const RECORDED_QUERY: Body = {
  columns: ['id', 'item', 'status'],
  rows: [
    [1, 'Coffee', 'pending'],
    [2, 'Tea', 'pending'],
  ],
  truncated: false,
  durationMs: 0.597,
};

export const RECORDED_SNAPSHOT: Body = {
  takenAt: 1792176214286,
  tables: [
    { name: 'lines', columns: ['order_id', 'n'], key: ['rowid'], rowid: true, rows: [] },
    {
      name: 'orders',
      columns: ['id', 'item', 'status'],
      key: ['id'],
      rows: [
        [1, ['529a2ddc8ff5355f', '2e1d5ff04220d18e', 'b8413ec34aa45d35']],
        [2, ['529a2edc8ff53712', 'ae583b88f21d6d1c', 'b8413ec34aa45d35']],
      ],
    },
  ],
};

export const RECORDED_ROWS: Body = {
  columns: ['id', 'item', 'status'],
  key: ['id'],
  rows: [[3, [3, 'Cake', 'pending']]],
  missing: [99],
  truncated: false,
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A fake app with flutterdeck_drift registered: answers the `ext.flutterdeck.drift.v1.*`
 * extensions with recorded replies, enforces single-use write tokens like the package,
 * and posts table events. Override any method with `handle()`.
 */
export class FakeDriftApp {
  readonly extensions: FakeAppExtensions;
  readonly usedTokens = new Set<string>();
  readonly executed: { db: string; sql: string; params: string | undefined }[] = [];
  private readonly handlers = new Map<string, FakeDriftHandler>();

  constructor(
    readonly databases: string[] = ['app'],
    extensions: FakeAppExtensions = new FakeAppExtensions(),
  ) {
    this.extensions = extensions;
    const known = (params: Record<string, string>): Body | undefined =>
      this.databases.includes(params.db ?? '')
        ? undefined
        : { error: { code: 'unknown-db', message: `No database named ${params.db ?? 'null'}` } };
    this.handle('list', () => ({ databases: this.databases.map((name) => ({ name })) }));
    this.handle('schema', (p) => known(p) ?? RECORDED_SCHEMA);
    this.handle('query', (p) => known(p) ?? RECORDED_QUERY);
    this.handle('snapshot', (p) => known(p) ?? RECORDED_SNAPSHOT);
    this.handle('rows', (p) => known(p) ?? RECORDED_ROWS);
    this.handle('execute', (p) => {
      const token = p.token;
      if (token === undefined || !TOKEN.test(token)) {
        return { error: { code: 'bad-token', message: 'Changes need a confirm in the dashboard' } };
      }
      if (this.usedTokens.has(token)) {
        return { error: { code: 'bad-token', message: 'This confirm was already used' } };
      }
      const unknown = known(p);
      if (unknown !== undefined) return unknown;
      this.usedTokens.add(token);
      this.executed.push({ db: p.db ?? '', sql: p.sql ?? '', params: p.params });
      return { changes: 1 };
    });
  }

  /** Answers one action (`list`, `schema`, `query`, …) with the given body. */
  handle(action: string, handler: FakeDriftHandler): this {
    this.handlers.set(action, handler);
    this.extensions.handle(`${EXTENSION_PREFIX}${action}`, (params) => ({
      protocol: PROTOCOL_VERSION,
      ...(this.handlers.get(action)?.(params) ?? {}),
    }));
    return this;
  }

  /** Posts a `flutterdeck.drift.tables` event, as the package does after writes. */
  emitTables(db: string, tables: { name: string; kind?: string }[]): void {
    this.extensions.emit(TABLES_EVENT, {
      protocol: PROTOCOL_VERSION,
      db,
      tables: tables.map((t) => ({ name: t.name, kind: t.kind ?? 'insert' })),
    });
  }
}
