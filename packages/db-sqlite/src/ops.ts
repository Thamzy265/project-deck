/**
 * Reads a snapshot image with sqlite-wasm: schema, queries, diff hashes and rows by
 * key. Runs inside the snapshot worker (worker.ts), which the daemon terminates when a
 * call passes its budget, so nothing here needs to stop itself in time.
 *
 * The image is opened read-only (SQLITE_DESERIALIZE_READONLY plus query_only), every
 * query must be one read-only statement (the daemon's gate already checked it; this is
 * the second, independent check, ADR 0005), and replies are capped like the app's.
 */
import type {
  Cell,
  ColumnInfo,
  KeyedRows,
  QueryResult,
  RowHashes,
  RowKey,
  TableInfo,
} from '@project-deck/core';
import { DbError, MAX_DIFF_ROWS_PER_TABLE, MAX_KEYS_PER_CALL } from '@project-deck/core';
import type { Sqlite3 } from './sqlite.js';

type Db = InstanceType<Sqlite3['oo1']['DB']>;

export interface OpenDb {
  sqlite: Sqlite3;
  db: Db;
}

/** Most rows one reply holds, as in flutterdeck_drift. */
export const MAX_ROWS = 5000;
/** Most bytes one reply holds (design D6: 8 MB per reply). */
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** Largest single value SQLite may build while reading (as in the app). */
const LENGTH_LIMIT = 16 * 1024 * 1024;
/** Bytes of a blob sent as base64; the size is always sent. */
const BLOB_PREVIEW = 64 * 1024;
/** All of SQLite's memory in the worker: a 50 MB copy and room to read it. */
const HEAP_LIMIT = 192 * 1024 * 1024;
const SQLITE_NOMEM = 7;
/** Diff hashes for all tables together (D6: 50 MB total). */
const MAX_HASH_BYTES = 50 * 1024 * 1024;

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const T_INTEGER = 1;
const T_FLOAT = 2;
const T_TEXT = 3;
const T_BLOB = 4;

/** Opens a database image read-only. The engine owns a copy of the bytes. */
export function openImage(sqlite: Sqlite3, bytes: Uint8Array): OpenDb {
  const { capi, wasm, oo1 } = sqlite;
  const db = new oo1.DB();
  const pointer = db.pointer ?? 0;
  // Caps all of SQLite's memory in this worker, the copy included, so a query that
  // builds many large values fails with SQLITE_NOMEM instead of growing the wasm heap
  // (R4). The build exports no sqlite3_hard_heap_limit64; the pragma sets the same.
  db.exec(`PRAGMA hard_heap_limit = ${HEAP_LIMIT}`);
  const mem = wasm.allocFromTypedArray(new Uint8Array(bytes));
  const rc = capi.sqlite3_deserialize(
    pointer,
    'main',
    mem,
    bytes.length,
    bytes.length,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY,
  );
  if (rc !== SQLITE_OK) {
    db.close();
    throw new DbError('unsupported', "FlutterDeck couldn't open this database file.");
  }
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, LENGTH_LIMIT);
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_SQL_LENGTH, 100_000);
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, 0);
  db.exec('PRAGMA query_only = 1');
  // The second, independent check (ADR 0005): whatever passed the daemon's gate, this
  // connection never changes a setting, starts a transaction or adds a database.
  capi.sqlite3_set_authorizer(
    pointer,
    (_ctx, action, arg1, arg2) => authorize(action, arg1, arg2),
    0,
  );
  try {
    db.exec('SELECT count(*) FROM sqlite_schema');
  } catch {
    db.close();
    throw new DbError('unsupported', "This file isn't a readable SQLite database.");
  }
  return { sqlite, db };
}

// Authorizer action codes (sqlite3.h).
const A_PRAGMA = 19;
const A_TRANSACTION = 22;
const A_ATTACH = 24;
const A_DETACH = 25;
const A_SAVEPOINT = 32;
const SQLITE_DENY = 1;
/** Pragmas that read with an argument, as in the gate's allowlist. */
const READ_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'foreign_key_list',
]);

