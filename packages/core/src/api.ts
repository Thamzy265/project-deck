/**
 * Input schemas shared by the MCP server and the daemon's HTTP API,
 * so both validate requests the same way.
 */
import { z } from 'zod';
import {
  ActivityEntrySchema,
  MAX_RELOAD_MESSAGE,
  MAX_SESSION_ID,
  MAX_WAITING_MESSAGE,
} from './activity.js';
import { ReloadResultSchema, RunningAppSchema } from './apps.js';
import {
  CellSchema,
  DASHBOARD_MAX_QUERY_LIMIT,
  DbInfoSchema,
  MAX_SQL_LENGTH,
  MCP_MAX_QUERY_LIMIT,
  QueryResultSchema,
  TableInfoSchema,
} from './db.js';
import { LogEntrySchema, LogQuerySchema } from './logs.js';
import { TaskStatusTypeSchema } from './tasks.js';

const DbName = z.string().min(1).max(128);
const Sql = z.string().min(1).max(MAX_SQL_LENGTH);
const SqlParams = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(1000);
const SnapshotId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('Snapshot id from db_snapshot');
const TaskKey = z.string().min(1).max(64);

export const GetLogsInput = LogQuerySchema;

/** `db_list` and `GET /api/db`: no arguments. */
export const DbListInput = z.object({});

export const DbSchemaInput = z.object({ db: DbName });

/**
 * Builds the query input with its own row cap: the dashboard and Claude get different
 * caps (DASHBOARD_MAX_QUERY_LIMIT, MCP_MAX_QUERY_LIMIT) over the same shape.
 */
export function makeDbQueryInput(maxLimit: number) {
  if (!Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit > DASHBOARD_MAX_QUERY_LIMIT) {
    throw new RangeError(`Query limit cap must be 1 to ${DASHBOARD_MAX_QUERY_LIMIT}`);
  }
  return z.object({
    db: DbName,
    sql: Sql,
    params: SqlParams.optional(),
    limit: z.number().int().positive().max(maxLimit).optional(),
  });
}

/** `POST /api/db/query` from the dashboard. */
export const DbQueryInput = makeDbQueryInput(DASHBOARD_MAX_QUERY_LIMIT);
/** The `db_query` MCP tool. */
export const McpDbQueryInput = makeDbQueryInput(MCP_MAX_QUERY_LIMIT);

/**
 * `POST /api/db/execute`, dashboard edits only (PM decision, 16 Oct 2026: Claude never
 * writes in M3, so there is no MCP tool for it). Needs `db.allowWrites` and a confirm.
 */
export const DbExecuteInput = z.object({
  db: DbName,
  sql: Sql,
  params: SqlParams.optional(),
});

export const DbSnapshotInput = z.object({
  db: DbName,
  label: z.string().max(128).optional(),
});

export const DbDiffInput = z.object({
  db: DbName,
  /** Snapshot to compare against the current state; the latest one when absent. */
  snapshotId: SnapshotId.optional(),
});

/** Answer of `GET /api/db`. */
export const DbListResponse = z.object({ databases: z.array(DbInfoSchema) });

/** Answer of `GET /api/db/:db/schema`. */
export const DbSchemaResponse = z.object({ db: z.string(), tables: z.array(TableInfoSchema) });

/** Answer of `POST /api/db/query`. */
export const DbQueryResponse = QueryResultSchema;

/** Answer of `POST /api/db/execute`. */
export const DbExecuteResponse = z.object({ changes: z.number().int().nonnegative() });

/** Answer of `POST /api/db/snapshot`. */
export const DbSnapshotResponse = z.object({
  id: SnapshotId,
  db: z.string(),
  /** Epoch milliseconds. */
  takenAt: z.number().int().nonnegative(),
  label: z.string().max(128).optional(),
});

const Row = z.array(CellSchema);

/** What changed in one table since a snapshot. Capped; `truncated` says when. */
export const TableDiffSchema = z.object({
  table: z.string(),
  columns: z.array(z.string()),
  added: z.array(Row),
  removed: z.array(Row),
  changed: z.array(z.object({ before: Row, after: Row, columns: z.array(z.string()) })),
  truncated: z.boolean(),
  /** The table was over the snapshot caps, so it wasn't compared. */
  tooLarge: z.boolean().optional(),
});
export type TableDiff = z.infer<typeof TableDiffSchema>;

