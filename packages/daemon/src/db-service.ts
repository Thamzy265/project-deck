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
/** Schemas whose column visibility for Claude is kept (L1). */
const MAX_VISIBILITY_SCHEMAS = 8;

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
  /** The tables the gate found, for the Activity entry. */
  tables: string[];
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

/** SQLite folds ASCII letters only when it compares names. */
const fold = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A name in double quotes, safe in SQL whatever it holds. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const VIEW_NAME =
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[\w$]+)/i;

/** The name in a CREATE VIEW statement, unquoted. */
function viewName(sql: string): string | undefined {
  const raw = VIEW_NAME.exec(sql)?.[1];
  if (raw === undefined) return undefined;
  const first = raw[0];
  if (first === '"') return raw.slice(1, -1).replaceAll('""', '"');
  if (first === '`' || first === '[') return raw.slice(1, -1);
  return raw;
}

/** True when `name` appears in `text` as a whole word (both folded). */
function namesWord(text: string, name: string): boolean {
  const escaped = fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])${escaped}($|[^\\w$])`).test(text);
}

/**
 * A hidden-column refusal names the base column, which confuses a reader of a view
 * that only selects it (QA G1): SQLite's authorizer reports every column of a view's
 * body, so such a view is refused whole. Says so only for a view the statement names
 * whose own body names a table with hidden columns (review R7).
 */
function viewNote(
  reason: string,
  sql: string,
  schemaSql: readonly string[],
  hiddenTables: readonly string[],
): string {
  const text = fold(sql);
  for (const statement of schemaSql) {
    const name = viewName(statement);
    if (name === undefined || !namesWord(text, name)) continue;
    const body = fold(statement);
    if (hiddenTables.some((t) => namesWord(body, t))) {
      return `${reason} ${name} is a view that reads a hidden column, so it can't be read at all, even its other columns.`;
    }
  }
  return reason;
}

const EDIT_TARGET =
  /^\s*(?:UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO)\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/i;

/** An edit that row details builds with the row check: an UPDATE or a DELETE. */
const CHECKED_EDIT = /^\s*(?:UPDATE|DELETE)\b/i;

/**
 * The table an edit names first, for the Activity entry of a refused edit. The gate
 * refused it, so this reads only the leading words; it says nothing about safety.
 */