function authorize(action: number, arg1: string | 0, arg2: string | 0): number {
  if ([A_TRANSACTION, A_SAVEPOINT, A_ATTACH, A_DETACH].includes(action)) return SQLITE_DENY;
  if (action === A_PRAGMA && typeof arg2 === 'string') {
    const name = typeof arg1 === 'string' ? asciiLower(arg1) : '';
    return READ_PRAGMAS.has(name) ? SQLITE_OK : SQLITE_DENY;
  }
  return SQLITE_OK;
}

export function closeImage(open: OpenDb): void {
  open.db.close();
}

// FNV-1a, 64 bit, in two 32-bit halves: the same hash as flutterdeck_drift's
// cellHash, so the two backends' hashes mean the same thing.
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;

class Fnv {
  hi = FNV_OFFSET_HI;
  lo = FNV_OFFSET_LO;

  add(byte: number): void {
    const lo = (this.lo ^ (byte & 0xff)) >>> 0;
    // h * 0x100000001b3 = h * 0x1b3 + (h << 40), modulo 2^64.
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x1_0000_0000);
    this.hi = (Math.imul(this.hi, 0x1b3) + carry + (lo << 8)) >>> 0;
    this.lo = loProduct >>> 0;
  }

  addBytes(bytes: Uint8Array, from = 0, to = bytes.length): void {
    // The same steps as add(), inlined: this loop runs for every byte of a diff (L3).
    let { hi, lo } = this;
    for (let i = from; i < to; i++) {
      const x = (lo ^ (bytes[i] ?? 0)) >>> 0;
      const product = x * 0x1b3;
      hi = (Math.imul(hi, 0x1b3) + Math.floor(product / 0x1_0000_0000) + (x << 8)) >>> 0;
      lo = product >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
  }

  hex(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0');
  }
}

/** A value as SQLite gives it: bigint for INTEGER, number for REAL. */
export type SqlValue = bigint | number | string | Uint8Array | null;

/** A 64-bit hash of a value with its SQLite type, as 16 hex digits (as in the app). */
export function cellHash(value: SqlValue): string {
  const h = new Fnv();
  const eight = new DataView(new ArrayBuffer(8));
  if (value === null) {
    h.add(5);
  } else if (typeof value === 'bigint') {
    h.add(1);
    eight.setBigInt64(0, value);
    h.addBytes(new Uint8Array(eight.buffer));
  } else if (typeof value === 'number') {
    h.add(2);
    eight.setFloat64(0, value);
    h.addBytes(new Uint8Array(eight.buffer));
  } else if (typeof value === 'string') {
    h.add(3);
    h.addBytes(Buffer.from(value, 'utf8'));
  } else {
    h.add(4);
    h.addBytes(value);
  }
  return h.hex();
}

/** A value as JSON without losing type or digits (as flutterdeck_drift's encodeCell). */
function encode(value: SqlValue, wholeBlob: boolean): Cell {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return { type: 'int', value: value.toString() };
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return {
      type: 'real',
      value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity',
    };
  }
  const cut = !wholeBlob && value.length > BLOB_PREVIEW;
  return {
    type: 'blob',
    bytes: value.length,
    base64: Buffer.from(cut ? value.subarray(0, BLOB_PREVIEW) : value).toString('base64'),
    ...(cut ? { truncated: true } : {}),
  };
}

interface Statement {
  stmt: number;
  columns: string[];
}

/**
 * Prepares exactly one statement, runs `use`, and always finalizes it. Leading empty
 * statements (a lone `;`) are skipped; anything after the statement but whitespace and
 * comments is refused, so a second statement never runs.
 */
