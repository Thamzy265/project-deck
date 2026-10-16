import type { Cell, DbInfo, DbInspector, QueryResult, TableInfo } from '../db.js';
import { DEFAULT_QUERY_LIMIT } from '../db.js';

export interface FakeTable {
  info: Omit<TableInfo, 'rowCount'>;
  rows: Cell[][];
}

export type FakeQueryHandler = (
  db: string,
  sql: string,
  params: unknown[],
) => { columns: string[]; rows: Cell[][] } | undefined;

const SELECT_ALL = /^\s*select\s+\*\s+from\s+["`]?(\w+)["`]?\s*;?\s*$/i;

/**
 * In-memory inspector. Understands `SELECT * FROM <table>` out of the box;
 * anything else goes to the optional handler or fails.
 */
export class FakeDbInspector implements DbInspector {
  readonly id = 'fake';
  readonly live = true;
  readonly writable = false;
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(
    private readonly databases: Record<string, FakeTable[]>,
    private readonly handler?: FakeQueryHandler,
  ) {}

  listDatabases(): Promise<DbInfo[]> {
    return Promise.resolve(
      Object.keys(this.databases).map((name) => ({ name, backend: 'live' as const })),
    );
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

  /** Appends a row and notifies watchers, like the app inserting data. */
  async insert(db: string, table: string, row: Cell[]): Promise<void> {
    const t = (await this.tables(db)).find((x) => x.info.name === table);
    if (t === undefined) throw new Error(`No table '${table}' in '${db}'`);
    t.rows.push(row);
    for (const cb of this.watchers.get(`${db}/${table}`) ?? []) cb();
  }

  private tables(db: string): Promise<FakeTable[]> {
    const tables = this.databases[db];
    if (tables === undefined) return Promise.reject(new Error(`No database named '${db}'`));
    return Promise.resolve(tables);
  }
}
