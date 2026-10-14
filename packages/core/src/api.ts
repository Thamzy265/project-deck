/**
 * Input schemas shared by the MCP server and the daemon's HTTP API,
 * so both validate requests the same way.
 */
import { z } from 'zod';
import { MAX_WAITING_MESSAGE } from './activity.js';
import { MAX_QUERY_LIMIT } from './db.js';
import { LogQuerySchema } from './logs.js';
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