function withStatement<T>(open: OpenDb, sql: string, use: (s: Statement) => T): T {
  const { capi, wasm } = open.sqlite;
  const pointer = open.db.pointer ?? 0;
  const stack = wasm.pstack.pointer;
  const [start, length] = wasm.allocCString(sql, true);
  const end = start + length;
  let stmt = 0;
  try {
    const ppStmt = wasm.pstack.allocPtr();
    const pzTail = wasm.pstack.allocPtr();
    const prepare = (from: number): { rc: number; stmt: number; tail: number } => {
      const rc = capi.sqlite3_prepare_v3(pointer, from, end - from, 0, ppStmt, pzTail);
      return { rc, stmt: wasm.peekPtr(ppStmt), tail: wasm.peekPtr(pzTail) };
    };
    let at = start;
    let first = prepare(at);
    while (first.rc === SQLITE_OK && first.stmt === 0 && first.tail > at && first.tail < end) {
      at = first.tail;
      first = prepare(at);
    }
    stmt = first.stmt;
    if (first.rc !== SQLITE_OK) {
      if (open.sqlite.capi.sqlite3_errmsg(pointer) === 'not authorized') {
        throw new DbError(
          'refused',
          'Only reading queries run here: this one changes a setting, a transaction or the databases.',
        );
      }
      throw sqlError(open);
    }
    if (stmt === 0) throw new DbError('refused', 'There is no statement to run.');
    let from = first.tail;
    while (from > 0 && from < end) {
      const next = prepare(from);
      if (next.stmt !== 0) capi.sqlite3_finalize(next.stmt);
      if (next.rc !== SQLITE_OK || next.stmt !== 0) {
        throw new DbError('refused', 'Only one statement runs at a time.');
      }
      if (next.tail <= from) break;
      from = next.tail;
    }
    const count = capi.sqlite3_column_count(stmt);
    const columns = Array.from({ length: count }, (_, i) => capi.sqlite3_column_name(stmt, i));
    return use({ stmt, columns });
  } finally {
    if (stmt !== 0) capi.sqlite3_finalize(stmt);
    wasm.dealloc(start);
    wasm.pstack.restore(stack);
  }
}

function sqlError(open: OpenDb): DbError {
  const pointer = open.db.pointer ?? 0;
  if (open.sqlite.capi.sqlite3_errcode(pointer) === SQLITE_NOMEM) {
    return new DbError(
      'too-large',
      'That query needed more memory than FlutterDeck allows, so it was stopped.',
    );
  }
  const message = open.sqlite.capi.sqlite3_errmsg(pointer);
  return new DbError('sql-error', message.slice(0, 500));
}

// The JS-value forms of bind_text and bind_blob fail in this build (a ReferenceError
// inside the binding), so the bytes are copied into wasm memory here and SQLite frees
// them (SQLITE_WASM_DEALLOC).
function bindText(open: OpenDb, stmt: number, index: number, text: string): number {
  const { capi, wasm } = open.sqlite;
  const [p, n] = wasm.allocCString(text, true);
  return capi.sqlite3_bind_text(stmt, index, p, n, capi.SQLITE_WASM_DEALLOC);
}

function bindBlob(open: OpenDb, stmt: number, index: number, bytes: Uint8Array): number {
  const { capi, wasm } = open.sqlite;
  // A zero-length blob still needs a real pointer: a null one would bind NULL.
  const p = wasm.allocFromTypedArray(bytes.length === 0 ? new Uint8Array(1) : bytes);
  return capi.sqlite3_bind_blob(stmt, index, p, bytes.length, capi.SQLITE_WASM_DEALLOC);
}

