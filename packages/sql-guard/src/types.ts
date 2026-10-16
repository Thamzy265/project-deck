import { z } from 'zod';

/** read: Claude and the dashboard's queries. write: confirmed dashboard edits only. */
export type GuardMode = 'read' | 'write';

export interface HiddenColumn {
  table: string;
  column: string;
}

export interface GuardCheckOptions {
  /** The target database's CREATE statements (`sqlite_schema.sql`), in schema order. */
  schemaSql: readonly string[];
  mode: GuardMode;
  /**
   * Columns no statement may read in any way (db.hiddenColumns, design review S3).
   * Callers pass them for Claude's queries.
   */
  hiddenColumns?: readonly HiddenColumn[];
}

export const GuardRefusalCodeSchema = z.enum([
  'too-long',
  'empty',
  'multiple-statements',
  'invalid-sql',
  'writes-data',
  /** Write mode: a statement other than INSERT, UPDATE or DELETE. */
  'not-an-edit',
  /** Write mode: the edit (or a trigger it fires) writes to more than one table. */
  'multiple-tables',
  'transaction',
  'attach',
  'vacuum',
  'pragma',
  'function',
  'table',
  'hidden-column',
  'schema',
  'unavailable',
  'timeout',
]);
export type GuardRefusalCode = z.infer<typeof GuardRefusalCodeSchema>;

export const GuardResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    kind: z.enum(['select', 'explain', 'pragma', 'write']),
    /**
     * What the statement touches, for callers that weigh its cost (design review S2):
     * the gate only prepares, so a slow statement still passes. Runtime limits (row
     * caps, time limits, interrupts) live in the backends.
     */
    tables: z.array(z.string()),
    functions: z.array(z.string()),
    /** A recursive CTE, which can run long or forever without a LIMIT. */
    recursive: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: GuardRefusalCodeSchema,
    /** Plain words, safe to show the user or Claude. */
    reason: z.string(),
  }),
]);
export type GuardResult = z.infer<typeof GuardResultSchema>;
export type GuardRefusal = Extract<GuardResult, { ok: false }>;

/** Longest SQL text the gate judges, in UTF-8 bytes. */
export const MAX_SQL_BYTES = 100_000;
/** Bounds on the schema a caller may hand in. */
export const MAX_SCHEMA_STATEMENTS = 5000;
export const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
