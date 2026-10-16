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
import type {
  GuardCheckOptions,
  GuardMode,
  GuardRefusal,
  GuardResult,
  HiddenColumn,
} from './types.js';
import { MAX_SCHEMA_BYTES, MAX_SCHEMA_STATEMENTS, MAX_SQL_BYTES } from './types.js';
import type { BTree, HiddenColumns, Op } from './bytecode.js';
import { findHiddenRead, tablesOpened } from './bytecode.js';
import { generatedColumnRefs } from './generated.js';
import { foldName } from './names.js';
import { virtualTableColumns, virtualTableOptions } from './vtab.js';

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

/**
 * Virtual table modules the gate instantiates from a schema (SG-7). Any other module
 * becomes a plain table of the same columns, so its code never runs in the gate.
 */
const VTAB_MODULES: ReadonlySet<string> = new Set(['fts3', 'fts4', 'fts5', 'rtree', 'rtree_i32']);
/** Modules that read raw pages under any table name: such a schema is refused. */
const PAGE_MODULES: ReadonlySet<string> = new Set(['dbstat', 'sqlite_dbpage']);

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
  /** Schema loading: the virtual table a CREATE VIRTUAL TABLE declares, and its module. */
  vtab: { name: string; module: string } | undefined;
}

const newSeen = (): Seen => ({
  denial: undefined,
  tables: new Set(),
  functions: new Set(),
  recursive: false,
  pragma: false,
  creates: 0,
  written: new Set(),
  vtab: undefined,
});

type Policy =
  | { kind: 'off' }
  | { kind: 'schema'; seen: Seen }
  | {
      kind: 'check';
      mode: GuardMode;
      seen: Seen;
      hidden: HiddenColumns;
      /** Virtual tables holding a hidden column, with their shadow tables (SG-2). */
      hiddenTables: ReadonlySet<string>;
    };

interface Scratch {
  db: Db;
  relations: ReadonlySet<string>;
  /**
   * Every virtual table the schema declares (folded name → module), whether the gate
   * created it, stood a plain table in for it, or failed to create it (S1).
   */
  virtualTables: Map<string, string>;
  /**
   * Tables a virtual table keeps its data in (e.g. FTS5's notes_data), folded: SQLite's
   * own list plus every `<vtab>_<suffix>` table, since a virtual table the gate could not
   * create leaves its shadow tables as plain ones (S1).
   */
  shadowTables: ReadonlySet<string>;
  /** FTS tables that index another table (`content=`): folded vtab → content table. */
  contentTables: Map<string, string>;
  /** Main-schema tables and indexes by root page, for the bytecode check. */
  trees: ReadonlyMap<number, BTree>;
  /** Table → generated column → identifiers in its expression (all folded). */
  generated: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /** Schema statements skipped for being longer than MAX_SQL_BYTES (by design). */
  skippedLong: number;
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
  typeof s === 'string' ? foldName(s) : '';

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

  /**
   * Builds (or reuses) the scratch database for a schema. The guard calls this on its
   * own, under its own time budget, before the check. Returns the refusal if the schema
   * can't be used.
   */
  loadSchema(schemaSql: readonly string[]): GuardRefusal | undefined {
    return this.scratch(schemaSql).refusal;
  }