/** Binds one parameter: JSON scalars, booleans as 0/1, and tagged int, real and blob cells. */
export function bind(open: OpenDb, stmt: number, index: number, value: unknown): void {
  const { capi } = open.sqlite;
  let rc: number;
  if (value === null || value === undefined) {
    // This build's sqlite3_bind_null answers undefined instead of SQLITE_OK (TAB-3).
    const r: unknown = capi.sqlite3_bind_null(stmt, index);
    rc = typeof r === 'number' ? r : SQLITE_OK;
  } else if (typeof value === 'boolean') rc = capi.sqlite3_bind_int64(stmt, index, value ? 1n : 0n);
  else if (typeof value === 'number') {
    rc = Number.isSafeInteger(value)
      ? capi.sqlite3_bind_int64(stmt, index, BigInt(value))
      : capi.sqlite3_bind_double(stmt, index, value);
  } else if (typeof value === 'string') {
    rc = bindText(open, stmt, index, value);
  } else if (typeof value === 'object' && 'type' in value) {
    const tagged = value as { type: unknown; value?: unknown; base64?: unknown };
    if (
      tagged.type === 'int' &&
      typeof tagged.value === 'string' &&
      /^-?\d{1,20}$/.test(tagged.value)
    ) {
      rc = capi.sqlite3_bind_int64(stmt, index, BigInt(tagged.value));
    } else if (tagged.type === 'real' && typeof tagged.value === 'string') {
      const real = { Infinity: Infinity, '-Infinity': -Infinity, NaN: Number.NaN }[tagged.value];
      if (real === undefined) throw new DbError('refused', 'A parameter has an unknown value.');
      rc = capi.sqlite3_bind_double(stmt, index, real);
    } else if (tagged.type === 'blob' && typeof tagged.base64 === 'string') {
      rc = bindBlob(open, stmt, index, new Uint8Array(Buffer.from(tagged.base64, 'base64')));
    } else {
      throw new DbError('refused', 'A parameter has an unknown type.');
    }
  } else {
    throw new DbError('refused', 'A parameter has an unknown type.');
  }
  if (rc !== SQLITE_OK) throw sqlError(open);
}

function value(open: OpenDb, stmt: number, i: number): SqlValue {
  const { capi, wasm } = open.sqlite;
  switch (capi.sqlite3_column_type(stmt, i)) {
    case T_INTEGER:
      return capi.sqlite3_column_int64(stmt, i);
    case T_FLOAT:
      return capi.sqlite3_column_double(stmt, i);
    case T_TEXT:
      return capi.sqlite3_column_text(stmt, i);
    case T_BLOB: {
      const p = capi.sqlite3_column_blob(stmt, i);
      const n = capi.sqlite3_column_bytes(stmt, i);
      return p === 0 ? new Uint8Array(0) : wasm.heap8u().slice(p, p + n);
    }
    default:
      return null;
  }
}

/**
 * One row for a reply, cell by cell, or undefined when the next cell would pass
 * `room` bytes. Sizes are read with sqlite3_column_bytes before anything is copied,
 * and a blob's bytes are copied only up to the preview (R4).
 */
function replyRow(
  open: OpenDb,
  s: Statement,
  room: number,
): { row: Cell[]; bytes: number } | undefined {
  const { capi, wasm } = open.sqlite;
  const row: Cell[] = [];
  let bytes = 2;
  for (let i = 0; i < s.columns.length; i++) {
    const type = capi.sqlite3_column_type(s.stmt, i);
    if (type === T_BLOB) {
      const n = capi.sqlite3_column_bytes(s.stmt, i);
      const shown = Math.min(n, BLOB_PREVIEW);
      bytes += Math.ceil(shown / 3) * 4 + 48;
      if (bytes > room) return undefined;
      const p = capi.sqlite3_column_blob(s.stmt, i);
      const preview = p === 0 ? new Uint8Array(0) : wasm.heap8u().slice(p, p + shown);
      row.push({
        type: 'blob',
        bytes: n,
        base64: Buffer.from(preview).toString('base64'),
        ...(shown < n ? { truncated: true } : {}),
      });
      continue;
    }
    // UTF-8 bytes; JSON adds quotes and escapes, which the slack in the cap covers.
    bytes += type === T_TEXT ? capi.sqlite3_column_bytes(s.stmt, i) + 2 : 24;
    if (bytes > room) return undefined;
    row.push(encode(value(open, s.stmt, i), false));
  }
  return { row, bytes };
}

/** Steps once: true for a row, false when done; throws on an error. */
function step(open: OpenDb, s: Statement): boolean {
  const rc = open.sqlite.capi.sqlite3_step(s.stmt);
  if (rc === SQLITE_ROW) return true;
  if (rc === SQLITE_DONE) return false;
  throw sqlError(open);
}

/** Steps a prepared statement, calling `row` for each row until it returns false. */
function stepAll(open: OpenDb, s: Statement, row: (values: SqlValue[]) => boolean): void {
  const { capi } = open.sqlite;
  for (;;) {
    const rc = capi.sqlite3_step(s.stmt);
    if (rc === SQLITE_DONE) return;
    if (rc !== SQLITE_ROW) throw sqlError(open);
    const values = s.columns.map((_, i) => value(open, s.stmt, i));
    if (!row(values)) return;
  }
}

