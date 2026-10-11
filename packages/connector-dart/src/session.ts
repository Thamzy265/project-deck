import { performance } from 'node:perf_hooks';
import type {
  AppSession,
  AppSessionEvents,
  DbInspector,
  ReloadResult,
  RunningApp,
} from '@project-deck/core';
import { EventBus, RingBufferLogSource } from '@project-deck/core';
import { z } from 'zod';
import type { JsonRpcClientOptions } from './json-rpc.js';
import { ConnectionClosedError, JsonRpcClient, JsonRpcError } from './json-rpc.js';
import { LineBuffer, entryFromLogRecord } from './vm-logs.js';

/** Service names the Flutter tool registers on the app's VM service. */
export const RELOAD_SERVICE = 'reloadSources';
export const RESTART_SERVICE = 'hotRestart';

/** VM service error: the stream is already subscribed (another call or a reconnect). */
const STREAM_ALREADY_SUBSCRIBED = 103;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
/** What flutter_tools sends when the reload or restart itself fails (usually a compile error). */
const FLUTTER_TOOL_FAILURE = /Unable to (reload sources|restart)/i;

/** Maps a JSON-RPC error from the Flutter tool's reload/restart service onto a ReloadResult. */
function reloadFailure(
  kind: 'hot-reload' | 'hot-restart',
  err: JsonRpcError,
): Extract<ReloadResult, { ok: false }> {
  const label = kind === 'hot-reload' ? 'Hot reload' : 'Hot restart';
  if (err.code === METHOD_NOT_FOUND) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `${label} is not available on this app: ${err.message}.`,
    };
  }
  if (err.code === INTERNAL_ERROR || FLUTTER_TOOL_FAILURE.test(err.message)) {
    // The Flutter tool reports only "Unable to reload sources"; the details go to its own output.
    return {
      ok: false,
      reason: 'compile-error',
      message: `${label} failed: ${err.message}. Check the latest error logs.`,
    };
  }
  // No ReloadResult reason fits an unexpected protocol error; say plainly what happened.
  return {
    ok: false,
    reason: 'unsupported',
    message: `${label} could not run: the VM service returned error ${err.code} (${err.message}).`,
  };
}

const StreamNotifySchema = z.object({
  streamId: z.string(),
  event: z
    .object({
      kind: z.string(),
      timestamp: z.number().optional(),
      service: z.string().optional(),
      method: z.string().optional(),
      bytes: z.string().optional(),
      logRecord: z.unknown().optional(),
    })
    .loose(),
});

const VmSchema = z.object({
  isolates: z.array(
    z.object({ id: z.string(), name: z.string(), isSystemIsolate: z.boolean().optional() }),
  ),
});

export interface DartAppSessionOptions extends JsonRpcClientOptions {
  /** How long reload waits for the Flutter tool's service to be announced. */
  serviceWaitMs?: number;
  logCapacity?: number;
}

const DEFAULT_SERVICE_WAIT_MS = 2000;
/** DDS replays up to 10,000 recent log events when we subscribe. */
const DEFAULT_SESSION_LOG_CAPACITY = 10_000;

/**
 * One attached Flutter app, talking to its VM service (usually through DDS, so
 * the IDE's debugger keeps working). Never pauses, kills or restarts on its own.
 */
export class DartAppSession implements AppSession {
  private readonly logSource: RingBufferLogSource;
  private readonly events = new EventBus<AppSessionEvents>();
  /** Service name → callable method (e.g. 'reloadSources' → 's0.reloadSources'). */
  private readonly services = new Map<string, string>();
  private readonly serviceWaiters = new Set<() => void>();
  private isolateId: string | undefined;
  private refreshing: Promise<void> | undefined;
  /** A follow-up refresh, requested while one was running. */
  private refreshQueued: Promise<void> | undefined;
  private readonly stdout: LineBuffer;
  private readonly stderr: LineBuffer;

  private constructor(
    readonly app: RunningApp,
    private readonly rpc: JsonRpcClient,
    private readonly opts: DartAppSessionOptions,
  ) {
    this.logSource = new RingBufferLogSource(opts.logCapacity ?? DEFAULT_SESSION_LOG_CAPACITY);
    this.stdout = new LineBuffer((line, ts) => this.pushLine(line, ts, 'info', 'stdout'));
    this.stderr = new LineBuffer((line, ts) => this.pushLine(line, ts, 'error', 'stderr'));
  }

  static async attach(
    vmServiceUri: string,
    app: RunningApp,
    opts: DartAppSessionOptions = {},
  ): Promise<DartAppSession> {
    const rpc = await JsonRpcClient.connect(vmServiceUri, opts);
    const session = new DartAppSession(app, rpc, opts);
    try {
      await session.init();
    } catch (err) {
      rpc.close();
      throw err;
    }
    return session;
  }

  private async init(): Promise<void> {
    // Listen before subscribing: DDS replays history and registrations immediately.
    this.rpc.onNotification('streamNotify', (params) => {
      this.onStreamNotify(params);
    });
    this.rpc.onClose(() => {
      this.disposeBuffers();
      this.events.emit('exit', {});
    });
    await Promise.all(
      ['Service', 'Isolate', 'Stdout', 'Stderr', 'Logging'].map((id) => this.streamListen(id)),
    );
    await this.refreshIsolate();
  }

