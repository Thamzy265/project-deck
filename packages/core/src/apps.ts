import { z } from 'zod';
import type { DbInspector } from './db.js';
import type { LogSource } from './logs.js';

export const DeviceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['android', 'ios', 'web', 'desktop']),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const RunningAppSchema = z.object({
  /** Stable for the life of the app. */
  id: z.string(),
  /** Human name, e.g. the package name. */
  name: z.string(),
  device: DeviceInfoSchema.optional(),
  /** The app's process id on its device, once known (usually after attach). */
  pid: z.number().int().positive().optional(),
  framework: z.enum(['flutter', 'compose', 'web']),
  startedBy: z.enum(['ide', 'terminal', 'mcp', 'unknown']),
});
export type RunningApp = z.infer<typeof RunningAppSchema>;

export const ReloadResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    kind: z.enum(['hot-reload', 'hot-restart', 'rebuild']),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['compile-error', 'needs-restart', 'not-attached', 'unsupported']),
    message: z.string(),
  }),
]);
export type ReloadResult = z.infer<typeof ReloadResultSchema>;

/** Events an attached session emits, keyed by name. */
export interface AppSessionEvents {
  reloaded: ReloadResult;
  /** The app process went away. The session is unusable afterwards. */
  exit: { code?: number };
  error: { message: string; cause?: unknown };
}

/**
 * Discovers apps that are already running and attaches to them.
 * A connector never launches or stops an app.
 */
export interface AppConnector {
  /** e.g. 'dart'. */
  readonly id: string;
  /** Connect to the discovery source (e.g. DTD). Safe to call once. */
  start(): Promise<void>;
  /** Disconnect and detach every session. Never stops user apps. */
  stop(): Promise<void>;
  listApps(): Promise<RunningApp[]>;
  /** Called with the full current list whenever it changes. Returns an unsubscribe function. */
  onAppsChanged(cb: (apps: RunningApp[]) => void): () => void;
  attach(appId: string): Promise<AppSession>;
}

export interface AppSession {
  readonly app: RunningApp;
  reload(): Promise<ReloadResult>;
  restart(): Promise<ReloadResult>;
  logs(): LogSource;
  /** Undefined when no database backend is available for this app. */
  db(): DbInspector | undefined;
  /** Releases the connection. Must never stop the user's app. */
  detach(): Promise<void>;
  on<E extends keyof AppSessionEvents>(
    event: E,
    cb: (payload: AppSessionEvents[E]) => void,
  ): () => void;
}