/** Runs a fixed internal read and returns its rows. */
function select(open: OpenDb, sql: string, params: unknown[] = []): SqlValue[][] {
  return withStatement(open, sql, (s) => {
    params.forEach((p, i) => bind(open, s.stmt, i + 1, p));
    const rows: SqlValue[][] = [];
    stepAll(open, s, (values) => rows.push(values) > 0);
    return rows;
  });
}

const text = (v: SqlValue | undefined): string => (typeof v === 'string' ? v : '');
const int = (v: SqlValue | undefined): number =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0;

/** A name in double quotes, safe in SQL whatever it holds. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** SQLite folds ASCII letters only when it compares names. */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

interface Entity {
  name: string;
  type: 'table' | 'view' | 'virtual' | 'shadow';
  sql: string | undefined;
  withoutRowid: boolean;
}

function entities(open: OpenDb): Entity[] {
  return select(
    open,
    "SELECT l.name, l.type, s.sql, l.wr FROM pragma_table_list l JOIN sqlite_schema s ON s.name = l.name WHERE l.schema = 'main' AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY l.name",
  ).map(([name, type, sql, wr]) => ({
    name: text(name),
    type: text(type) as Entity['type'],
    sql: typeof sql === 'string' ? sql : undefined,
    withoutRowid: int(wr) === 1,
  }));
}

interface XColumn {
  name: string;
  type: string;
  notnull: boolean;
  default: string | null;
  pk: number;
  hidden: number;
}

function columnsOf(open: OpenDb, table: string): XColumn[] {
  return select(
    open,
    'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)',
    [table],
  )
    .map(([name, type, notnull, dflt, pk, hidden]) => ({
      name: text(name),
      type: text(type),
      notnull: int(notnull) === 1,
      default:
        typeof dflt === 'string' ? dflt : dflt === null || dflt === undefined ? null : String(dflt),
      pk: int(pk),
      hidden: int(hidden),
    }))
    .filter((c) => c.hidden !== 1);
}

/** An INTEGER PRIMARY KEY of a rowid table is the rowid and can never hold NULL. */
function neverNull(c: XColumn, pkCount: number, withoutRowid: boolean): boolean {
  return withoutRowid || (c.pk > 0 && pkCount === 1 && c.type.toUpperCase() === 'INTEGER');
}

/** The tables and views (with columns, keys, indexes and row counts) and the schema SQL. */
export function schema(open: OpenDb): { tables: TableInfo[]; sqlSchema: string[] } {
  const tables: TableInfo[] = [];
  for (const e of entities(open)) {
    if (e.type !== 'table' && e.type !== 'view' && e.type !== 'virtual') continue;
    const kind = e.type === 'view' ? ('view' as const) : ('table' as const);
    const base = { name: e.name, kind, ...(e.sql === undefined ? {} : { sql: e.sql }) };
    try {
      const cols = columnsOf(open, e.name);
      const pkCount = cols.filter((c) => c.pk > 0).length;
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: !c.notnull && !neverNull(c, pkCount, e.withoutRowid),
        pk: c.pk > 0,
        ...(c.pk > 0 ? { pkPosition: c.pk } : {}),
        default: c.default,
      }));
      const foreignKeys = select(
        open,
        'SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)',
        [e.name],
      ).map(([from, table, to]) => ({
        from: text(from),
        table: text(table),
        to: typeof to === 'string' ? to : null,
      }));
      const indexes = select(open, 'SELECT name, "unique" FROM pragma_index_list(?)', [e.name]).map(
        ([name, unique]) => ({
          name: text(name),
          unique: int(unique) === 1,
          columns: select(open, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', [
            text(name),
          ])
            .map(([n]) => n)
            .filter((n): n is string => typeof n === 'string'),
        }),
      );
      const rowCount =
        kind === 'table'
          ? int(select(open, `SELECT count(*) FROM main.${quoteIdent(e.name)}`)[0]?.[0])
          : undefined;
      tables.push({
        ...base,
        columns,
        foreignKeys,
        indexes,
        ...(rowCount === undefined ? {} : { rowCount }),
      });
    } catch (err) {
      tables.push({
        ...base,
        columns: [],
        foreignKeys: [],
        indexes: [],
        error: {
          code: 'unsupported',
          message: `FlutterDeck can't read ${e.name}: ${errText(err)}`,
        },
      });
    }
  }
  return { tables, sqlSchema: sqlSchema(open) };
}