  check(sql: string, opts: GuardCheckOptions): GuardResult {
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      return refuse('too-long', `The statement is longer than ${MAX_SQL_BYTES / 1000} kB.`);
    }
    // SQLite stops reading at a NUL, so text after one would never be judged (SG-5).
    if (sql.includes('\u0000')) {
      return refuse('invalid-sql', 'The statement contains a NUL character, which is not allowed.');
    }
    const scratch = this.scratch(opts.schemaSql);
    if (scratch.refusal !== undefined) return scratch.refusal;
    const seen = newSeen();
    const hidden = this.expandHidden(scratch, opts.hiddenColumns ?? []);
    this.policy = {
      kind: 'check',
      mode: opts.mode,
      seen,
      hidden,
      hiddenTables: this.hiddenTables(scratch, opts.hiddenColumns ?? []),
    };
    try {
      return this.judge(scratch, sql, opts.mode, seen, hidden);
    } finally {
      this.policy = { kind: 'off' };
    }
  }

  /**
   * A virtual table reads its columns its own way: FTS auxiliary functions and MATCH
   * column filters name them by index or inside a string, never through SQLITE_READ. So
   * a virtual table that holds a hidden column is hidden whole, with the shadow tables
   * that store its data (SG-2).
   */
  private hiddenTables(scratch: Scratch, hidden: readonly HiddenColumn[]): Set<string> {
    const withHidden = new Set(hidden.map((h) => foldName(h.table)));
    // An external-content FTS table indexes (and through MATCH reveals) its content
    // table's text, so a hidden column there hides the FTS table whole too (S3).
    for (const [vtab, content] of scratch.contentTables) {
      if (withHidden.has(content)) withHidden.add(vtab);
    }
    const tables = new Set<string>();
    // AUTOINCREMENT's counters give away row counts and the newest ids (S6).
    if (withHidden.size > 0) tables.add('sqlite_sequence');
    for (const table of withHidden) {
      if (!scratch.virtualTables.has(table)) continue;
      tables.add(table);
      for (const shadow of scratch.shadowTables) {
        if (shadow.startsWith(`${table}_`)) tables.add(shadow);
      }
    }
    return tables;
  }

  private judge(
    scratch: Scratch,
    sql: string,
    mode: GuardMode,
    seen: Seen,
    hidden: HiddenColumns,
  ): GuardResult {
    const { capi } = this.sqlite;
    const { db } = scratch;
    return this.withStatement(db, sql, (stmt, rc, tailIsEmpty) => {
      if (seen.denial !== undefined) return seen.denial;
      if (rc !== SQLITE_OK) return this.prepareFailure(scratch);
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
      const { hiddenTables } = this.checkPolicy();
      const unchecked = this.uncheckedTables(scratch);
      if (mode === 'write' || hidden.size > 0 || hiddenTables.size > 0 || unchecked.size > 0) {
        const ops = this.listProgram(stmt);
        if (ops === undefined) {
          return refuse('invalid-sql', 'SQLite could not list the compiled statement.');
        }
        // A count or other read with no column names no SQLITE_READ; the cursor shows it.
        const stood = [...tablesOpened(ops, scratch.trees)].find((t) => unchecked.has(t));
        if (stood !== undefined) return this.uncheckedRefusal(scratch, stood);
        // VACUUM has no authorizer action; its opcode shows it.
        if (mode === 'write' && ops.some((op) => op.opcode === 'Vacuum')) {
          return refuse('vacuum', 'VACUUM is not allowed.');
        }
        const read = findHiddenRead(ops, scratch.trees, hidden, hiddenTables);
        if (read !== undefined) {
          return refuse(
            'hidden-column',
            `The statement reads ${read}, which is hidden (db.hiddenColumns), for example through a join USING it, an index on it or a column computed from it. Leave it out.`,
          );
        }
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

  private prepareFailure(scratch: Scratch): GuardRefusal {
    const message = this.sqlite.capi.sqlite3_errmsg(scratch.db.pointer ?? 0);
    const fn = /^no such function: (.+)$/.exec(message)?.[1];
    if (fn !== undefined) return this.functionRefusal(foldName(fn));
    const skipped =
      scratch.skippedLong > 0 && message.startsWith('no such table')
        ? ` The SQL gate skips schema statements longer than ${MAX_SQL_BYTES / 1000} kB (${scratch.skippedLong} in this database), so tables they create can't be queried here.`
        : '';
    return refuse('invalid-sql', `SQLite could not prepare the statement: ${message}.${skipped}`);
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

  /** Stand-ins for modules outside VTAB_MODULES: their real module could read anything. */
  private uncheckedTables(scratch: Scratch): Set<string> {
    return new Set(
      [...scratch.virtualTables].filter(([, module]) => !VTAB_MODULES.has(module)).map(([t]) => t),
    );
  }

  private uncheckedRefusal(scratch: Scratch, table: string): GuardRefusal {
    const module = scratch.virtualTables.get(table) ?? 'an unknown module';
    return refuse(
      'table',
      `${table} is a virtual table on ${module}, which the SQL gate can't check, so it can't be read.`,
    );
  }

  private checkPolicy(): Extract<Policy, { kind: 'check' }> {
    if (this.policy.kind !== 'check') throw new Error('No check is running');
    return this.policy;
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
        ? this.schemaRule(action, arg1, arg2, dbName, seen)
        : this.checkRule(action, arg1, arg2, policy);
    if (denial === undefined) return SQLITE_OK;
    seen.denial = denial;
    return SQLITE_DENY;
  }

  private schemaRule(
    action: number,
    arg1: string | 0,
    arg2: string | 0,
    dbName: string | 0,
    seen: Seen,
  ): GuardRefusal | undefined {
    const bad = refuse('schema', 'The schema holds a statement other than CREATE.');
    if (action === A.CREATE_VTABLE && typeof arg1 === 'string') {
      seen.vtab = { name: arg1, module: lower(arg2) };
    }
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
    const scratch = this.current;
    if (scratch?.virtualTables.has(table) === true || scratch?.shadowTables.has(table) === true) {
      // FTS commands (delete-all, rebuild, rank) are INSERTs into the table itself (SG-8).
      return refuse(
        'not-an-edit',
        `Edits change ordinary tables only; ${table} is a virtual table or part of one.`,
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
    const module = scratch?.virtualTables.get(table);
    if (scratch !== undefined && module !== undefined && !VTAB_MODULES.has(module)) {
      return this.uncheckedRefusal(scratch, table);
    }
    policy.seen.tables.add(table);
    if (table === 'sqlite_sequence' && policy.hiddenTables.has(table)) {
      return refuse(
        'hidden-column',
        "sqlite_sequence shows the newest ids of tables, and some columns are hidden (db.hiddenColumns), so it can't be read.",
      );
    }
    if (policy.hiddenTables.has(table)) {
      return refuse(
        'hidden-column',
        `${table} holds a hidden column (db.hiddenColumns) and is a full-text or other virtual table, which can read any of its columns, so it can't be read at all.`,
      );
    }
    if (column !== '' && policy.hidden.get(table)?.has(column) === true) {
      return refuse(
        'hidden-column',
        `The statement reads ${table}.${column}, which is hidden (db.hiddenColumns). Leave it out; if you used *, list the columns you need.`,
      );
    }
    return undefined;
  }

  private scratch(schemaSql: readonly string[]): Scratch {
    const key = createHash('sha256').update(JSON.stringify(schemaSql)).digest('hex');
    let scratch = this.scratches.get(key);
    if (scratch !== undefined) {
      // Most recently used goes last.
      this.scratches.delete(key);
    } else {
      scratch = this.build(schemaSql);
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
      virtualTables: new Map(),
      shadowTables: new Set(),
      contentTables: new Map(),
      trees: new Map(),
      generated: new Map(),
      skippedLong: 0,
      refusal: undefined,
    };
    const bytes = schemaSql.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);
    if (schemaSql.length > MAX_SCHEMA_STATEMENTS || bytes > MAX_SCHEMA_BYTES) {
      scratch.refusal = refuse(
        'schema',
        `The database schema is too large for the SQL gate (more than ${MAX_SCHEMA_STATEMENTS.toLocaleString('en-GB')} statements or ${MAX_SCHEMA_BYTES / 1024 / 1024} MB), so nothing can be checked.`,
      );
      return scratch;
    }
    // Statements over the SQL length limit can't be prepared, so they never load. That is
    // intended (lead decision 16 Oct 2026); refusals that need them say so.
    scratch.skippedLong = schemaSql.filter(
      (s) => Buffer.byteLength(s, 'utf8') > MAX_SQL_BYTES,
    ).length;
    const pageModule = this.createAll(scratch, schemaSql);
    if (pageModule !== undefined) {
      scratch.refusal = refuse(
        'schema',
        `The database schema declares a virtual table on ${pageModule}, which reads raw database pages, so the SQL gate refuses every statement for this database.`,
      );
      return scratch;
    }
    const names = db.selectValues("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')");
    const shadows = db.selectValues("SELECT name FROM pragma_table_list WHERE type = 'shadow'");
    scratch.relations = new Set(
      names.filter((n): n is string => typeof n === 'string').map(foldName),
    );
    const prefixes = [...scratch.virtualTables.keys()].map((v) => `${v}_`);
    scratch.shadowTables = new Set([
      ...shadows.filter((n): n is string => typeof n === 'string').map(foldName),
      ...[...scratch.relations].filter((r) => prefixes.some((p) => r.startsWith(p))),
    ]);
    this.mapTrees(scratch);
    return scratch;
  }

  /** Reads the scratch schema's b-trees and generated columns for the bytecode check. */
  private mapTrees(scratch: Scratch): void {
    const { db } = scratch;
    const rows = (sql: string, bind: (string | number)[] = []): unknown[][] =>
      db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'array' });
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
    const trees = new Map<number, BTree>();
    const generated = new Map<string, Map<string, Set<string>>>();
    const withoutRowid = new Set(
      rows("SELECT name FROM pragma_table_list WHERE schema = 'main' AND wr = 1").map((r) =>
        foldName(str(r[0])),
      ),
    );
    for (const [name, root, sql] of rows(
      "SELECT name, rootpage, sql FROM sqlite_schema WHERE type = 'table' AND rootpage > 0",
    )) {
      const table = foldName(str(name));
      const columns = rows('SELECT name, type, pk, hidden FROM pragma_table_xinfo(?)', [str(name)]);
      // Record order: stored columns as declared, then VIRTUAL generated ones (hidden = 2).
      const storage = [
        ...columns.filter((c) => num(c[3]) !== 2),
        ...columns.filter((c) => num(c[3]) === 2),
      ].map((c) => foldName(str(c[0])));
      const pks = columns.filter((c) => num(c[2]) > 0);
      const wr = withoutRowid.has(table);
      const only = pks.length === 1 ? pks[0] : undefined;
      const rowidAlias =
        !wr && only !== undefined && foldName(str(only[1])) === 'integer'
          ? foldName(str(only[0]))
          : undefined;
      trees.set(num(root), { kind: 'table', table, storage, rowidAlias, withoutRowid: wr });
      generated.set(table, generatedColumnRefs(str(sql)));
    }
    for (const [name, tbl, root] of rows(
      "SELECT name, tbl_name, rootpage FROM sqlite_schema WHERE type = 'index' AND rootpage > 0",
    )) {
      const columns = rows('SELECT cid, name FROM pragma_index_xinfo(?) WHERE key = 1', [
        str(name),
      ]).map((c) => (num(c[0]) < 0 ? '' : foldName(str(c[1]))));
      const partial = rows('SELECT partial FROM pragma_index_list(?) WHERE name = ?', [
        str(tbl),
        str(name),
      ]).some((r) => num(r[0]) === 1);
      trees.set(num(root), { kind: 'index', table: foldName(str(tbl)), columns, partial });
    }
    scratch.trees = trees;
    scratch.generated = generated;
  }

  /**
   * The hidden columns plus every generated column computed, directly or through other
   * generated columns, from one of them (SG-3).
   */
  private expandHidden(scratch: Scratch, hidden: readonly HiddenColumn[]): HiddenColumns {
    const byTable = new Map<string, Set<string>>();
    for (const h of hidden) {
      const table = foldName(h.table);
      const columns = byTable.get(table) ?? new Set<string>();
      columns.add(foldName(h.column));
      byTable.set(table, columns);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const [table, generated] of scratch.generated) {
        const columns = byTable.get(table);
        if (columns === undefined) continue;
        for (const [column, refs] of generated) {
          if (columns.has(column)) continue;
          if ([...refs].some((ref) => columns.has(ref))) {
            columns.add(column);
            grew = true;
          }
        }
      }
    }
    return byTable;
  }

  /** Lists the compiled program (EXPLAIN only lists it; nothing runs). */
  private listProgram(stmt: number): Op[] | undefined {
    const { capi } = this.sqlite;
    if (capi.sqlite3_stmt_explain(stmt, 1) !== SQLITE_OK) return undefined;
    const ops: Op[] = [];
    try {
      while (capi.sqlite3_step(stmt) === capi.SQLITE_ROW) {
        ops.push({
          opcode: capi.sqlite3_column_text(stmt, 1),
          p1: capi.sqlite3_column_int(stmt, 2),
          p2: capi.sqlite3_column_int(stmt, 3),
          p3: capi.sqlite3_column_int(stmt, 4),
        });
      }
      return ops;
    } finally {
      capi.sqlite3_reset(stmt);
    }
  }

  /**
   * Accepts only single CREATE TABLE/INDEX/VIEW/TRIGGER/VIRTUAL TABLE statements in the
   * main schema; anything else is skipped. Retries in passes, since sqlite_schema order
   * can put an index before its table.
   */
  /** Returns the page-reading module when the schema declares one (SG-7). */
  private createAll(scratch: Scratch, schemaSql: readonly string[]): string | undefined {
    let pending = [...schemaSql];
    for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
      const retry: string[] = [];
      for (const sql of pending) {
        const outcome = this.createOne(scratch, sql);
        if (typeof outcome === 'object') return outcome.pageModule;
        if (outcome === 'retry') retry.push(sql);
      }
      if (retry.length === pending.length) break;
      pending = retry;
    }
    return undefined;
  }

  private createOne(
    scratch: Scratch,
    sql: string,
  ): 'done' | 'skip' | 'retry' | { pageModule: string } {
    const { capi } = this.sqlite;
    const db = scratch.db;
    const seen = newSeen();
    // Set inside the callback: a virtual table to replace with a plain stand-in.
    const flags = { standIn: false };
    let outcome: ReturnType<GuardEngine['createOne']> = 'skip';
    this.policy = { kind: 'schema', seen };
    try {
      outcome = this.withStatement(db, sql, (stmt, rc, tailIsEmpty) => {
        if (seen.denial !== undefined) return 'skip';
        if (rc !== SQLITE_OK) return 'retry';
        if (stmt === 0 || seen.creates === 0 || !tailIsEmpty()) return 'skip';
        const vtab = seen.vtab;
        if (vtab !== undefined) {
          if (PAGE_MODULES.has(vtab.module)) return { pageModule: vtab.module };
          scratch.virtualTables.set(lower(vtab.name), vtab.module);
          const content = virtualTableOptions(sql).get('content');
          if (content !== undefined && content !== '') {
            scratch.contentTables.set(lower(vtab.name), foldName(content));
          }
          if (!VTAB_MODULES.has(vtab.module)) {
            flags.standIn = true;
            return 'skip';
          }
        }
        this.policy = { kind: 'off' };
        const stepped = capi.sqlite3_step(stmt);
        if (stepped === capi.SQLITE_DONE) return 'done';
        const message = capi.sqlite3_errmsg(db.pointer ?? 0);
        if (vtab !== undefined && message.startsWith('no such module:')) {
          flags.standIn = true;
          return 'skip';
        }
        return message.includes('already exists') ? 'skip' : 'retry';
      });
    } catch {
      outcome = 'skip';
    } finally {
      this.policy = { kind: 'off' };
    }
    if (flags.standIn) return this.plainTableFor(scratch, sql);
    return outcome;
  }

  /** A virtual table the gate won't or can't run becomes a plain table of its columns. */
  private plainTableFor(scratch: Scratch, sql: string): ReturnType<GuardEngine['createOne']> {
    const parsed = virtualTableColumns(sql);
    if (parsed === undefined || parsed.columns.length === 0) return 'skip';
    const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
    const create = `CREATE TABLE ${quote(parsed.table)} (${parsed.columns.map(quote).join(', ')})`;
    return this.createOne(scratch, create);
  }
}