function editTarget(sql: string): string | undefined {
  const raw = EDIT_TARGET.exec(sql)?.[1];
  if (raw === undefined) return undefined;
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw;
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
  private readonly visibilityCache = new Map<string, Map<string, TableVisibility>>();
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
        ...(error === undefined
          ? {}
          : {
              error: {
                code: error.code,
                message: error.message,
                ...(error.devices === undefined ? {} : { devices: error.devices }),
              },
            }),
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
    if (caller === 'dashboard') {
      // Only the dashboard re-queries open tables; watches end with its last client (R9).
      this.watchTables(source, db, tables);
      return { db, tables };
    }
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
    const { verdict, schemaSql } = await this.check(source, input.db, input.sql, {
      mode: 'read',
      ...(hiddenColumns === undefined ? {} : { hiddenColumns }),
    });
    let result: QueryResult;
    try {
      // The backend runs it only on the schema the gate judged (R8).
      result = await source.inspector.query(input.db, input.sql, input.params ?? [], {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        checkedSchemaSql: schemaSql,
      });
    } catch (err) {
      throw asDbError(err);
    }
    if (caller === 'claude' && hiddenColumns !== undefined && hiddenColumns.length > 0) {
      await this.checkResultColumns(source, input.db, schemaSql, verdict.tables, result.columns);
    }
    return result;
  }

  /**
   * A last check on what Claude gets back (R8): no result column may be named like a
   * column the gate hides in a table the statement read, generated ones included. It
   * fails closed: a gate that can't answer refuses the result.
   */
  private async checkResultColumns(
    source: Source,
    db: string,
    schemaSql: string[],
    tables: readonly string[],
    columns: readonly string[],
  ): Promise<void> {
    const names = new Set(this.hidden().map((h) => fold(h.column)));
    const refuse = (): DbError =>
      new DbError('refused', 'The answer would show a hidden column (db.hiddenColumns).');
    for (const column of columns) {
      if (names.has(fold(column))) throw refuse();
      for (const table of tables) {
        if ((await this.columnVisible(source, db, schemaSql, table, column)) !== true) {
          throw refuse();
        }
      }
    }
  }

  /** Whether the gate lets Claude read `table.column`; true also when there is no such column. */
  private async columnVisible(
    _source: Source,
    _db: string,
    schemaSql: string[],
    table: string,
    column: string,
  ): Promise<boolean | undefined> {
    const cache = this.visibilityFor(schemaSql);
    const key = JSON.stringify(['column', table, column]);
    const hit = cache.get(key);
    if (hit !== undefined) return hit.kind === 'all';
    const v = await this.opts.guard.check(
      `SELECT ${quoteIdent(column)} FROM ${quoteIdent(table)}`,
      {
        schemaSql,
        mode: 'read',
        hiddenColumns: this.hidden(),
      },
    );
    if (!v.ok && (v.code === 'unavailable' || v.code === 'timeout')) return undefined;
    // "No such column" (an alias or an expression) reads nothing of the table.
    const visible = v.ok || v.code === 'invalid-sql';
    cache.set(key, visible ? { kind: 'all' } : { kind: 'hidden-table' });
    return visible;
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
    this.opts.bus.emit('db.snapshot', { db: input.db });
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
    // Claude's columns are judged against the schema as it is now, read once per diff:
    // a cached schema can miss columns the app added since (L1).
    const freshSchema =
      caller === 'claude' && this.hidden().length > 0
        ? await this.schemaSql(source, input.db, true).catch(() => undefined)
        : undefined;
    try {
      const { tables, truncated, tablesOmitted } = await buildDiff(
        source.inspector,
        input.db,
        snapshot.hashes,
        now,
        caller === 'claude' ? CLAUDE_DIFF_CAPS : DASHBOARD_DIFF_CAPS,
        caller === 'claude' ? this.hidden() : undefined,
        caller === 'claude' && this.hidden().length > 0
          ? (table, columns, key) => this.visibility(freshSchema, table, columns, key)
          : undefined,
      );
      this.opts.bus.emit('db.diff', { db: input.db });
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

  /** After a `choose-device` answer: the user picked the device for snapshot backend `id`. */
  async chooseDevice(id: string, device: string): Promise<void> {
    const source = this.current().sources.find((s) => s.inspector.id === id);
    if (source === undefined) throw new DbError('not-found', `No database backend named ${id}.`);
    const choose = source.inspector.chooseDevice?.bind(source.inspector);
    if (choose === undefined) {
      throw new DbError(
        'unsupported',
        'This backend reads the running app; there is no device to pick.',
      );
    }
    try {
      await choose(device);
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
    let verdict: Extract<GuardResult, { ok: true }>;
    try {
      ({ verdict } = await this.check(source, input.db, input.sql, { mode: 'write' }));
    } catch (err) {
      // A refused edit is a denied write too (lead decision G4): names only, never SQL.
      if (isDbError(err) && err.code === 'refused') {
        const table = editTarget(input.sql);
        this.opts.bus.emit('db.write', {
          db: input.db,
          tables: table === undefined ? [] : [table],
          allowed: false,
        });
      }
      throw err;
    }
    // The confirm and Activity name the table the edit writes, not tables it only
    // reads (a parent for a foreign-key check). The gate passes an edit only when it
    // writes exactly one table, and lists that table first (Q2).
    const written = verdict.tables.slice(0, 1);
    const params = input.params ?? [];
    const requestId = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + EDIT_TTL_MS;
    this.pending.set(requestId, {
      db: input.db,
      source,
      sql: input.sql,
      params,
      tables: written,
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
      tables: written,
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
    let result: { changes: number };
    try {
      result = await execute(edit.db, edit.sql, edit.params, { token });
    } catch (err) {
      throw asDbError(err);
    }
    // Every UPDATE and DELETE the dashboard sends comes from row details and matches
    // the row as it was read (review L3), so one that matched nothing found the row
    // changed: the change was refused, not made.
    if (result.changes === 0 && CHECKED_EDIT.test(edit.sql)) {
      this.opts.bus.emit('db.write', {
        db: edit.db,
        tables: edit.tables,
        allowed: false,
        reason: 'row-changed',
      });
      return result;
    }
    this.opts.bus.emit('db.write', {
      db: edit.db,
      tables: edit.tables,
      allowed: true,
      changes: result.changes,
    });
    return result;
  }

  /** Stops every table watch, e.g. when the last dashboard client has gone (R9). */
  releaseWatches(): void {
    const current = this.attached;
    if (current === undefined) return;
    for (const off of current.watches.values()) off();
    current.watches.clear();
  }

  cancelEdit(requestId: string): void {
    const edit = this.pending.get(requestId);
    if (edit === undefined) return;
    this.pending.delete(requestId);
    this.opts.bus.emit('db.write', { db: edit.db, tables: edit.tables, allowed: false });
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
   * Which columns of `table` the gate lets Claude read (R1, L1), asked of the gate one
   * column at a time against `schemaSql`, which the diff reads fresh. A column the
   * gate's schema doesn't know (invalid-sql) counts as hidden: the app's data may be
   * ahead of its schema reply. Cached per schema text, so an unchanged schema asks once.
   * `schemaSql` undefined (the schema couldn't be read) or a gate that can't answer
   * gives `unknown`.
   */
  private async visibility(
    schemaSql: string[] | undefined,
    table: string,
    columns: readonly string[],
    key: readonly string[],
  ): Promise<TableVisibility> {
    if (schemaSql === undefined) return { kind: 'unknown' };
    const cache = this.visibilityFor(schemaSql);
    const cacheKey = JSON.stringify([table, columns, key]);
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const hiddenColumns = this.hidden();
    const wanted = [...new Set([...columns, ...key])];
    const visible = new Set<string>();
    for (const column of wanted) {
      const one = await this.opts.guard.check(
        `SELECT ${quoteIdent(column)} FROM ${quoteIdent(table)}`,
        { schemaSql, mode: 'read', hiddenColumns },
      );
      if (!one.ok && (one.code === 'unavailable' || one.code === 'timeout')) {
        return { kind: 'unknown' };
      }
      if (one.ok) visible.add(column);
    }
    const verdict: TableVisibility =
      visible.size === 0
        ? { kind: 'hidden-table' }
        : visible.size === wanted.length
          ? { kind: 'all' }
          : { kind: 'some', visible };
    cache.set(cacheKey, verdict);
    return verdict;
  }

  /** The visibility cache for one schema text; a few schemas are kept, oldest dropped. */
  private visibilityFor(schemaSql: readonly string[]): Map<string, TableVisibility> {
    const id = createHash('sha256').update(schemaSql.join('\u0000')).digest('hex');
    let cache = this.visibilityCache.get(id);
    if (cache === undefined) {
      cache = new Map();
      this.visibilityCache.set(id, cache);
      while (this.visibilityCache.size > MAX_VISIBILITY_SCHEMAS) {
        const oldest = this.visibilityCache.keys().next().value;
        if (oldest === undefined) break;
        this.visibilityCache.delete(oldest);
      }
    }
    return cache;
  }

  /** The gate's verdict, or a `refused` DbError. A gate that can't answer refuses. */
  private async check(
    source: Source,
    db: string,
    sql: string,
    opts: Omit<GuardCheckOptions, 'schemaSql'>,
  ): Promise<{ verdict: Extract<GuardResult, { ok: true }>; schemaSql: string[] }> {
    let schemaSql: string[] = [];
    const judge = async (fresh: boolean): Promise<GuardResult> => {
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
    if (!verdict.ok) {
      const reason =
        verdict.code === 'hidden-column'
          ? viewNote(
              verdict.reason,
              sql,
              schemaSql,
              this.hidden().map((h) => h.table),
            )
          : verdict.reason;
      throw new DbError('refused', reason, { detail: verdict.code });
    }
    return { verdict, schemaSql };
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
