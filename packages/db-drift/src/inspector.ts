import type {
  AppExtensions,
  DbExecuteOptions,
  DbInfo,
  DbInspector,
  KeyedRows,
  QueryResult,
  RowHashes,
  RowKey,
  TableInfo,
} from '@project-deck/core';
import { DEFAULT_QUERY_LIMIT, DbError, MAX_KEYS_PER_CALL, isDbError } from '@project-deck/core';
import type { z } from 'zod';
import { Coalescer } from './coalesce.js';
import type { Action } from './protocol.js';
import {
  EXTENSION_PREFIX,
  ExecuteReply,
  ListReply,
  QueryReply,
  RowsReply,
  SchemaReply,
  SnapshotReply,
  TABLES_EVENT,
  TablesEvent,
  WRITE_TOKEN,
  readReply,
} from './protocol.js';

/** Most rows flutterdeck_drift returns in one reply. */
const APP_MAX_ROWS = 5000;

/**
 * Call budgets. The app stops a read at 5 s and gives it 1 s more to unwind; an edit
 * can wait up to 5 s behind a read on the same isolate (status log, batch 2 notes) and
 * then runs. Each budget leaves room for the app's own answer to arrive first.
 */
export const TIMEOUTS: Record<Action, number> = {
  list: 5000,
  schema: 8000,
  query: 8000,
  snapshot: 8000,
  rows: 8000,
  execute: 15_000,
};

export interface DriftInspectorOptions {
  /** Subscribes to hot restarts of the app; the schema state is read again after one. */
  onRestart?: (cb: () => void) => () => void;
  /** Window for coalescing table events (ADR 0004 amended: 250 ms). */
  coalesceMs?: number;
}

/**
 * The live Drift backend: `flutterdeck_drift`'s `ext.flutterdeck.drift.v1.*` extensions
 * over the session's app extensions (ADR 0004). Callers pass only SQL the daemon's
 * read-only gate accepted; the app checks again on its read-only connection (ADR 0005).
 */
export class DriftInspector implements DbInspector {
  readonly id = 'drift';
  readonly live = true;
  readonly writable = true;
  /** Per database: whether the app's last schema reply cut its schema SQL. */
  private readonly truncated = new Map<string, boolean>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly coalescer: Coalescer;
  private offEvents: (() => void) | undefined;
  private readonly offRestart: () => void;
  private closed = false;

  constructor(
    private readonly ext: AppExtensions,
    opts: DriftInspectorOptions = {},
  ) {
    this.coalescer = new Coalescer(opts.coalesceMs ?? 250);
    this.offRestart = opts.onRestart?.(() => this.truncated.clear()) ?? (() => undefined);
  }

  async listDatabases(): Promise<DbInfo[]> {
    const reply = await this.call('list', {}, ListReply, '');
    return reply.databases.map((d) => ({ name: d.name, backend: 'live' as const }));
  }

  async schema(db: string): Promise<TableInfo[]> {
    return (await this.readSchema(db)).tables;
  }

  /**
   * The schema SQL the gate loads. When the app had to cut it (over 8 MB), the gate
   * would judge statements against a partial schema, so this fails closed.
   */
  async schemaSql(db: string): Promise<string[]> {
    const reply = await this.readSchema(db);
    if (reply.sqlSchemaTruncated === true) throw schemaTooLarge();
    return [...reply.sqlSchema];
  }

