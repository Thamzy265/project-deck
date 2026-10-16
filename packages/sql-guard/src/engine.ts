/**
 * The read-only gate's judge (ADR 0005), synchronous: it runs inside the guard's worker
 * thread, which owns the time budget. It never runs the statement it judges: it only
 * prepares it in a scratch in-memory database that holds the target's schema and no
 * rows, so nothing the statement says can touch the user's data.
 */
import { createHash } from 'node:crypto';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_READABLE,
  DENIED_FUNCTIONS,
  LEAKY_TABLES,
  READ_PRAGMAS,
} from './functions.js';
import type { GuardCheckOptions, GuardMode, GuardRefusal, GuardResult } from './types.js';
import { MAX_SCHEMA_BYTES, MAX_SCHEMA_STATEMENTS, MAX_SQL_BYTES } from './types.js';
import { virtualTableColumns } from './vtab.js';

type Sqlite3 = Sqlite3Static;
type Db = InstanceType<Sqlite3['oo1']['DB']>;

/** Loads the bundled wasm from disk (node build: fs.readFileSync, never the network). */
export async function loadSqlite(): Promise<Sqlite3> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  return init();
}

// Authorizer action codes (sqlite3.h, "Authorizer Action Codes").
const A = {
  CREATE_INDEX: 1,
  CREATE_TABLE: 2,
  CREATE_TRIGGER: 7,
  CREATE_VIEW: 8,
  DELETE: 9,
  INSERT: 18,
  PRAGMA: 19,
  READ: 20,
  SELECT: 21,
  TRANSACTION: 22,
  UPDATE: 23,
  ATTACH: 24,
  DETACH: 25,
  REINDEX: 27,
  CREATE_VTABLE: 29,
  FUNCTION: 31,
  SAVEPOINT: 32,
  RECURSIVE: 33,
} as const;
const SQLITE_OK = 0;
const SQLITE_DENY = 1;

const SCHEMA_CREATES: ReadonlySet<number> = new Set([
  A.CREATE_INDEX,
  A.CREATE_TABLE,
  A.CREATE_TRIGGER,
  A.CREATE_VIEW,
  A.CREATE_VTABLE,
]);
const SCHEMA_TABLES: ReadonlySet<string> = new Set(['sqlite_master', 'sqlite_schema']);

/** What one statement's authorizer calls showed. */
interface Seen {
  denial: GuardRefusal | undefined;
  tables: Set<string>;
  functions: Set<string>;
  recursive: boolean;
  pragma: boolean;
  creates: number;
  /** Tables an edit inserts into, updates or deletes from, its triggers included. */
  written: Set<string>;
}

const newSeen = (): Seen => ({
  denial: undefined,
  tables: new Set(),
  functions: new Set(),
  recursive: false,
  pragma: false,
  creates: 0,
  written: new Set(),
});

type Policy =
  | { kind: 'off' }
  | { kind: 'schema'; seen: Seen }
  | {
      kind: 'check';
      mode: GuardMode;
      seen: Seen;
      hidden: ReadonlySet<string>;
    };

interface Scratch {
  db: Db;
  relations: ReadonlySet<string>;
  /** The schema could not be accepted; every check refuses with this. */
  refusal: GuardRefusal | undefined;
}

/** Reads the denial afresh: authorizer callbacks set it while SQLite prepares. */
const denialOf = (seen: Seen): GuardRefusal | undefined => seen.denial;

const refuse = (code: GuardRefusal['code'], reason: string): GuardRefusal => ({
  ok: false,
  code,
  reason,
});

const lower = (s: string | 0 | null | undefined): string =>
  typeof s === 'string' ? s.toLowerCase() : '';

export interface GuardEngineOptions {
  /** Scratch databases kept, one per distinct schema (least recently used dropped). */
  maxSchemas?: number;
}

export class GuardEngine {
  private readonly scratches = new Map<string, Scratch>();
  private policy: Policy = { kind: 'off' };
  /** The scratch database the current check runs in. */
  private current: Scratch | undefined;
  private readonly maxSchemas: number;

  constructor(
    readonly sqlite: Sqlite3,
    opts: GuardEngineOptions = {},
  ) {
    this.maxSchemas = Math.max(1, opts.maxSchemas ?? 8);
  }

  get cachedSchemas(): number {
    return this.scratches.size;
  }

  close(): void {
    for (const s of this.scratches.values()) s.db.close();
    this.scratches.clear();
  }

