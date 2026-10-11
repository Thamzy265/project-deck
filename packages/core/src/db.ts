import { z } from 'zod';

export const ColumnInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  pk: z.boolean(),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

export const ForeignKeySchema = z.object({
  /** Column in this table. */
  from: z.string(),
  /** Referenced table. */
  table: z.string(),
  /** Referenced column. */
  to: z.string(),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;

export const TableInfoSchema = z.object({
  name: z.string(),
  columns: z.array(ColumnInfoSchema),
  rowCount: z.number().int().nonnegative().optional(),
  foreignKeys: z.array(ForeignKeySchema),
});
export type TableInfo = z.infer<typeof TableInfoSchema>;

export const QueryResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  /** True when more rows existed than the limit allowed. */
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 10_000;

export interface DbInspector {
  /** 'drift' | 'sqlite-file' | later 'room'. */
  readonly id: string;
  /** False for snapshot backends whose data can be stale. */
  readonly live: boolean;
  readonly writable: boolean;
  listDatabases(): Promise<{ name: string }[]>;
  schema(db: string): Promise<TableInfo[]>;
  query(
    db: string,
    sql: string,
    params?: unknown[],
    opts?: { limit?: number },
  ): Promise<QueryResult>;
  /** Present only on backends that can write. Callers enforce the read-only policy first. */
  execute?(db: string, sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Present only on live backends. Returns an unsubscribe function. */
  watch?(db: string, table: string, cb: () => void): () => void;
}
