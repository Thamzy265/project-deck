import type {
  DbInfo,
  DbInspector,
  KeyedRows,
  QueryResult,
  RowHashes,
  RowKey,
  TableInfo,
} from '@project-deck/core';
import { DEFAULT_QUERY_LIMIT, DbError } from '@project-deck/core';
import { MAX_SNAPSHOT_BYTES, copyDatabase } from './copy.js';
import { SnapshotEngine } from './engine.js';
import type { SnapshotSource } from './source.js';
import { isSnapshotName } from './source.js';

export interface SnapshotInspectorOptions {
  /** Makes the engine for one copy; tests pass one with the built worker. */
  engine?: () => SnapshotEngine;
  now?: () => number;
  maxBytes?: number;
}

interface Copy {
  engine: SnapshotEngine;
  takenAt: number;
  schema: Promise<{ tables: TableInfo[]; sqlSchema: string[] }> | undefined;
  sqlSchema: Promise<string[]> | undefined;
}

/**
 * The snapshot backend: a copy of the app's database file, read-only in sqlite-wasm in
 * a worker. `live: false`, so the dashboard shows "Snapshot from 14:02 · Refresh".
 * Copies stay in memory only and are dropped by refresh() and close() (design note,
 * Privacy). There is no execute: snapshots are read-only.
 */
export class SqliteSnapshotInspector implements DbInspector {
  readonly id = 'sqlite-file';
  readonly live = false;
  readonly writable = false;
  private source: Promise<SnapshotSource> | undefined;
  private readonly copies = new Map<string, Promise<Copy>>();
  /** The copy each database is waiting for; refresh and close move on from it. */
  private readonly turns = new Map<string, object>();
  /** When the current copy of each database was taken, once it is ready. */
  private readonly taken = new Map<string, number>();
  private readonly makeEngine: () => SnapshotEngine;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private closed = false;

  constructor(
    private readonly resolve: () => Promise<SnapshotSource>,
    opts: SnapshotInspectorOptions = {},
  ) {
    this.makeEngine = opts.engine ?? (() => new SnapshotEngine());
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? MAX_SNAPSHOT_BYTES;
  }

  async listDatabases(): Promise<DbInfo[]> {
    const names = await (await this.src()).list();
    // Only finished copies are dated; a copy still being taken is never waited for (R10).
    return names.map((name) => {
      const takenAt = this.taken.get(name);
      return { name, backend: 'snapshot' as const, ...(takenAt === undefined ? {} : { takenAt }) };
    });
  }

  async schema(db: string): Promise<TableInfo[]> {
    return (await this.schemaOf(db)).tables;
  }

  async schemaSql(db: string): Promise<string[]> {
    return this.use(db, async (copy) => [
      ...(await cached(copy, 'sqlSchema', () => copy.engine.sqlSchema())),
    ]);
  }

  async query(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number } = {},
  ): Promise<QueryResult> {
    return this.use(db, (copy) =>
      copy.engine.query(sql, params, opts.limit ?? DEFAULT_QUERY_LIMIT),
    );
  }

  /** A diff compares with now, so this always takes a fresh copy first. */
  async rowHashes(db: string): Promise<RowHashes> {
    await this.refresh(db);
    return this.use(db, async (copy) => ({
      ...(await copy.engine.hashes()),
      takenAt: copy.takenAt,
    }));
  }

  async rowsByKey(db: string, table: string, keys: RowKey[]): Promise<KeyedRows> {
    return this.use(db, (copy) => copy.engine.rowsByKey(table, keys));
  }

  async refresh(db: string): Promise<void> {
    const pending = this.copies.get(db);
    this.copies.delete(db);
    this.turns.delete(db);
    this.taken.delete(db);
    const copy = await pending?.catch(() => undefined);
    await copy?.engine.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const copies = [...this.copies.values()];
    this.copies.clear();
    this.turns.clear();
    this.taken.clear();
    await Promise.all(
      copies.map(async (c) => {
        const copy = await c.catch(() => undefined);
        await copy?.engine.close();
      }),
    );
  }

  private src(): Promise<SnapshotSource> {
    if (this.closed) return Promise.reject(gone());
    const pending = (this.source ??= this.resolve());
    // A failed lookup (no device yet, adb missing) is tried again next time.
    pending.catch(() => {
      if (this.source === pending) this.source = undefined;
    });
    return pending;
  }

  private schemaOf(db: string): Promise<{ tables: TableInfo[]; sqlSchema: string[] }> {
    return this.use(db, (copy) => cached(copy, 'schema', () => copy.engine.schema()));
  }

  /**
   * Runs `fn` on the current copy. When Refresh (or another diff) replaces that copy
   * while `fn` waits or runs, it runs again on the new one (R3): only close() answers
   * app-gone.
   */
  private async use<T>(db: string, fn: (copy: Copy) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const pending = this.copy(db);
      try {
        return await fn(await pending);
      } catch (err) {
        const superseded = this.copies.get(db) !== pending;
        if (this.closed || !superseded || attempt >= MAX_RETRIES) {
          throw err instanceof Superseded ? gone() : err;
        }
      }
    }
  }

  /** The current copy of `db`, taking one when there is none. One copy at a time per db. */
  private copy(db: string): Promise<Copy> {
    if (this.closed) return Promise.reject(gone());
    if (!isSnapshotName(db))
      return Promise.reject(new DbError('not-found', `No database named ${db}.`));
    let pending = this.copies.get(db);
    if (pending === undefined) {
      const turn = {};
      this.turns.set(db, turn);
      pending = (async () => {
        const image = await copyDatabase(await this.src(), db, this.maxBytes);
        // Closed or refreshed while copying: drop the bytes, start no engine.
        if (this.closed) throw gone();
        if (this.turns.get(db) !== turn) throw new Superseded();
        const engine = this.makeEngine();
        engine.load(image);
        const takenAt = this.now();
        this.taken.set(db, takenAt);
        return { engine, takenAt, schema: undefined, sqlSchema: undefined };
      })();
      this.copies.set(db, pending);
      const mine = pending;
      mine.catch(() => {
        if (this.copies.get(db) === mine) this.copies.delete(db);
      });
    }
    return pending;
  }
}

/** The copy's cached read, made once; a failed read is dropped so the next call retries (R6). */
function cached<K extends 'schema' | 'sqlSchema'>(
  copy: Copy,
  key: K,
  read: () => NonNullable<Copy[K]>,
): NonNullable<Copy[K]> {
  const existing = copy[key];
  if (existing !== undefined) return existing;
  const pending = read();
  copy[key] = pending;
  (pending as Promise<unknown>).catch(() => {
    if (copy[key] === pending) copy[key] = undefined;
  });
  return pending;
}

/** Copies one call may go through when each is replaced by a newer one. */
const MAX_RETRIES = 3;

/** This copy was replaced before it was ready; callers move to the new one. */
class Superseded extends Error {}

function gone(): DbError {
  return new DbError('app-gone', 'The app was detached, so its snapshots were dropped.');
}