  check(sql: string, opts: GuardCheckOptions): GuardResult {
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      return refuse('too-long', `The statement is longer than ${MAX_SQL_BYTES / 1000} kB.`);
    }
    const scratch = this.scratch(opts);
    if (scratch.refusal !== undefined) return scratch.refusal;
    const seen = newSeen();
    const hidden = new Set(
      (opts.hiddenColumns ?? []).map((h) => `${h.table.toLowerCase()}.${h.column.toLowerCase()}`),
    );
    this.policy = {
      kind: 'check',
      mode: opts.mode,
      seen,
      hidden,
    };
    try {
      return this.judge(scratch.db, sql, opts.mode, seen);
    } finally {
      this.policy = { kind: 'off' };
    }
  }

  private judge(db: Db, sql: string, mode: GuardMode, seen: Seen): GuardResult {
    const { capi } = this.sqlite;
    return this.withStatement(db, sql, (stmt, rc, tailIsEmpty) => {
      if (seen.denial !== undefined) return seen.denial;
      if (rc !== SQLITE_OK) return this.prepareFailure(db);
      if (stmt === 0) return refuse('empty', 'There is no SQL statement to run.');
      if (!tailIsEmpty()) {
        return refuse('multiple-statements', 'Send only one statement at a time.');
      }
      const explain = capi.sqlite3_stmt_isexplain(stmt) !== 0;
      if (explain && capi.sqlite3_stmt_explain(stmt, 0) !== SQLITE_OK) {
        return refuse('invalid-sql', 'SQLite could not read the explained statement.');
      }
      // Re-preparing in normal mode runs the authorizer again on the inner statement.
      const innerDenial = denialOf(seen);
      if (innerDenial !== undefined) return innerDenial;
      const readOnly = capi.sqlite3_stmt_readonly(stmt) !== 0;
      if (mode === 'read' && !readOnly) {
        return refuse(
          'writes-data',
          'This statement changes data or the database. Only reading is allowed here.',
        );
      }
      if (mode === 'write' && this.hasVacuum(stmt)) {
        return refuse('vacuum', 'VACUUM is not allowed.');
      }
      return {
        ok: true,
        kind: explain ? 'explain' : seen.pragma ? 'pragma' : readOnly ? 'select' : 'write',
        tables: [...seen.tables],
        functions: [...seen.functions],
        recursive: seen.recursive,
      };
    });
  }

  /**
   * Prepares the first statement of `sql` (skipping empty ones such as a lone `;`) and
   * hands it to `use` with a check that the rest holds only whitespace and comments.
   * The statement is always finalized and the wasm memory freed.
   */
  private withStatement<T>(
    db: Db,
    sql: string,
    use: (stmt: number, rc: number, tailIsEmpty: () => boolean) => T,
  ): T {
    const { capi, wasm } = this.sqlite;
    const stack = wasm.pstack.pointer;
    const [start, length] = wasm.allocCString(sql, true);
    const end = start + length;
    let stmt = 0;
    try {
      const ppStmt = wasm.pstack.allocPtr();
      const pzTail = wasm.pstack.allocPtr();
      const prepare = (from: number): { rc: number; stmt: number; tail: number } => {
        const rc = capi.sqlite3_prepare_v3(db.pointer ?? 0, from, end - from, 0, ppStmt, pzTail);
        return { rc, stmt: wasm.peekPtr(ppStmt), tail: wasm.peekPtr(pzTail) };
      };
      let at = start;
      let first = prepare(at);
      while (first.rc === SQLITE_OK && first.stmt === 0 && first.tail > at && first.tail < end) {
        at = first.tail;
        first = prepare(at);
      }
      stmt = first.stmt;
      const tailIsEmpty = (): boolean => {
        const saved = this.policy;
        // The rest is only checked for being empty; its contents are never judged.
        this.policy = { kind: 'off' };
        try {
          let from = first.tail;
          while (from > 0 && from < end) {
            const next = prepare(from);
            if (next.stmt !== 0) capi.sqlite3_finalize(next.stmt);
            if (next.rc !== SQLITE_OK || next.stmt !== 0) return false;
            if (next.tail <= from) return true;
            from = next.tail;
          }
          return true;
        } finally {
          this.policy = saved;
        }
      };
      return use(stmt, first.rc, tailIsEmpty);
    } finally {
      if (stmt !== 0) capi.sqlite3_finalize(stmt);
      wasm.dealloc(start);
      wasm.pstack.restore(stack);
    }
  }

  private prepareFailure(db: Db): GuardRefusal {
    const message = this.sqlite.capi.sqlite3_errmsg(db.pointer ?? 0);
    const fn = /^no such function: (.+)$/.exec(message)?.[1];
    if (fn !== undefined) return this.functionRefusal(fn.toLowerCase());
    return refuse('invalid-sql', `SQLite could not prepare the statement: ${message}.`);
  }

  private functionRefusal(name: string): GuardRefusal {
    if (DENIED_FUNCTIONS.has(name)) {
      return refuse('function', `The function ${name} is never allowed.`);
    }
    return refuse(
      'function',
      `The function ${name} is not allowed. Only SQLite's built-in functions can be used here.`,
    );
  }

  /** VACUUM has no authorizer action, so look for its opcode in the EXPLAIN listing. */
  private hasVacuum(stmt: number): boolean {
    const { capi } = this.sqlite;
    if (capi.sqlite3_stmt_explain(stmt, 1) !== SQLITE_OK) return true;
    try {
      // Stepping an EXPLAIN only lists the program; nothing runs.
      while (capi.sqlite3_step(stmt) === capi.SQLITE_ROW) {
        if (capi.sqlite3_column_text(stmt, 1) === 'Vacuum') return true;
      }
      return false;
    } finally {
      capi.sqlite3_reset(stmt);
    }
  }

  /** The authorizer: one per scratch database, following the current policy. */
  private authorize(
    action: number,
    arg1: string | 0,
    arg2: string | 0,
    dbName: string | 0,
  ): number {
    const policy = this.policy;
    if (policy.kind === 'off') return SQLITE_OK;
    const seen = policy.seen;
    // The first denial is the one reported; later calls are refused without overwriting it.
    if (seen.denial !== undefined) return SQLITE_DENY;
    const denial =
      policy.kind === 'schema'
        ? this.schemaRule(action, arg1, dbName, seen)
        : this.checkRule(action, arg1, arg2, policy);
    if (denial === undefined) return SQLITE_OK;
    seen.denial = denial;
    return SQLITE_DENY;
  }

  private schemaRule(
    action: number,
    arg1: string | 0,
    dbName: string | 0,
    seen: Seen,
  ): GuardRefusal | undefined {
    const bad = refuse('schema', 'The schema holds a statement other than CREATE.');
    if (SCHEMA_CREATES.has(action)) {
      // AUTOINCREMENT also creates sqlite_sequence, so one statement may create two.
      seen.creates++;
      return lower(dbName) === 'main' ? undefined : bad;
    }
    if (action === A.INSERT || action === A.UPDATE) {
      return SCHEMA_TABLES.has(lower(arg1)) ? undefined : bad;
    }
    // CREATE INDEX reads the indexed columns; expressions may call functions.
    if (action === A.READ || action === A.REINDEX || action === A.FUNCTION) return undefined;
    return bad;
  }

  private checkRule(
    action: number,
    arg1: string | 0,
    arg2: string | 0,
    policy: Extract<Policy, { kind: 'check' }>,
  ): GuardRefusal | undefined {
    const { seen, mode } = policy;
    switch (action) {
      case A.SELECT:
        return undefined;
      case A.RECURSIVE:
        seen.recursive = true;
        return undefined;
      case A.READ:
        return this.readRule(lower(arg1), lower(arg2), policy);
      case A.FUNCTION: {
        const name = lower(arg2);
        seen.functions.add(name);
        if (DENIED_FUNCTIONS.has(name)) return this.functionRefusal(name);
        if (BUILTIN_FUNCTIONS.has(name)) return undefined;
        return this.functionRefusal(name);
      }
      case A.PRAGMA: {
        const name = lower(arg1);
        seen.pragma = true;
        if (READ_PRAGMAS.has(name)) return undefined;
        return refuse(
          'pragma',
          `PRAGMA ${name} is not allowed. Only ${[...READ_PRAGMAS].join(', ')} can be read.`,
        );
      }
      case A.TRANSACTION:
      case A.SAVEPOINT:
        return refuse(
          'transaction',
          'Transactions (BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE) are not allowed.',
        );
      case A.ATTACH:
      case A.DETACH:
        return refuse('attach', 'ATTACH and DETACH are not allowed.');
    }
    if (mode === 'write') return this.editRule(action, lower(arg1), seen);
    return refuse(
      'writes-data',
      'This statement changes data or the database. Only reading is allowed here.',
    );
  }

  /**
   * Dashboard edits change rows only (UI spec): INSERT, UPDATE or DELETE (REPLACE and
   * upserts included) on exactly one table. Trigger bodies are compiled with the
   * statement, so a trigger that writes elsewhere counts as a second table.
   */
  private editRule(action: number, table: string, seen: Seen): GuardRefusal | undefined {
    if (action !== A.INSERT && action !== A.UPDATE && action !== A.DELETE) {
      return refuse(
        'not-an-edit',
        'Only INSERT, UPDATE and DELETE on rows are allowed for edits; the schema stays as it is.',
      );
    }
    seen.written.add(table);
    if (seen.written.size > 1) {
      return refuse(
        'multiple-tables',
        `An edit may change one table only; this one also changes ${[...seen.written].join(', ')} (for example through a trigger).`,
      );
    }
    return undefined;
  }

  private readRule(
    table: string,
    column: string,
    policy: Extract<Policy, { kind: 'check' }>,
  ): GuardRefusal | undefined {
    const leak = LEAKY_TABLES.get(table);
    if (leak !== undefined) return refuse('table', `Reading ${table} is not allowed: ${leak}.`);
    const scratch = this.current;
    if (!BUILTIN_READABLE.has(table) && !(scratch?.relations.has(table) ?? false)) {
      return refuse('table', `${table} is not a table or view of this database.`);
    }
    policy.seen.tables.add(table);
    if (column !== '' && policy.hidden.has(`${table}.${column}`)) {
      return refuse(
        'hidden-column',
        `The statement reads ${table}.${column}, which is hidden (db.hiddenColumns). Leave it out; if you used *, list the columns you need.`,
      );
    }
    return undefined;
  }

  private scratch(opts: GuardCheckOptions): Scratch {
    const key = createHash('sha256').update(JSON.stringify(opts.schemaSql)).digest('hex');
    let scratch = this.scratches.get(key);
    if (scratch !== undefined) {
      // Most recently used goes last.
      this.scratches.delete(key);
    } else {
      scratch = this.build(opts.schemaSql);
      while (this.scratches.size >= this.maxSchemas) {
        const oldest = this.scratches.keys().next();
        if (oldest.done === true) break;
        this.scratches.get(oldest.value)?.db.close();
        this.scratches.delete(oldest.value);
      }
    }
    this.scratches.set(key, scratch);
    this.current = scratch;
    return scratch;
  }

  private build(schemaSql: readonly string[]): Scratch {
    const { capi, oo1 } = this.sqlite;
    const db = new oo1.DB(':memory:', 'c');
    const pointer = db.pointer ?? 0;
    capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES);
    capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, 1_000_000);
    // Compile foreign key actions, so a cascade shows up as a write to its table.
    db.exec('PRAGMA foreign_keys = ON');
    capi.sqlite3_set_authorizer(
      pointer,
      (_ctx, action, arg1, arg2, dbName) => this.authorize(action, arg1, arg2, dbName),
      0,
    );
    // No function stubs (ADR 0005 amended): an app-defined function fails to prepare,
    // which refuses it; the app's read connection registers none either.
    const scratch: Scratch = {
      db,
      relations: new Set(),
      refusal: undefined,
    };
    const bytes = schemaSql.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);
    if (schemaSql.length > MAX_SCHEMA_STATEMENTS || bytes > MAX_SCHEMA_BYTES) {
      scratch.refusal = refuse('schema', 'The database schema is too large for the gate.');
      return scratch;
    }
    this.loadSchema(db, schemaSql);
    const names = db.selectValues(
      "SELECT lower(name) FROM sqlite_schema WHERE type IN ('table', 'view')",
    );
    scratch.relations = new Set(names.filter((n): n is string => typeof n === 'string'));
    return scratch;
  }

  /**
   * Accepts only single CREATE TABLE/INDEX/VIEW/TRIGGER/VIRTUAL TABLE statements in the
   * main schema; anything else is skipped. Retries in passes, since sqlite_schema order
   * can put an index before its table.
   */
  private loadSchema(db: Db, schemaSql: readonly string[]): void {
    let pending = [...schemaSql];
    for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
      const retry: string[] = [];
      for (const sql of pending) {
        if (this.createOne(db, sql) === 'retry') retry.push(sql);
      }
      if (retry.length === pending.length) break;
      pending = retry;
    }
  }

  private createOne(db: Db, sql: string): 'done' | 'skip' | 'retry' {
    const { capi } = this.sqlite;
    const seen = newSeen();
    let vtab: string | undefined;
    this.policy = { kind: 'schema', seen };
    try {
      return this.withStatement(db, sql, (stmt, rc, tailIsEmpty) => {
        if (seen.denial !== undefined) return 'skip';
        if (rc !== SQLITE_OK) return 'retry';
        if (stmt === 0 || seen.creates === 0 || !tailIsEmpty()) return 'skip';
        this.policy = { kind: 'off' };
        const stepped = capi.sqlite3_step(stmt);
        if (stepped === capi.SQLITE_DONE) return 'done';
        const message = capi.sqlite3_errmsg(db.pointer ?? 0);
        if (message.startsWith('no such module:')) vtab = sql;
        return message.includes('already exists') ? 'skip' : vtab === undefined ? 'retry' : 'skip';
      });
    } catch {
      return 'skip';
    } finally {
      this.policy = { kind: 'off' };
      if (vtab !== undefined) this.plainTableFor(db, vtab);
    }
  }

  /** A virtual table whose module the gate lacks becomes a plain table of its columns. */
  private plainTableFor(db: Db, sql: string): void {
    const parsed = virtualTableColumns(sql);
    if (parsed === undefined || parsed.columns.length === 0) return;
    const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
    const create = `CREATE TABLE ${quote(parsed.table)} (${parsed.columns.map(quote).join(', ')})`;
    this.createOne(db, create);
  }
}
