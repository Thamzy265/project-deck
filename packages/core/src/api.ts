/**
 * Input schemas shared by the MCP server and the daemon's HTTP API,
 * so both validate requests the same way.
 */
import { z } from 'zod';
import { ActivityEntrySchema, MAX_WAITING_MESSAGE } from './activity.js';
import { ReloadResultSchema, RunningAppSchema } from './apps.js';
import { MAX_QUERY_LIMIT } from './db.js';
import { LogEntrySchema, LogQuerySchema } from './logs.js';
import { TaskStatusTypeSchema } from './tasks.js';

const DbName = z.string().min(1).max(128);
const Sql = z.string().min(1).max(100_000);
const SqlParams = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(1000);
const TaskKey = z.string().min(1).max(64);

export const GetLogsInput = LogQuerySchema;

export const DbSchemaInput = z.object({ db: DbName });

export const DbQueryInput = z.object({
  db: DbName,
  sql: Sql,
  params: SqlParams.optional(),
  limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional(),
});

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
  /** Snapshot to compare against the current state. */
  snapshotId: z.string().min(1),
});

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

/** Body of `POST /api/events`, sent by the Claude Code hooks. */
export const HookEventInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claude.done'), sessionId: z.string().optional() }),
  z.object({
    type: z.literal('claude.waiting'),
    sessionId: z.string().optional(),
    message: z.string().max(MAX_WAITING_MESSAGE).optional(),
  }),
]);
export type HookEvent = z.infer<typeof HookEventInput>;

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
  z.object({ type: z.literal('activity'), payload: ActivityEntrySchema }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;
