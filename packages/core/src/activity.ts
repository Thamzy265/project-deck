/**
 * The Activity feed: what happened while the developer looked elsewhere. Kept in memory
 * by the daemon (the newest ACTIVITY_CAPACITY entries) and pushed to the dashboard.
 */
import { z } from 'zod';
import { ReloadResultSchema } from './apps.js';

export const ACTIVITY_CAPACITY = 500;
/** Same limit as the hook input, so a waiting message is never cut. */
export const MAX_WAITING_MESSAGE = 2000;
/**
 * A failed reload's message from the reload hook: a line or two of the tool's error,
 * already cut and stripped of paths and URIs by the hook. Same limit as the hook's.
 */
export const MAX_RELOAD_MESSAGE = 300;
/** Claude Code session ids are UUIDs; anything longer isn't one. */
export const MAX_SESSION_ID = 128;

const Base = {
  /** Increases by one per entry for the life of the daemon. */
  id: z.number().int().nonnegative(),
  /** Epoch milliseconds, when the daemon saw it. */
  ts: z.number(),
};
const App = { ...Base, appId: z.string(), appName: z.string() };

export const ActivityEntrySchema = z.discriminatedUnion('kind', [
  z.object({ ...App, kind: z.literal('app.attached') }),
  z.object({ ...App, kind: z.literal('app.detached') }),
  z.object({ ...App, kind: z.literal('app.reloaded'), result: ReloadResultSchema }),
  /** The app went away without an error log line just before. */
  z.object({ ...App, kind: z.literal('app.stopped'), code: z.number().int().optional() }),
  /** The app went away, not by FlutterDeck, within 5 s of an error log line. */
  z.object({ ...App, kind: z.literal('app.crashed'), code: z.number().int().optional() }),
  z.object({ ...Base, kind: z.literal('claude.done'), sessionId: z.string().optional() }),
  z.object({
    ...Base,
    kind: z.literal('claude.waiting'),
    sessionId: z.string().optional(),
    message: z.string().max(MAX_WAITING_MESSAGE).optional(),
  }),
  /**
   * Claude's hot_reload or hot_restart through the Dart MCP server, as its hook reported
   * it. The app is the one attached when the result arrived, if any.
   */
  z.object({
    ...Base,
    kind: z.literal('claude.reload'),
    sessionId: z.string().max(MAX_SESSION_ID).optional(),
    ok: z.boolean(),
    reload: z.enum(['hot-reload', 'hot-restart']),
    message: z.string().max(MAX_RELOAD_MESSAGE).optional(),
    appId: z.string().optional(),
    appName: z.string().optional(),
  }),
]);
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/** Body of `GET /api/activity`, oldest first. */
export const ActivityListSchema = z.object({ entries: z.array(ActivityEntrySchema) });
export type ActivityList = z.infer<typeof ActivityListSchema>;
