/**
 * The daemon's database layer for the attached app: picks the backends from the
 * Registry, runs every statement through the read-only gate before any backend sees it
 * (ADR 0005), keeps diff snapshots in memory, and runs the dashboard's confirmed edits
 * with a fresh single-use token each (design review S1).
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  AppSession,
  DbDiff,
  DbEditRequest,
  DbInspector,
  DbList,
  DbSchema,
  DbSource,
  EventBus,
  QueryResult,
  Registry,
  RowHashes,
  RunningApp,
  TableInfo,
} from '@project-deck/core';
import { DB_UNTRUSTED_TEXT, DbError, isDbError, parseHiddenColumn } from '@project-deck/core';
import type { GuardCheckOptions, GuardResult, SqlGuard } from '@project-deck/sql-guard';
import type { TableVisibility } from './db-diff.js';
import { CLAUDE_DIFF_CAPS, DASHBOARD_DIFF_CAPS, buildDiff } from './db-diff.js';

/**
 * Who asks. Token callers (the MCP server, the CLI) count as Claude: hidden columns
 * apply and caps are Claude's. Only the dashboard (cookie) sees full rows and edits.
 */
export type DbCaller = 'claude' | 'dashboard';

export interface DbSettings {
  allowWrites: boolean;
  /** `table.column` entries from config.json. */
  hiddenColumns: readonly string[];
}

export interface DbServiceOptions {
  registry: Registry;
  bus: EventBus;
  guard: SqlGuard;
  settings: DbSettings;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

/** Privacy table in the design note: at most 20 snapshots, oldest dropped. */
export const MAX_SNAPSHOTS = 20;
/** An unanswered confirm dialog expires (UI spec: "Not run: no answer in 60 s"). */
export const EDIT_TTL_MS = 60_000;
const MAX_PENDING_EDITS = 10;

interface Source {
  inspector: DbInspector;
}

interface Snapshot {
  id: string;
  db: string;
  source: string;
  takenAt: number;
  label?: string;
  hashes: RowHashes;
}

interface PendingEdit {
  db: string;
  source: Source;
  sql: string;
  params: unknown[];
  hash: string;
  expiresAt: number;
  epoch: number;
}

interface Attached {
  app: RunningApp;
  sources: Source[];
  /** db name → source, from the last listing. */
  byName: Map<string, Source>;
  schemaSql: Map<string, Promise<string[]>>;
  watches: Map<string, () => void>;
  /** Bumped by every hot restart: edits requested before it are refused. */
  epoch: number;
}

const noApp = (): DbError =>
  new DbError(
    'app-gone',
    'No app is attached. Start one from your IDE or flutter run, then pick it.',
  );

/** A name in double quotes, safe in SQL whatever it holds. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function editHash(db: string, sql: string, params: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([db, sql, params]))
    .digest('hex');
}

/** A backend error as a DbError; anything else may quote SQL or rows, so it is hidden. */
function asDbError(err: unknown): DbError {
  return isDbError(err) ? err : new DbError('internal', 'The database call failed.');
}

export class DbService {
  private attached: Attached | undefined;
  private snapshots: Snapshot[] = [];
  private readonly pending = new Map<string, PendingEdit>();
  /** The gate's per-table visibility for Claude, per schema SQL array (R1). */
  private readonly visibilityCache = new WeakMap<readonly string[], Map<string, TableVisibility>>();
  private readonly now: () => number;
  private readonly offBus: () => void;
  private closed = false;

  constructor(private readonly opts: DbServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.offBus = opts.bus.on('app.reloaded', ({ appId, result }) => {
      const current = this.attached;
      if (current === undefined || current.app.id !== appId) return;
      if (!result.ok || result.kind !== 'hot-restart') return;
      current.epoch++;
      current.schemaSql.clear();
    });
  }

  /** Called by the app manager on attach. The returned function runs on detach or exit. */
  async attach(app: RunningApp, session: AppSession): Promise<() => Promise<void>> {
    await this.release();
    const sources: Source[] = [];
    for (const factory of this.opts.registry.dbInspectors.list()) {
      try {
        const inspector = await factory.create(app, session);
        if (inspector !== undefined) sources.push({ inspector });
      } catch (err) {
        this.opts.log?.(`Database backend '${factory.id}' failed to start`, err);
      }
    }
    const attached: Attached = {
      app,
      sources,
      byName: new Map(),
      schemaSql: new Map(),
      watches: new Map(),
      epoch: 0,
    };
    this.attached = attached;
    return async () => {
      if (this.attached === attached) await this.release();
    };
  }

