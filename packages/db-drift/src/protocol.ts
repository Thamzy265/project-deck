/**
 * flutterdeck_drift's wire protocol, version 1 (dart/flutterdeck_drift/README.md,
 * "Protocol"; recorded examples in connector-dart's fixtures). Every reply is
 * untrusted app data and is validated here before anything uses it.
 */
import type { DbErrorCode } from '@project-deck/core';
import {
  DbError,
  KeyedRowsSchema,
  QueryResultSchema,
  RowHashesSchema,
  TableInfoSchema,
} from '@project-deck/core';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const EXTENSION_PREFIX = 'ext.flutterdeck.drift.v1.';
export const TABLES_EVENT = 'flutterdeck.drift.tables';

/** Names `FlutterDeckDrift.register` accepts. */
export const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const WRITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const Envelope = z.object({ protocol: z.number() }).loose();
const ErrorReply = z.object({
  error: z.object({ code: z.string().max(64), message: z.string().max(10_000) }),
});

export const ListReply = z.object({
  databases: z.array(z.object({ name: z.string().regex(DB_NAME) })).max(100),
});
export const SchemaReply = z.object({
  tables: z.array(TableInfoSchema),
  sqlSchema: z.array(z.string()),
  sqlSchemaTruncated: z.boolean().optional(),
});
export const QueryReply = QueryResultSchema;
export const SnapshotReply = RowHashesSchema;
export const RowsReply = KeyedRowsSchema;
export const ExecuteReply = z.object({ changes: z.number().int().nonnegative() });

export const TablesEvent = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  db: z.string().regex(DB_NAME),
  tables: z.array(z.object({ name: z.string().max(1024), kind: z.string().max(32) })).max(10_000),
});

export type Action = 'list' | 'schema' | 'query' | 'snapshot' | 'rows' | 'execute';

/** Control and bidi characters out, length capped: SQLite's message is app text. */
export function plainText(text: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The app's error reply as a DbError. Messages are FlutterDeck's own words, never the
 * app's, except SQLite's message for a SQL error, which the user needs to fix the SQL.
 */
function appError(action: Action, code: string, message: string, db: string): DbError {
  const map: Record<string, [DbErrorCode, string]> = {
    'unknown-db': ['not-found', `The app has no database named ${db}.`],
    'not-found': ['not-found', 'The app has no such table.'],
    'not-read-only': ['refused', 'Only reading queries run here. The app refused this one.'],
    'not-allowed': [
      'refused',
      'The app refused this change: an edit is one INSERT, UPDATE or DELETE on one table.',
    ],
    timeout: ['timeout', 'That query took too long and was stopped.'],
    busy: [
      'busy',
      action === 'execute'
        ? 'The app is busy with another read; try the change again.'
        : 'The app is writing all the time, so FlutterDeck could not read a copy. Try again, or turn on WAL.',
    ],
    'too-large': ['too-large', 'The answer is over 8 MB. Add a LIMIT or pick fewer columns.'],
    unsupported: [
      'unsupported',
      action === 'query'
        ? "This app's SQLite can't stop a slow query, so queries are off (Linux apps; see flutterdeck_drift's README). Tables and row details still work."
        : "FlutterDeck can't open this database: in-memory and encrypted databases are not supported.",
    ],
    'bad-token': [
      'bad-token',
      'The app refused the change: its confirm was missing or already used.',
    ],
    'bad-request': ['internal', "The app did not accept FlutterDeck's request."],
  };
  if (code === 'sql-error') return new DbError('sql-error', plainText(message));
  const [mapped, text] = map[code] ?? ['internal', "The app couldn't answer."];
  return new DbError(mapped, text);
}

/** Checks the envelope and protocol, then parses the body or throws a DbError. */
export function readReply<S extends z.ZodType>(
  action: Action,
  raw: unknown,
  schema: S,
  db: string,
): z.infer<S> {
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success)
    throw new DbError('internal', 'The app sent a reply FlutterDeck could not read.');
  if (envelope.data.protocol !== PROTOCOL_VERSION) {
    throw new DbError(
      'update-needed',
      `Update flutterdeck_drift: this FlutterDeck speaks protocol ${PROTOCOL_VERSION}.`,
    );
  }
  const error = ErrorReply.safeParse(raw);
  if (error.success) throw appError(action, error.data.error.code, error.data.error.message, db);
  const body = schema.safeParse(raw);
  if (!body.success)
    throw new DbError('internal', 'The app sent a reply FlutterDeck could not read.');
  return body.data;
}
