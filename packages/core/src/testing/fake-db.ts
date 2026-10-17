import type {
  Cell,
  DbExecuteOptions,
  DbInfo,
  DbInspector,
  KeyedRows,
  QueryResult,
  RowHashes,
  RowKey,
  TableInfo,
} from '../db.js';
import { DEFAULT_QUERY_LIMIT, DbError } from '../db.js';
import { rowKeyId } from '../db-diff.js';

export interface FakeTable {
  info: Omit<TableInfo, 'rowCount'>;
  rows: Cell[][];
  /** Further schema SQL after the table's own, such as its indexes and triggers. */
  extraSql?: string[];
}

export type FakeQueryHandler = (
  db: string,
  sql: string,
  params: unknown[],
) => { columns: string[]; rows: Cell[][] } | undefined;

export interface FakeDbInspectorOptions {
  /** Adds `execute`, which records edits made with a confirm token. */
  writable?: boolean;
  id?: string;
  live?: boolean;
  /** What `execute` reports; 0 stands for an edit whose row changed meanwhile. */
  changes?: number;
}

const SELECT_ALL = /^\s*select\s+\*\s+from\s+["`]?(\w+)["`]?\s*;?\s*$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A stable 64-bit hex hash of a cell with its type, enough for fake diffs. */
function fakeHash(cell: Cell): string {
  const text = `${typeof cell}:${JSON.stringify(cell)}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * In-memory inspector. Understands `SELECT * FROM <table>` out of the box;
 * anything else goes to the optional handler or fails. Rows are keyed by the
 * table's primary key columns (or their position when it has none).
 */
export class FakeDbInspector implements DbInspector {
  readonly id: string;
  readonly live: boolean;
  readonly writable: boolean;
  readonly execute?: (
    db: string,
    sql: string,
    params?: unknown[],
    opts?: DbExecuteOptions,
  ) => Promise<{ changes: number }>;
  /** Edits run through `execute`, in order. */
  readonly executed: { db: string; sql: string; params: unknown[]; token: string }[] = [];
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(
    private readonly databases: Record<string, FakeTable[]>,
    private readonly handler?: FakeQueryHandler,
    opts: FakeDbInspectorOptions = {},
  ) {
    this.id = opts.id ?? 'fake';
    this.live = opts.live ?? true;
    this.writable = opts.writable ?? false;
    if (this.writable) {
      this.execute = async (db, sql, params = [], execOpts = {}) => {
        await this.tables(db);
        const token = execOpts.token;
        if (token === undefined || !TOKEN.test(token)) {
          throw new DbError('bad-token', 'Changes need a confirm in the dashboard');
        }
        this.executed.push({ db, sql, params, token });
        return { changes: opts.changes ?? 1 };
      };
    }
  }

  listDatabases(): Promise<DbInfo[]> {
    const backend = this.live ? ('live' as const) : ('snapshot' as const);
    return Promise.resolve(Object.keys(this.databases).map((name) => ({ name, backend })));
  }

  async schema(db: string): Promise<TableInfo[]> {
    const tables = await this.tables(db);
    return tables.map((t) => ({ ...t.info, rowCount: t.rows.length }));
  }

  async query(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number } = {},
  ): Promise<QueryResult> {
    const tables = await this.tables(db);
    const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
    let result = this.handler?.(db, sql, params);
    if (result === undefined) {
      const name = SELECT_ALL.exec(sql)?.[1];
      const table = tables.find((t) => t.info.name === name);
      if (table === undefined) throw new Error(`FakeDbInspector can't run: ${sql}`);
      result = { columns: table.info.columns.map((c) => c.name), rows: table.rows };
    }
    return {
      columns: result.columns,
      rows: result.rows.slice(0, limit),
      truncated: result.rows.length > limit,
      durationMs: 1,
    };
  }

  async schemaSql(db: string): Promise<string[]> {
    const tables = await this.tables(db);
    return tables.flatMap((t) => [
      ...(t.info.sql === undefined ? [] : [t.info.sql]),
      ...(t.extraSql ?? []),
    ]);
  }

  watch(db: string, table: string, cb: () => void): () => void {
    const key = `${db}/${table}`;
    let set = this.watchers.get(key);
    if (set === undefined) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  async rowHashes(db: string): Promise<RowHashes> {
    const tables = (await this.tables(db)).filter((t) => t.info.kind === 'table');
    return {
      takenAt: Date.now(),
      tables: tables.map((t) => {
        const { key, keyOf } = this.keyOf(t);
        return {
          name: t.info.name,
          columns: t.info.columns.map((c) => c.name),
          key,
          rows: t.rows.map((row, i) => [keyOf(row, i), row.map(fakeHash)] as [RowKey, string[]]),
        };
      }),
    };
  }

  async rowsByKey(db: string, table: string, keys: RowKey[]): Promise<KeyedRows> {
    const t = (await this.tables(db)).find((x) => x.info.name === table);
    if (t === undefined) throw new DbError('not-found', `No table named ${table}`);
    const { key, keyOf } = this.keyOf(t);
    const byKey = new Map(t.rows.map((row, i) => [rowKeyId(keyOf(row, i)), row]));
    const rows: [RowKey, Cell[]][] = [];
    const missing: RowKey[] = [];
    for (const k of keys) {
      const row = byKey.get(rowKeyId(k));
      if (row === undefined) missing.push(k);
      else rows.push([k, row]);
    }
    return { columns: t.info.columns.map((c) => c.name), key, rows, missing, truncated: false };
  }

  /** Appends a row and notifies watchers, like the app inserting data. */
  async insert(db: string, table: string, row: Cell[]): Promise<void> {
    const t = await this.table(db, table);
    t.rows.push(row);
    this.notify(db, table);
  }

  /** Replaces the row at `index` and notifies watchers. */
  async update(db: string, table: string, index: number, row: Cell[]): Promise<void> {
    const t = await this.table(db, table);
    if (index < 0 || index >= t.rows.length) throw new Error(`No row ${index} in '${table}'`);
    t.rows[index] = row;
    this.notify(db, table);
  }

  private notify(db: string, table: string): void {
    for (const cb of this.watchers.get(`${db}/${table}`) ?? []) cb();
  }

  private keyOf(t: FakeTable): { key: string[]; keyOf: (row: Cell[], i: number) => RowKey } {
    const pk = t.info.columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.pk)
      .sort((a, b) => (a.c.pkPosition ?? 0) - (b.c.pkPosition ?? 0));
    if (pk.length === 0) return { key: ['rowid'], keyOf: (_row, i) => i + 1 };
    return {
      key: pk.map(({ c }) => c.name),
      keyOf: (row) => {
        const values = pk.map(({ i }) => row[i] ?? null);
        return values.length === 1 ? (values[0] ?? null) : values;
      },
    };
  }

  private async table(db: string, table: string): Promise<FakeTable> {
    const t = (await this.tables(db)).find((x) => x.info.name === table);
    if (t === undefined) throw new Error(`No table '${table}' in '${db}'`);
    return t;
  }

  private tables(db: string): Promise<FakeTable[]> {
    const tables = this.databases[db];
    if (tables === undefined) return Promise.reject(new Error(`No database named '${db}'`));
    return Promise.resolve(tables);
  }
}
