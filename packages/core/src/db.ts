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
  value: z.enum(['Infinity', '-Infinity', 'NaN']),
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
  query(
    db: string,
    sql: string,
    params?: unknown[],
    opts?: { limit?: number },
  ): Promise<QueryResult>;
  /** Present only on backends that can write. Callers enforce the write policy first. */
  execute?(db: string, sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Present only on live backends. Returns an unsubscribe function. */
  watch?(db: string, table: string, cb: () => void): () => void;
}