/** Answer of `POST /api/db/diff`. */
export const DbDiffResponse = z.object({
  db: z.string(),
  snapshotId: SnapshotId,
  /** When the snapshot was taken (epoch milliseconds). */
  takenAt: z.number().int().nonnegative(),
  tables: z.array(TableDiffSchema),
});
export type DbDiff = z.infer<typeof DbDiffResponse>;

export const TasksMineInput = z.object({
  status: z.array(TaskStatusTypeSchema).optional(),
});

export const TaskKeyInput = z.object({ key: TaskKey });

export const TaskSetStatusInput = z.object({
  key: TaskKey,
  statusType: TaskStatusTypeSchema,
});

/** Answer of `POST /api/login-window`: the dashboard cookie can be had until `until`. */
export const LoginWindowResponse = z.object({
  ok: z.literal(true),
  /** Epoch milliseconds. */
  until: z.number().int(),
});
export type LoginWindowResult = z.infer<typeof LoginWindowResponse>;

const SessionId = z.string().max(MAX_SESSION_ID);

/** Body of `POST /api/events`, sent by the Claude Code hooks. Unknown fields are dropped. */
export const HookEventInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claude.done'), sessionId: SessionId.optional() }),
  z.object({
    type: z.literal('claude.waiting'),
    sessionId: SessionId.optional(),
    message: z.string().max(MAX_WAITING_MESSAGE).optional(),
  }),
  /** Claude called the Dart MCP server's hot_reload or hot_restart tool; `ok` is its outcome. */
  z.object({
    type: z.literal('claude.reload'),
    sessionId: SessionId.optional(),
    ok: z.boolean(),
    kind: z.enum(['hot-reload', 'hot-restart']),
    message: z.string().max(MAX_RELOAD_MESSAGE).optional(),
  }),
]);
export type HookEvent = z.infer<typeof HookEventInput>;

/**
 * Answer of `GET /api/health`, the one route without auth. Clients read it before
 * sending the token, so they never hand it to another project's daemon on the port.
 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal('project-deck'),
  // Bounded: clients repeat both in messages to Claude.
  version: z.string().max(64),
  /** Salted hash of the project path; absent when the daemon has no port registry. */
  projectId: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});
export type Health = z.infer<typeof HealthResponse>;

/** Answer of `GET /api/status`. */
export const StatusResponse = z.object({
  version: z.string(),
  dashboardUrl: z.string(),
  /** The project folder's name, so the dashboard shows which project it belongs to. */
  projectName: z.string(),
  /** True until every connector has finished starting, so "no app" isn't final yet. */
  discovering: z.boolean(),
  apps: z.array(RunningAppSchema),
  attached: RunningAppSchema.nullable(),
});
export type Status = z.infer<typeof StatusResponse>;

/** Answer of `GET /api/logs`, oldest first. */
export const LogsResponse = z.object({
  entries: z.array(LogEntrySchema),
  truncated: z.boolean(),
});
export type LogsResult = z.infer<typeof LogsResponse>;

/** Answer of routes that only confirm, such as `DELETE /api/logs`. */
export const OkResponse = z.object({ ok: z.literal(true) });

/** Body of every error answer. */
export const ErrorResponse = z.object({ error: z.string() });

/**
 * Messages on `/ws` that the dashboard reads. Others (such as `task.current`) fail to
 * parse, and the dashboard ignores them.
 */
export const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    payload: z.object({
      apps: z.array(RunningAppSchema),
      attached: RunningAppSchema.nullable(),
      discovering: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('apps.discovering'),
    payload: z.object({ discovering: z.boolean() }),
  }),
  z.object({
    type: z.literal('apps.changed'),
    payload: z.object({ connectorId: z.string(), apps: z.array(RunningAppSchema) }),
  }),
  z.object({ type: z.literal('app.attached'), payload: z.object({ app: RunningAppSchema }) }),
  z.object({ type: z.literal('app.detached'), payload: z.object({ appId: z.string() }) }),
  z.object({
    type: z.literal('app.reloaded'),
    payload: z.object({ appId: z.string(), result: ReloadResultSchema }),
  }),
  z.object({
    type: z.literal('app.exit'),
    payload: z.object({
      appId: z.string(),
      code: z.number().int().optional(),
      crashed: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('app.log'),
    payload: z.object({ appId: z.string(), entry: LogEntrySchema }),
  }),
  z.object({ type: z.literal('logs.cleared'), payload: z.object({ at: z.number() }) }),
  z.object({ type: z.literal('activity'), payload: ActivityEntrySchema }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;
