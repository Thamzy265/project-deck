import { z } from 'zod';

export const ColumnInfoSchema = z.object({
  name: z.string(),
  /** The declared type as written in the schema; '' when none was given. */
  type: z.string(),
  nullable: z.boolean(),
  pk: z.boolean(),
  /** 1-based position in a primary key, present when `pk` is true. Diffs key rows by it. */
  pkPosition: z.number().int().positive().optional(),
  /** The default as SQL text (e.g. `'pending'`), or null when there is none. */
  default: z.string().nullable(),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

export const ForeignKeySchema = z.object({
  /** Column in this table. */
  from: z.string(),
  /** Referenced table. */
  table: z.string(),
  /** Referenced column; null when the key points at the referenced table's primary key. */
  to: z.string().nullable(),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;

export const IndexInfoSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
});
export type IndexInfo = z.infer<typeof IndexInfoSchema>;

export const TableInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(['table', 'view']),
  /** The CREATE statement from `sqlite_schema`. The gate uses `schemaSql()` instead. */
  sql: z.string().optional(),
  columns: z.array(ColumnInfoSchema),
  rowCount: z.number().int().nonnegative().optional(),
  foreignKeys: z.array(ForeignKeySchema),
  indexes: z.array(IndexInfoSchema),
  /**
   * Set when the backend could read this entry only in part: for example a view that calls an
   * app-defined function (columns empty), or a table too big to count (no rowCount). The
   * message is untrusted app text. Other tables are unaffected.
   */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type TableInfo = z.infer<typeof TableInfoSchema>;

/** One database an inspector can serve. */
export const DbInfoSchema = z.object({
  name: z.string(),
  /** live: read from the running app; snapshot: a copy of the file, possibly stale. */
  backend: z.enum(['live', 'snapshot']),
  /** Epoch milliseconds when the snapshot was taken; absent for live databases. */
  takenAt: z.number().int().nonnegative().optional(),
});
export type DbInfo = z.infer<typeof DbInfoSchema>;

/** An integer outside JavaScript's safe range, as decimal text so no digit is lost. */
export const BigIntCellSchema = z.object({
  type: z.literal('int'),
  value: z.string().regex(/^-?\d{1,20}$/),
});

/** A double JSON can't carry (Infinity, -Infinity, NaN), as text. */
export const RealCellSchema = z.object({
  type: z.literal('real'),
  // Literals, not z.enum: the enum's declaration file names '-Infinity' as a computed
  // key ([-Infinity]), which drops that value from the type packages see.
  value: z.union([z.literal('Infinity'), z.literal('-Infinity'), z.literal('NaN')]),
});

/** A blob is never sent whole: its size, and optionally the start of it as base64. */
export const BlobCellSchema = z.object({
  type: z.literal('blob'),
  bytes: z.number().int().nonnegative(),
  base64: z.string().optional(),
  /** True when `base64` holds only the start of the blob. */
  truncated: z.boolean().optional(),
});

/** One value in a result row, typed so blobs, big integers and odd doubles survive JSON. */
export const CellSchema = z.union([
  z.null(),
  z.number().refine(Number.isFinite, 'Not a finite number'),
  z.string(),
  BigIntCellSchema,
  RealCellSchema,
  BlobCellSchema,
]);
export type Cell = z.infer<typeof CellSchema>;

export const QueryResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(CellSchema)),
  /** True when more rows existed than the limit allowed. */
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

/** Rows a query returns when the caller gives no limit. */
export const DEFAULT_QUERY_LIMIT = 100;
/** Most rows one dashboard query (or page) may return. */
export const DASHBOARD_MAX_QUERY_LIMIT = 1000;
/** Most rows one MCP query may return to Claude. */
export const MCP_MAX_QUERY_LIMIT = 500;
/** Longest SQL text accepted anywhere (the gate also enforces this in bytes). */
export const MAX_SQL_LENGTH = 100_000;

/** Why a database call failed. The daemon maps these to HTTP statuses and UI copy. */
export const DbErrorCodeSchema = z.enum([
  /** No such database or table. */
  'not-found',
  /** This backend, app or platform can't do it (e.g. queries in Linux apps). */
  'unsupported',
  'timeout',
  /** The app is writing; try again. */
  'busy',
  /** Over a size cap (snapshot copy, schema, reply). */
  'too-large',
  /** The read-only gate or the app refused the statement. */
  'refused',
  /** SQLite reported an error; the message is SQLite's, untrusted app text. */
  'sql-error',
  /** A write without a valid single-use confirm token. */
  'bad-token',
  /** Writes are off, or this caller may not write. */
  'not-allowed',
  /** Something changed since the caller read it (a saved-queries revision). */
  'conflict',
  /** The app has no flutterdeck_drift: show the setup help. */
  'setup-needed',
  /** flutterdeck_drift speaks another protocol version. */
  'update-needed',
  /** The app stopped or was detached. */
  'app-gone',
  /** Android won't let anyone copy a release (not debuggable) app's files. */
  'not-debuggable',
  /** A tool (adb, xcrun) is missing or failed, or no device has the app. */
  'unavailable',
  /** More than one device or simulator has the app; the user must pick one. */
  'choose-device',
  'internal',
]);
export type DbErrorCode = z.infer<typeof DbErrorCodeSchema>;

const DB_ERROR = Symbol.for('project-deck.DbError');

/** A device or simulator the user can pick for a snapshot (`choose-device`). */
export const DbDeviceSchema = z.object({
  /** The adb serial or the simulator's UDID. */
  id: z.string().min(1).max(128),
  /** What the user sees: the serial, or the simulator's name. Untrusted device text. */
  name: z.string().max(200),
});
export type DbDevice = z.infer<typeof DbDeviceSchema>;

/** Most devices one `choose-device` answer lists. */
export const MAX_DB_DEVICES = 32;

export interface DbErrorExtra {
  /** A finer reason for the UI's copy, such as the read-only gate's refusal code. */
  detail?: string;
  /** With `choose-device`: the devices the user can pick from. */
  devices?: DbDevice[];
}

/** A failed database call. `message` is plain words, safe to show the user or Claude. */
export class DbError extends Error {
  readonly [DB_ERROR] = true;
  readonly detail: string | undefined;
  readonly devices: DbDevice[] | undefined;

  constructor(
    readonly code: DbErrorCode,
    message: string,
    extra: DbErrorExtra = {},
  ) {
    super(message);
    this.name = 'DbError';
    this.detail = extra.detail;
    this.devices = extra.devices;
  }
}

/** True for a DbError, also one made by another copy of this package. */
export function isDbError(err: unknown): err is DbError {
  return typeof err === 'object' && err !== null && DB_ERROR in err;
}

/**
 * A row's key: one cell, or one cell per column of a composite key. Blob cells in keys
 * carry the whole blob, so the key can be sent back to read the row.
 */
export const RowKeySchema = z.union([CellSchema, z.array(CellSchema).min(1).max(64)]);
export type RowKey = z.infer<typeof RowKeySchema>;

/** One 64-bit hash of a value with its SQLite type, as 16 hex digits. */
export const CellHashSchema = z.string().regex(/^[0-9a-f]{16}$/);

const TableErrorSchema = z.object({ code: z.string().max(64), message: z.string().max(2000) });

/** Per row, its key and one hash per column (design note D5). */
export const TableHashesSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  /** The key columns, or `rowid` for tables matched by row id. */
  key: z.array(z.string()).min(1),
  /** True when rows are matched by row id ("matched by row id" in the UI). */
  rowid: z.boolean().optional(),
  rows: z.array(z.tuple([RowKeySchema, z.array(CellHashSchema)])),
});
export type TableHashes = z.infer<typeof TableHashesSchema>;