  async list(): Promise<DbList> {
    const current = this.current();
    const databases: DbList['databases'] = [];
    const sources: DbSource[] = [];
    const byName = new Map<string, Source>();
    // All backends at once: a slow device must not hold up a live database (R10).
    const listed = await Promise.all(
      current.sources.map((s) =>
        s.inspector.listDatabases().then(
          (infos) => ({ infos, error: undefined }),
          (err: unknown) => ({ infos: [], error: asDbError(err) }),
        ),
      ),
    );
    current.sources.forEach((source, i) => {
      const { inspector } = source;
      const { infos, error } = listed[i] ?? { infos: [], error: undefined };
      const entry: DbSource = {
        id: inspector.id,
        live: inspector.live,
        writable: inspector.writable,
        ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }),
      };
      for (const info of infos) {
        // Names are unique across sources; the first backend registered wins.
        if (byName.has(info.name)) continue;
        byName.set(info.name, source);
        databases.push({ ...info, source: inspector.id });
      }
      sources.push(entry);
    });
    if (this.attached === current) current.byName = byName;
    return { databases, sources, writesAllowed: this.opts.settings.allowWrites };
  }

  /**
   * The tables of `db`. Claude gets no CREATE text (the columns, keys and indexes say
   * the same, and it is free app text) and a note that the rest is untrusted app text.
   */
  async schema(db: string, caller: DbCaller): Promise<DbSchema> {
    const source = await this.sourceOf(db);
    let tables: TableInfo[];
    try {
      tables = await source.inspector.schema(db);
    } catch (err) {
      throw asDbError(err);
    }
    this.watchTables(source, db, tables);
    if (caller === 'dashboard') return { db, tables };
    return {
      db,
      tables: tables.map(({ sql: _sql, ...table }) => table),
      untrusted: DB_UNTRUSTED_TEXT,
    };
  }

  async query(
    input: { db: string; sql: string; params?: unknown[] | undefined; limit?: number | undefined },
    caller: DbCaller,
  ): Promise<QueryResult> {
    const source = await this.sourceOf(input.db);
    const hiddenColumns = caller === 'claude' ? this.hidden() : undefined;
    await this.check(source, input.db, input.sql, {
      mode: 'read',
      ...(hiddenColumns === undefined ? {} : { hiddenColumns }),
    });
    try {
      return await source.inspector.query(
        input.db,
        input.sql,
        input.params ?? [],
        input.limit === undefined ? {} : { limit: input.limit },
      );
    } catch (err) {
      throw asDbError(err);
    }
  }

  async snapshot(input: { db: string; label?: string | undefined }) {
    const source = await this.sourceOf(input.db);
    const hashes = await this.hashes(source, input.db);
    const snapshot: Snapshot = {
      id: `snap-${randomBytes(9).toString('base64url')}`,
      db: input.db,
      source: source.inspector.id,
      takenAt: hashes.takenAt,
      ...(input.label === undefined ? {} : { label: input.label }),
      hashes,
    };
    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    return {
      id: snapshot.id,
      db: snapshot.db,
      takenAt: snapshot.takenAt,
      ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
    };
  }

  async diff(
    input: { db: string; snapshotId?: string | undefined },
    caller: DbCaller,
  ): Promise<DbDiff> {
    const source = await this.sourceOf(input.db);
    const snapshot =
      input.snapshotId === undefined
        ? this.snapshots.findLast((s) => s.db === input.db && s.source === source.inspector.id)
        : this.snapshots.find((s) => s.id === input.snapshotId && s.db === input.db);
    if (snapshot === undefined) {
      throw new DbError('not-found', 'Take a snapshot first, then use the app.');
    }
    const now = await this.hashes(source, input.db);
    try {
      const { tables, truncated, tablesOmitted } = await buildDiff(
        source.inspector,
        input.db,
        snapshot.hashes,
        now,
        caller === 'claude' ? CLAUDE_DIFF_CAPS : DASHBOARD_DIFF_CAPS,
        caller === 'claude' ? this.hidden() : undefined,
        caller === 'claude' && this.hidden().length > 0
          ? (table, columns, key) => this.visibility(source, input.db, table, columns, key)
          : undefined,
      );
      return {
        db: input.db,
        snapshotId: snapshot.id,
        takenAt: snapshot.takenAt,
        tables,
        truncated,
        tablesOmitted,
      };
    } catch (err) {
      throw asDbError(err);
    }
  }

  async refresh(db: string): Promise<void> {
    const source = await this.sourceOf(db);
    try {
      await source.inspector.refresh?.(db);
    } catch (err) {
      throw asDbError(err);
    }
  }

  /**
   * Step 1 of an edit: checks it (writes on, a backend that can write, the gate in
   * write mode) and binds it to a server-made request id. Nothing runs yet.
   */
  async requestEdit(input: {
    db: string;
    sql: string;
    params?: unknown[] | undefined;
  }): Promise<DbEditRequest> {
    if (!this.opts.settings.allowWrites) {
      throw new DbError(
        'not-allowed',
        'Changing data is off. Turn it on with db.allowWrites in .flutterdeck/config.json.',
      );
    }
    const current = this.current();
    const source = await this.sourceOf(input.db);
    if (!source.inspector.writable || source.inspector.execute === undefined) {
      throw new DbError('unsupported', 'Snapshots are read-only.');
    }
    const verdict = await this.check(source, input.db, input.sql, { mode: 'write' });
    const params = input.params ?? [];
    const requestId = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + EDIT_TTL_MS;
    this.pending.set(requestId, {
      db: input.db,
      source,
      sql: input.sql,
      params,
      hash: editHash(input.db, input.sql, params),
      expiresAt,
      epoch: current.epoch,
    });
    while (this.pending.size > MAX_PENDING_EDITS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    return {
      requestId,
      db: input.db,
      sql: input.sql,
      params: params as DbEditRequest['params'],
      tables: verdict.tables,
      expiresAt,
    };
  }

  /**
   * Step 2: the user pressed "Run change". The request is used up whatever happens
   * next. It must be unexpired, from before no hot restart, and carry exactly the SQL
   * and parameters the dialog showed. The backend gets a fresh 43-character token.
   */
  async confirmEdit(input: {
    requestId: string;
    sql: string;
    params?: unknown[] | undefined;
  }): Promise<{ changes: number }> {
    const edit = this.pending.get(input.requestId);
    this.pending.delete(input.requestId);
    const refused = (why: string): DbError => new DbError('bad-token', `Not run: ${why}.`);
    if (edit === undefined) throw refused('this change was already answered or cancelled');
    if (this.now() >= edit.expiresAt) throw new DbError('timeout', 'Not run: no answer in 60 s.');
    const current = this.attached;
    if (current === undefined || !current.sources.includes(edit.source)) throw noApp();
    if (current.epoch !== edit.epoch) throw refused('the app restarted since you asked');
    if (editHash(edit.db, input.sql, input.params ?? []) !== edit.hash) {
      throw refused('the change differs from the one you were shown');
    }
    const execute = edit.source.inspector.execute?.bind(edit.source.inspector);
    if (execute === undefined) throw new DbError('unsupported', 'Snapshots are read-only.');
    // 256 random bits per confirm: a repeat is not a practical event, so none is tracked.
    const token = randomBytes(32).toString('base64url');
    try {
      return await execute(edit.db, edit.sql, edit.params, { token });
    } catch (err) {
      throw asDbError(err);
    }
  }

  cancelEdit(requestId: string): void {
    this.pending.delete(requestId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.offBus();
    await this.release();
  }

  private current(): Attached {
    if (this.closed || this.attached === undefined) throw noApp();
    return this.attached;
  }

  private async sourceOf(db: string): Promise<Source> {
    const current = this.current();
    let source = current.byName.get(db);
    if (source === undefined) {
      await this.list();
      source = current.byName.get(db);
    }
    if (source === undefined) throw new DbError('not-found', `No database named ${db}.`);
    return source;
  }

  private hidden(): { table: string; column: string }[] {
    return this.opts.settings.hiddenColumns.map(parseHiddenColumn);
  }

  private async hashes(source: Source, db: string): Promise<RowHashes> {
    if (source.inspector.rowHashes === undefined) {
      throw new DbError('unsupported', "This database can't take snapshots for a diff.");
    }
    try {
      return await source.inspector.rowHashes(db);
    } catch (err) {
      throw asDbError(err);
    }
  }

  /** The schema SQL for the gate: cached for live backends until a hot restart. */
  private schemaSql(source: Source, db: string, fresh: boolean): Promise<string[]> {
    const current = this.current();
    const key = JSON.stringify([source.inspector.id, db]);
    if (!source.inspector.live || fresh) current.schemaSql.delete(key);
    let pending = current.schemaSql.get(key);
    if (pending === undefined) {
      pending = source.inspector.schemaSql(db);
      current.schemaSql.set(key, pending);
      pending.catch(() => {
        if (current.schemaSql.get(key) === pending) current.schemaSql.delete(key);
      });
    }
    return pending;
  }

  /**
   * Which columns of `table` the gate lets Claude read (R1), asked of the gate itself:
   * `SELECT *` first, then one column at a time. Cached per schema SQL, so a diff of an
   * unchanged schema asks once. A gate that can't answer gives `unknown`.
   */
  private async visibility(
    source: Source,
    db: string,
    table: string,
    columns: readonly string[],
    key: readonly string[],
  ): Promise<TableVisibility> {
    let schemaSql: string[];
    try {
      schemaSql = await this.schemaSql(source, db, false);
    } catch {
      return { kind: 'unknown' };
    }
    let cache = this.visibilityCache.get(schemaSql);
    if (cache === undefined) {
      cache = new Map();
      this.visibilityCache.set(schemaSql, cache);
    }
    const cacheKey = JSON.stringify([table, columns, key]);
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const hiddenColumns = this.hidden();
    const check = (sql: string) =>
      this.opts.guard.check(sql, { schemaSql, mode: 'read', hiddenColumns });
    const cantAnswer = (v: GuardResult): boolean =>
      !v.ok && (v.code === 'unavailable' || v.code === 'timeout');
    let verdict: TableVisibility;
    const all = await check(`SELECT * FROM ${quoteIdent(table)}`);
    if (all.ok) {
      verdict = { kind: 'all' };
    } else if (cantAnswer(all)) {
      return { kind: 'unknown' };
    } else {
      const visible = new Set<string>();
      for (const column of new Set([...columns, ...key])) {
        const one = await check(`SELECT ${quoteIdent(column)} FROM ${quoteIdent(table)}`);
        if (cantAnswer(one)) return { kind: 'unknown' };
        if (one.ok) visible.add(column);
      }
      verdict = visible.size === 0 ? { kind: 'hidden-table' } : { kind: 'some', visible };
    }
    cache.set(cacheKey, verdict);
    return verdict;
  }

  /** The gate's verdict, or a `refused` DbError. A gate that can't answer refuses. */
  private async check(
    source: Source,
    db: string,
    sql: string,
    opts: Omit<GuardCheckOptions, 'schemaSql'>,
  ): Promise<Extract<GuardResult, { ok: true }>> {
    const judge = async (fresh: boolean): Promise<GuardResult> => {
      let schemaSql: string[];
      try {
        schemaSql = await this.schemaSql(source, db, fresh);
      } catch (err) {
        throw asDbError(err);
      }
      return this.opts.guard.check(sql, { schemaSql, ...opts });
    };
    let verdict = await judge(false);
    // The app may have changed its schema since it was cached: read it once more.
    if (
      !verdict.ok &&
      source.inspector.live &&
      (verdict.code === 'invalid-sql' || verdict.code === 'table')
    ) {
      verdict = await judge(true);
    }
    // The gate's reasons are plain words that already say what is allowed.
    if (!verdict.ok) throw new DbError('refused', verdict.reason);
    return verdict;
  }

  private watchTables(source: Source, db: string, tables: TableInfo[]): void {
    const { inspector } = source;
    const current = this.attached;
    if (current === undefined || inspector.watch === undefined) return;
    for (const t of tables) {
      if (t.kind !== 'table') continue;
      const key = JSON.stringify([inspector.id, db, t.name]);
      if (current.watches.has(key)) continue;
      const payload = { source: inspector.id, db, table: t.name };
      current.watches.set(
        key,
        inspector.watch(db, t.name, () => this.opts.bus.emit('db.changed', payload)),
      );
    }
  }

  /** Detaches: watches stop, backends close, snapshots and pending edits are dropped. */
  private async release(): Promise<void> {
    const current = this.attached;
    this.attached = undefined;
    this.snapshots = [];
    this.pending.clear();
    if (current === undefined) return;
    for (const off of current.watches.values()) off();
    current.watches.clear();
    await Promise.allSettled(current.sources.map(async (s) => s.inspector.close?.()));
  }
}