  reload(): Promise<ReloadResult> {
    return this.invoke(RELOAD_SERVICE, 'hot-reload', async (method) => {
      if (this.isolateId === undefined) await this.refreshIsolate();
      if (this.isolateId === undefined) throw new NoIsolateError();
      await this.rpc.call(method, { isolateId: this.isolateId });
    });
  }

  restart(): Promise<ReloadResult> {
    return this.invoke(RESTART_SERVICE, 'hot-restart', async (method) => {
      await this.rpc.call(method, {});
    });
  }

  logs(): RingBufferLogSource {
    return this.logSource;
  }

  db(): DbInspector | undefined {
    return undefined;
  }

  /** Closes our connection only. The app and the IDE's debug session keep running. */
  detach(): Promise<void> {
    this.disposeBuffers();
    this.rpc.close();
    return Promise.resolve();
  }

  on<E extends keyof AppSessionEvents>(
    event: E,
    cb: (payload: AppSessionEvents[E]) => void,
  ): () => void {
    return this.events.on(event, cb);
  }

  private async invoke(
    service: string,
    kind: 'hot-reload' | 'hot-restart',
    run: (method: string) => Promise<void>,
  ): Promise<ReloadResult> {
    if (this.rpc.closed)
      return { ok: false, reason: 'not-attached', message: 'The app has exited' };
    const method = await this.serviceMethod(service);
    if (method === undefined) {
      return {
        ok: false,
        reason: 'unsupported',
        message: `This app has no ${service} service. It may not have been started by the Flutter tool.`,
      };
    }
    const started = performance.now();
    let result: ReloadResult;
    try {
      await run(method);
      result = { ok: true, kind, durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      if (err instanceof ConnectionClosedError || err instanceof NoIsolateError) {
        return { ok: false, reason: 'not-attached', message: err.message };
      }
      if (!(err instanceof JsonRpcError)) throw err;
      result = reloadFailure(kind, err);
    }
    this.events.emit('reloaded', result);
    return result;
  }

  private serviceMethod(service: string): Promise<string | undefined> {
    const known = this.services.get(service);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const check = (): void => {
        const method = this.services.get(service);
        if (method === undefined) return;
        done(method);
      };
      const done = (method: string | undefined): void => {
        clearTimeout(timer);
        this.serviceWaiters.delete(check);
        resolve(method);
      };
      const timer = setTimeout(
        () => done(undefined),
        this.opts.serviceWaitMs ?? DEFAULT_SERVICE_WAIT_MS,
      );
      this.serviceWaiters.add(check);
    });
  }

  private async streamListen(streamId: string): Promise<void> {
    try {
      await this.rpc.call('streamListen', { streamId });
    } catch (err) {
      if (!(err instanceof JsonRpcError && err.code === STREAM_ALREADY_SUBSCRIBED)) throw err;
    }
  }

  /**
   * Hot restart replaces the main isolate, so re-read it whenever isolates change.
   * A request made while a getVM is in flight queues one more: that getVM may
   * predate the event (e.g. IsolateStart arriving during the IsolateExit refresh).
   */
  private refreshIsolate(): Promise<void> {
    if (this.refreshing !== undefined) {
      this.refreshQueued ??= this.refreshing
        .catch(() => undefined)
        .then(() => {
          this.refreshQueued = undefined;
          return this.refreshIsolate();
        });
      return this.refreshQueued;
    }
    this.refreshing = (async () => {
      try {
        const vm = VmSchema.parse(await this.rpc.call('getVM', {}));
        const isolates = vm.isolates.filter((i) => i.isSystemIsolate !== true);
        this.isolateId = (isolates.find((i) => i.name === 'main') ?? isolates[0])?.id;
      } catch (err) {
        if (!(err instanceof ConnectionClosedError)) throw err;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private onStreamNotify(params: unknown): void {
    const parsed = StreamNotifySchema.safeParse(params);
    if (!parsed.success) return;
    const { streamId, event } = parsed.data;
    switch (streamId) {
      case 'Service':
        if (event.service === undefined) return;
        if (event.kind === 'ServiceRegistered' && event.method !== undefined) {
          this.services.set(event.service, event.method);
          for (const check of [...this.serviceWaiters]) check();
        } else if (event.kind === 'ServiceUnregistered') {
          this.services.delete(event.service);
        }
        return;
      case 'Isolate':
        if (['IsolateStart', 'IsolateRunnable', 'IsolateExit'].includes(event.kind)) {
          void this.refreshIsolate().catch(() => undefined);
        }
        return;
      case 'Stdout':
      case 'Stderr':
        if (event.bytes !== undefined) {
          const text = Buffer.from(event.bytes, 'base64').toString('utf8');
          (streamId === 'Stdout' ? this.stdout : this.stderr).write(
            text,
            event.timestamp ?? Date.now(),
          );
        }
        return;
      case 'Logging': {
        const entry = entryFromLogRecord(event.logRecord, event.timestamp ?? Date.now());
        if (entry !== undefined) this.logSource.push(entry);
        return;
      }
    }
  }

  private disposeBuffers(): void {
    this.stdout.dispose();
    this.stderr.dispose();
  }

  private pushLine(line: string, ts: number, level: 'info' | 'error', tag: string): void {
    if (line === '') return;
    this.logSource.push({ ts, level, source: 'app', tag, message: line });
  }
}

class NoIsolateError extends Error {
  constructor() {
    super('The app has no running isolate');
  }
}