  async query(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number } = {},
  ): Promise<QueryResult> {
    // Fail closed on our side too: never query a database whose schema SQL was cut.
    if (this.truncated.get(db) !== false) await this.readSchema(db);
    if (this.truncated.get(db) !== false) throw schemaTooLarge();
    const limit = Math.min(
      Math.max(Math.trunc(opts.limit ?? DEFAULT_QUERY_LIMIT), 1),
      APP_MAX_ROWS,
    );
    return this.call(
      'query',
      { db, sql, params: JSON.stringify(params), limit: String(limit) },
      QueryReply,
      db,
    );
  }

  async execute(
    db: string,
    sql: string,
    params: unknown[] = [],
    opts: DbExecuteOptions = {},
  ): Promise<{ changes: number }> {
    const token = opts.token;
    if (token === undefined || !WRITE_TOKEN.test(token)) {
      throw new DbError('bad-token', 'Changes need a confirm in the dashboard.');
    }
    return this.call(
      'execute',
      { db, sql, params: JSON.stringify(params), token },
      ExecuteReply,
      db,
    );
  }

  rowHashes(db: string): Promise<RowHashes> {
    return this.call('snapshot', { db }, SnapshotReply, db);
  }

  async rowsByKey(db: string, table: string, keys: RowKey[]): Promise<KeyedRows> {
    if (keys.length > MAX_KEYS_PER_CALL) {
      throw new DbError('too-large', `At most ${MAX_KEYS_PER_CALL} rows can be read at once.`);
    }
    return this.call('rows', { db, table, keys: JSON.stringify(keys) }, RowsReply, db);
  }

  watch(db: string, table: string, cb: () => void): () => void {
    if (this.closed) return () => undefined;
    const key = JSON.stringify([db, table]);
    let set = this.watchers.get(key);
    if (set === undefined) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(cb);
    this.offEvents ??= this.ext.onEvent(TABLES_EVENT, (data) => this.onTables(data));
    return () => {
      set.delete(cb);
      if (set.size > 0 || this.watchers.get(key) !== set) return;
      this.watchers.delete(key);
      // Nobody watches any more: stop taking the app's events until the next watch.
      if (this.watchers.size === 0) {
        this.offEvents?.();
        this.offEvents = undefined;
        this.coalescer.clear();
      }
    };
  }

  close(): Promise<void> {
    this.closed = true;
    this.offEvents?.();
    this.offEvents = undefined;
    this.offRestart();
    this.coalescer.clear();
    this.watchers.clear();
    return Promise.resolve();
  }

  private onTables(data: unknown): void {
    const event = TablesEvent.safeParse(data);
    if (!event.success) return;
    for (const { name } of event.data.tables) {
      const key = JSON.stringify([event.data.db, name]);
      if (!this.watchers.has(key)) continue;
      this.coalescer.fire(key, () => {
        for (const cb of [...(this.watchers.get(key) ?? [])]) {
          try {
            cb();
          } catch {
            // One failing watcher must not stop the others.
          }
        }
      });
    }
  }

  private async readSchema(db: string): Promise<z.infer<typeof SchemaReply>> {
    const reply = await this.call('schema', { db }, SchemaReply, db);
    this.truncated.set(db, reply.sqlSchemaTruncated === true);
    return reply;
  }

  private async call<S extends z.ZodType>(
    action: Action,
    params: Record<string, string>,
    schema: S,
    db: string,
  ): Promise<z.infer<S>> {
    let raw: unknown;
    try {
      raw = await this.ext.call(`${EXTENSION_PREFIX}${action}`, params, {
        timeoutMs: TIMEOUTS[action],
      });
    } catch (err) {
      throw callError(action, err);
    }
    return readReply(action, raw, schema, db);
  }
}

function schemaTooLarge(): DbError {
  return new DbError(
    'too-large',
    "This database's schema is too large for FlutterDeck to check queries safely, so queries are off.",
  );
}

/** A failed extension call as a DbError, without the connector's or the app's text. */
function callError(action: Action, err: unknown): DbError {
  if (isDbError(err)) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  const seconds = TIMEOUTS[action] / 1000;
  switch (code) {
    case 'not-found':
      return new DbError(
        'setup-needed',
        "Add flutterdeck_drift to see your database live. In your app's main(), after you create the database: FlutterDeckDrift.register(db, name: 'app');",
      );
    case 'timeout':
      return new DbError(
        'timeout',
        action === 'execute'
          ? `The app didn't answer in ${seconds} s. The change may still have run: check the table.`
          : `The app didn't answer in ${seconds} s. Is it paused at a breakpoint?`,
      );
    case 'detached':
      return new DbError('app-gone', 'The app stopped.');
    default:
      return new DbError('internal', "The app's database extension failed.");
  }
}