/** Every CREATE statement in schema order, for the read-only gate. No row counts. */
export function sqlSchema(open: OpenDb): string[] {
  return select(open, 'SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid').map(
    ([s]) => text(s),
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}

/** Runs one reading statement and returns at most `limit` rows within 8 MB. */
export function query(open: OpenDb, sql: string, params: unknown[], limit: number): QueryResult {
  const started = performance.now();
  const cap = Math.min(Math.max(Math.trunc(limit), 1), MAX_ROWS);
  return withStatement(open, sql, (s) => {
    const { capi } = open.sqlite;
    const explain = capi.sqlite3_stmt_isexplain(s.stmt) !== 0;
    if (!explain && capi.sqlite3_stmt_readonly(s.stmt) === 0) {
      throw new DbError('refused', 'Only reading queries run here: this one would change data.');
    }
    params.forEach((p, i) => bind(open, s.stmt, i + 1, p));
    const rows: Cell[][] = [];
    let bytes = 0;
    let truncated = false;
    while (step(open, s)) {
      if (rows.length === cap) {
        truncated = true;
        break;
      }
      const next = replyRow(open, s, MAX_REPLY_BYTES - bytes);
      if (next === undefined) {
        truncated = true;
        break;
      }
      bytes += next.bytes;
      rows.push(next.row);
    }
    return { columns: s.columns, rows, truncated, durationMs: performance.now() - started };
  });
}

interface KeyShape {
  key: string[];
  rowid: boolean;
  columns: string[];
}

function keyOf(open: OpenDb, e: Entity): KeyShape {
  const cols = columnsOf(open, e.name);
  const columns = cols.map((c) => c.name);
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const mayBeNull = pk.some((c) => !c.notnull && !neverNull(c, pk.length, e.withoutRowid));
  if (pk.length > 0 && !mayBeNull) return { key: pk.map((c) => c.name), rowid: false, columns };
  const lower = new Set(columns.map(asciiLower));
  for (const alias of ['rowid', '_rowid_', 'oid']) {
    if (!e.withoutRowid && !lower.has(alias)) return { key: [alias], rowid: true, columns };
  }
  throw new DbError('unsupported', `${e.name} has no primary key and hides its row id`);
}

/**
 * cellHash of column `i` of the current row, read straight from SQLite's memory: text
 * and blobs are hashed as their bytes, never decoded to JS strings or copied (L3).
 */
function columnHash(open: OpenDb, stmt: number, i: number): string {
  const { capi, wasm } = open.sqlite;
  const type = capi.sqlite3_column_type(stmt, i);
  if (type !== T_TEXT && type !== T_BLOB) return cellHash(value(open, stmt, i));
  // column_blob on a TEXT value gives its UTF-8 bytes, the same bytes cellHash hashes.
  const p = capi.sqlite3_column_blob(stmt, i);
  const n = capi.sqlite3_column_bytes(stmt, i);
  const h = new Fnv();
  h.add(type === T_TEXT ? 3 : 4);
  if (p !== 0) h.addBytes(wasm.heap8u(), p, p + n);
  return h.hex();
}

/** Steps a statement, handing `row` the first `count` values of each row only. */
function stepKeys(
  open: OpenDb,
  s: Statement,
  count: number,
  row: (values: SqlValue[]) => boolean,
): void {
  for (;;) {
    if (!step(open, s)) return;
    const values = Array.from({ length: count }, (_, i) => value(open, s.stmt, i));
    if (!row(values)) return;
  }
}

function keyCell(values: SqlValue[]): RowKey {
  const cells = values.map((v) => encode(v, true));
  return cells.length === 1 ? (cells[0] ?? null) : cells;
}

/** Per table, each row's key and one hash per column (design note D5). */
export function hashes(open: OpenDb): RowHashes {
  const tables: RowHashes['tables'] = [];
  let total = 0;
  for (const e of entities(open)) {
    if (e.type !== 'table') continue;
    try {
      const shape = keyOf(open, e);
      const sql = `SELECT ${[...shape.key, ...shape.columns].map(quoteIdent).join(', ')} FROM main.${quoteIdent(e.name)} LIMIT ${MAX_DIFF_ROWS_PER_TABLE + 1}`;
      const rows: [RowKey, string[]][] = [];
      const scan = { tooLarge: false };
      withStatement(open, sql, (s) =>
        stepKeys(open, s, shape.key.length, (values) => {
          if (rows.length === MAX_DIFF_ROWS_PER_TABLE) {
            scan.tooLarge = true;
            return false;
          }
          const entry: [RowKey, string[]] = [
            keyCell(values),
            shape.columns.map((_, i) => columnHash(open, s.stmt, shape.key.length + i)),
          ];
          total += JSON.stringify(entry[0]).length + entry[1].length * 19;
          if (total > MAX_HASH_BYTES) {
            throw new DbError('too-large', 'Too large to diff: the snapshot is over 50 MB.');
          }
          rows.push(entry);
          return true;
        }),
      );
      if (scan.tooLarge) {
        tables.push({
          name: e.name,
          error: {
            code: 'too-large',
            message: `Too large to compare: more than ${MAX_DIFF_ROWS_PER_TABLE.toLocaleString('en')} rows in ${e.name}`,
          },
        });
        continue;
      }
      tables.push({
        name: e.name,
        columns: shape.columns,
        key: shape.key,
        ...(shape.rowid ? { rowid: true } : {}),
        rows,
      });
    } catch (err) {
      if (err instanceof DbError && err.message.includes('over 50 MB')) throw err;
      tables.push({
        name: e.name,
        error: {
          code: err instanceof DbError ? err.code : 'unsupported',
          message: `FlutterDeck can't read ${e.name}: ${errText(err)}`,
        },
      });
    }
  }
  return { takenAt: Date.now(), tables };
}

/** Current values of the rows with these keys, read by key. */
export function rowsByKey(open: OpenDb, table: string, keys: RowKey[]): KeyedRows {
  if (keys.length > MAX_KEYS_PER_CALL) {
    throw new DbError('too-large', `At most ${MAX_KEYS_PER_CALL} rows can be read at once.`);
  }
  const wanted = asciiLower(table);
  const e = entities(open).find((x) => x.type === 'table' && asciiLower(x.name) === wanted);
  if (e === undefined) throw new DbError('not-found', `No table named ${table}`);
  const shape = keyOf(open, e);
  const where = shape.key.map((k) => `${quoteIdent(k)} IS ?`).join(' AND ');
  const sql = `SELECT ${shape.columns.map(quoteIdent).join(', ')} FROM main.${quoteIdent(e.name)} WHERE ${where}`;
  return withStatement(open, sql, (s) => {
    const { capi } = open.sqlite;
    const rows: [RowKey, Cell[]][] = [];
    const missing: RowKey[] = [];
    let bytes = 0;
    let truncated = false;
    for (const key of keys) {
      const parts = shape.key.length === 1 ? [key] : key;
      if (!Array.isArray(parts) || parts.length !== shape.key.length) {
        throw new DbError('refused', 'A key has the wrong number of values.');
      }
      capi.sqlite3_reset(s.stmt);
      capi.sqlite3_clear_bindings(s.stmt);
      parts.forEach((p, i) => bind(open, s.stmt, i + 1, p));
      if (!step(open, s)) {
        missing.push(key);
        continue;
      }
      const found = replyRow(open, s, MAX_REPLY_BYTES - bytes);
      if (found === undefined) {
        truncated = true;
        break;
      }
      bytes += found.bytes;
      rows.push([key, found.row]);
    }
    return {
      columns: shape.columns,
      key: shape.key,
      ...(shape.rowid ? { rowid: true } : {}),
      rows,
      missing,
      truncated,
    };
  });
}
