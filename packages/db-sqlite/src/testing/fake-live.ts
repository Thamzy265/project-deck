import type {
  DbExecuteOptions,
  DbInfo,
  DbInspector,
  DbQueryOptions,
  KeyedRows,
  QueryResult,
  RowHashes,
  RowKey,
  TableInfo,
} from '@project-deck/core';
import { DbError } from '@project-deck/core';
import type { SnapshotEngine } from '../engine.js';
import { SqliteSnapshotInspector } from '../inspector.js';
import { bind } from '../ops.js';
import type { Sqlite3 } from '../sqlite.js';
import { loadSqlite } from '../sqlite.js';
import { FakeSnapshotSource } from './fake-source.js';

type Db = InstanceType<Sqlite3['oo1']['DB']>;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface FakeLiveOptions {
  /** Test seam: the snapshot engine that reads the copies (the built worker in tests). */
  engine?: () => SnapshotEngine;
  id?: string;
}

/**
 * A live, writable database for the daemon's fake mode and the dashboard's end-to-end
 * tests: a real SQLite database in memory, so paging, sorting, filters, the SQL editor
 * and confirmed edits all run real SQL. Writes go to the in-memory database; reads go
 * through the snapshot backend's engine over a fresh copy after every write, so they
 * keep that engine's read-only checks and limits. Never used with a real app.
 */
export class FakeLiveDatabase implements DbInspector {
  readonly id: string;
  readonly live = true;
  readonly writable = true;
  private readonly reader: SqliteSnapshotInspector;
  private readonly source: FakeSnapshotSource;
  private readonly file: string;
  private readonly watchers = new Map<string, Set<() => void>>();
  private closed = false;

  private constructor(
    private readonly sqlite: Sqlite3,
    private readonly db: Db,
    private readonly name: string,
    opts: FakeLiveOptions,
  ) {
    this.id = opts.id ?? 'fake';
    // The reader serves fixed folder names only; the copy lives under one of them.
    this.file = 'app_flutter/fake-live.sqlite';
    this.source = new FakeSnapshotSource({ [this.file]: this.image() });
    this.reader = new SqliteSnapshotInspector(
      () => Promise.resolve(this.source),
      opts.engine === undefined ? {} : { engine: opts.engine },
    );
  }

  /** A database named `name`, made by running `setup` statements in order. */
  static async create(
    name: string,
    setup: readonly string[],
    opts: FakeLiveOptions = {},
  ): Promise<FakeLiveDatabase> {
    const sqlite = await loadSqlite();
    const db = new sqlite.oo1.DB();
    for (const sql of setup) db.exec(sql);
    return new FakeLiveDatabase(sqlite, db, name, opts);
  }

  listDatabases(): Promise<DbInfo[]> {
    return Promise.resolve([{ name: this.name, backend: 'live' }]);
  }

  async schema(db: string): Promise<TableInfo[]> {
    return this.reader.schema(this.mine(db));
  }

  async schemaSql(db: string): Promise<string[]> {
    return this.reader.schemaSql(this.mine(db));
  }

  async query(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: DbQueryOptions = {},
  ): Promise<QueryResult> {
    return this.reader.query(this.mine(db), sql, params, opts);
  }

  async rowHashes(db: string): Promise<RowHashes> {
    return this.reader.rowHashes(this.mine(db));
  }

  async rowsByKey(db: string, table: string, keys: RowKey[]): Promise<KeyedRows> {
    return this.reader.rowsByKey(this.mine(db), table, keys);
  }

  async execute(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: DbExecuteOptions = {},
  ): Promise<{ changes: number }> {
    this.mine(db);
    if (opts.token === undefined || !TOKEN.test(opts.token)) {
      throw new DbError('bad-token', 'Changes need a confirm in the dashboard');
    }
    return this.run(sql, params);
  }

  /** Runs one statement like the app would (no token), then announces the change. */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    if (this.closed) throw new DbError('app-gone', 'The app stopped.');
    const { capi } = this.sqlite;
    const pointer = this.db.pointer ?? 0;
    let stmt;
    try {
      stmt = this.db.prepare(sql);
    } catch {
      throw new DbError('sql-error', capi.sqlite3_errmsg(pointer).slice(0, 500));
    }
    try {
      params.forEach((p, i) =>
        bind({ sqlite: this.sqlite, db: this.db }, stmt.pointer ?? 0, i + 1, p),
      );
      stmt.step();
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw new DbError('sql-error', capi.sqlite3_errmsg(pointer).slice(0, 500));
    } finally {
      stmt.finalize();
    }
    const changes = capi.sqlite3_changes(pointer);
    this.source.files[this.file] = this.image();
    await this.reader.refresh(this.file);
    // Every table of the database: views re-query, as after a real app's write.
    for (const set of this.watchers.values()) for (const cb of [...set]) cb();
    return { changes };
  }

  watch(db: string, table: string, cb: () => void): () => void {
    this.mine(db);
    let set = this.watchers.get(table);
    if (set === undefined) {
      set = new Set();
      this.watchers.set(table, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watchers.clear();
    await this.reader.close();
    this.db.close();
  }

  private mine(db: string): string {
    if (db !== this.name) throw new DbError('not-found', `No database named ${db}.`);
    return this.file;
  }

  private image(): Buffer {
    return Buffer.from(this.sqlite.capi.sqlite3_js_db_export(this.db.pointer ?? 0));
  }
}
