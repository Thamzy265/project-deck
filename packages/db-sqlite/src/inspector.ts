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
    return Promise.all(
      names.map(async (name) => {
        const copy = await this.copies.get(name)?.catch(() => undefined);
        return {
          name,
          backend: 'snapshot' as const,
          ...(copy === undefined ? {} : { takenAt: copy.takenAt }),
        };
      }),
    );
  }

  async schema(db: string): Promise<TableInfo[]> {
    return (await this.schemaOf(db)).tables;
  }

  async schemaSql(db: string): Promise<string[]> {
    return [...(await this.schemaOf(db)).sqlSchema];
  }

  async query(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number } = {},
  ): Promise<QueryResult> {
    const copy = await this.copy(db);
    return copy.engine.query(sql, params, opts.limit ?? DEFAULT_QUERY_LIMIT);
  }

  /** A diff compares with now, so this always takes a fresh copy first. */
  async rowHashes(db: string): Promise<RowHashes> {
    await this.refresh(db);
    const copy = await this.copy(db);
    return { ...(await copy.engine.hashes()), takenAt: copy.takenAt };
  }

  async rowsByKey(db: string, table: string, keys: RowKey[]): Promise<KeyedRows> {
    return (await this.copy(db)).engine.rowsByKey(table, keys);
  }

  async refresh(db: string): Promise<void> {
    const pending = this.copies.get(db);
    this.copies.delete(db);
    this.turns.delete(db);
    const copy = await pending?.catch(() => undefined);
    await copy?.engine.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const copies = [...this.copies.values()];
    this.copies.clear();
    this.turns.clear();
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
    return this.copy(db).then((copy) => (copy.schema ??= copy.engine.schema()));
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
        if (this.closed || this.turns.get(db) !== turn) throw gone();
        const engine = this.makeEngine();
        engine.load(image);
        return { engine, takenAt: this.now(), schema: undefined };
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

function gone(): DbError {
  return new DbError('app-gone', 'The app was detached, so its snapshots were dropped.');
}