/** A table the backend couldn't hash (too large, no usable key, unreadable). */
export const TableHashesErrorSchema = z.object({ name: z.string(), error: TableErrorSchema });

/** A diff snapshot: hashes only, never row values (old values are not kept, D5). */
export const RowHashesSchema = z.object({
  takenAt: z.number().int().nonnegative(),
  tables: z.array(z.union([TableHashesSchema, TableHashesErrorSchema])),
});
export type RowHashes = z.infer<typeof RowHashesSchema>;

/** Row values read by key, for the added and changed rows of a diff. */
export const KeyedRowsSchema = z.object({
  columns: z.array(z.string()),
  key: z.array(z.string()).min(1),
  rowid: z.boolean().optional(),
  rows: z.array(z.tuple([RowKeySchema, z.array(CellSchema)])),
  missing: z.array(RowKeySchema),
  /** True when the reply cap stopped the read before every key was answered. */
  truncated: z.boolean(),
});
export type KeyedRows = z.infer<typeof KeyedRowsSchema>;

/** Most keys one `rowsByKey` call takes. */
export const MAX_KEYS_PER_CALL = 1000;
/** Most rows per table a diff snapshot holds (D6); larger tables are "too large to diff". */
export const MAX_DIFF_ROWS_PER_TABLE = 10_000;

export interface DbQueryOptions {
  limit?: number;
  /**
   * The schema SQL the read-only gate judged the statement against. Snapshot backends
   * refuse to run it on a copy whose schema differs (the copy is pinned, R8).
   */
  checkedSchemaSql?: readonly string[];
}

export interface DbExecuteOptions {
  /**
   * Single-use confirm token (43 base64url characters) the daemon makes for one
   * confirmed edit. Backends refuse a write without one.
   */
  token?: string;
}

export interface DbInspector {
  /** 'drift' | 'sqlite-file' | later 'room'. */
  readonly id: string;
  /** False for snapshot backends whose data can be stale. */
  readonly live: boolean;
  readonly writable: boolean;
  listDatabases(): Promise<DbInfo[]>;
  schema(db: string): Promise<TableInfo[]>;
  /**
   * Every `sqlite_schema.sql` of the database, in schema order: tables, views, indexes
   * and triggers. The read-only gate loads exactly this (ADR 0005); TableInfo alone
   * can't give it indexes or triggers. Each call returns a fresh array the caller owns;
   * the gate copies it anyway, so changing it later can't confuse the gate's cache.
   */
  schemaSql(db: string): Promise<string[]>;
  /** Callers pass only SQL the read-only gate accepted. */
  query(db: string, sql: string, params?: unknown[], opts?: DbQueryOptions): Promise<QueryResult>;
  /** Present only on backends that can write. Callers enforce the write policy first. */
  execute?(
    db: string,
    sql: string,
    params?: unknown[],
    opts?: DbExecuteOptions,
  ): Promise<{ changes: number }>;
  /** Present only on live backends. Returns an unsubscribe function. */
  watch?(db: string, table: string, cb: () => void): () => void;
  /** Per table, a key and per-column hashes for every row (diff snapshots, D5). */
  rowHashes?(db: string): Promise<RowHashes>;
  /** Current values of the rows with these keys (at most MAX_KEYS_PER_CALL). */
  rowsByKey?(db: string, table: string, keys: RowKey[]): Promise<KeyedRows>;
  /**
   * Snapshot backends, after a `choose-device` answer: copy from this device (an adb
   * serial or a simulator UDID from that answer's list) from now on.
   */
  chooseDevice?(id: string): Promise<void>;
  /** Snapshot backends: drop the copy so the next call reads a fresh one. */
  refresh?(db: string): Promise<void>;
  /** Releases workers and subscriptions. Never touches the app. */
  close?(): Promise<void>;
}
