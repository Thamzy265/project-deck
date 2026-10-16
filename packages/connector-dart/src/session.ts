import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import type {
  DeviceInfo,
  AppSession,
  AppSessionEvents,
  DbInspector,
  ReloadResult,
  RunningApp,
} from '@project-deck/core';
import { DEFAULT_EXTENSION_PREFIXES, EventBus, RingBufferLogSource } from '@project-deck/core';
import { z } from 'zod';
import type { JsonRpcClientOptions } from './json-rpc.js';
import {
  CallTimeoutError,
  ConnectionClosedError,
  JsonRpcClient,
  JsonRpcError,
} from './json-rpc.js';
import { OwnEvents } from './own-events.js';
import { VmExtensions } from './vm-extensions.js';
import { LineBuffer, entryFromLogRecord } from './vm-logs.js';

/** Service names the Flutter tool registers on the app's VM service. */
export const RELOAD_SERVICE = 'reloadSources';
export const RESTART_SERVICE = 'hotRestart';

/** VM service error: the stream is already subscribed (another call or a reconnect). */
const STREAM_ALREADY_SUBSCRIBED = 103;
const METHOD_NOT_FOUND = -32601;
/**
 * What flutter_tools sends when the reload or restart itself fails (usually a compile error):
 * `RPCError('Unable to reload sources', kInternalError, '')`. The text is `callingMethod`,
 * which isn't serialised, so the wire carries only `{"code":-32603,"message":""}`.
 */
const FLUTTER_TOOL_FAILURE = -32603;

/**
 * Maps a JSON-RPC error from the Flutter tool's reload/restart service onto a ReloadResult.
 * `unsupported` hides the button in the UI, so it only means the capability is absent.
 */
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
  if (err.code === FLUTTER_TOOL_FAILURE) {
    // The details go to the Flutter tool's own output, not to us.
    const detail = err.message === '' ? '' : ` (${err.message})`;
    return {
      ok: false,
      reason: 'compile-error',
      message: `${label} failed, probably a compile error${detail}. Check the latest error logs.`,
    };
  }
  // Transient or unknown: keep the button and say plainly what happened.
  const what = err.code === undefined ? 'an error with no code' : `error ${err.code}`;
  return {
    ok: false,
    reason: 'not-attached',
    message: `${label} could not run: the VM service returned ${what} (${err.message}). Try again.`,
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
      // IsolateReload: no `isolate`, only the group (service_event.cc).
      isolateGroup: z.object({ id: z.string() }).loose().optional().catch(undefined),
      // IsolateStart / IsolateRunnable / IsolateExit carry the isolate and its group.
      isolate: z
        .object({
          id: z.string(),
          name: z.string().optional(),
          isSystemIsolate: z.boolean().optional(),
          isolateGroupId: z.string().optional(),
        })
        .loose()
        .optional()
        .catch(undefined),
      status: z.string().optional().catch(undefined),
      reloadFailureReason: z.string().optional().catch(undefined),
      // ServiceExtensionAdded (Isolate stream) and Extension (Extension stream).
      extensionRPC: z.string().optional().catch(undefined),
      extensionKind: z.string().optional().catch(undefined),
      extensionData: z.unknown().optional(),
    })
    .loose(),
});

const VmSchema = z.object({
  // Informational only: a malformed value must not stop us finding the isolate.
  pid: z.number().optional().catch(undefined),
  operatingSystem: z.string().optional().catch(undefined),
  isolates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isSystemIsolate: z.boolean().optional(),
      isolateGroupId: z.string().optional().catch(undefined),
    }),
  ),
});

export interface DartAppSessionOptions extends JsonRpcClientOptions {
  /** How long reload waits for the Flutter tool's service to be announced. */
  serviceWaitMs?: number;
  logCapacity?: number;
  /**
   * How long after our own reload or restart answers an IsolateReload still counts as
   * ours. The VM posts it during the reload, so it normally arrives before the answer;
   * the event and the answer take different routes, so allow a little more.
   */
  ownReloadGraceMs?: number;
  /**
   * App extension prefixes that may be called (the registry's list). Read on every
   * call, so prefixes a backend registers later apply at once.
   */
  extensionPrefixes?: () => readonly string[];
}

const DEFAULT_SERVICE_WAIT_MS = 2000;
const DEFAULT_OWN_RELOAD_GRACE_MS = 1000;
/** The VM's failure reason can hold a long compiler report; the Activity feed needs the start. */
const MAX_FAILURE_REASON = 2000;
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
  /** The main isolate's group: IsolateReload events name a group, not an isolate. */
  private isolateGroupId: string | undefined;
  /** The last main isolate group seen; a change to a new one is a hot restart. */
  private mainGroupSeen: string | undefined;
  /** Own hot reloads, each expecting one IsolateReload. Restarts post none. */
  private readonly ownReloads: OwnEvents;
  /** Own hot restarts, each expecting one move of the main isolate to a new group. */
  private readonly ownRestarts: OwnEvents;
  private refreshing: Promise<void> | undefined;
  /** A follow-up refresh, requested while one was running. */
  private refreshQueued: Promise<void> | undefined;
  private readonly stdout: LineBuffer;
  private readonly stderr: LineBuffer;
  /** One per stream: a multibyte character can be split across WriteEvents. */
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private currentApp: RunningApp;
  /** Calls into flutterdeck_drift and friends (ADR 0004). */
  readonly extensions: VmExtensions;

  private constructor(
    app: RunningApp,
    private readonly rpc: JsonRpcClient,
    private readonly opts: DartAppSessionOptions,
  ) {
    this.currentApp = app;
    const graceMs = opts.ownReloadGraceMs ?? DEFAULT_OWN_RELOAD_GRACE_MS;
    this.ownReloads = new OwnEvents(graceMs);
    this.ownRestarts = new OwnEvents(graceMs);
    this.logSource = new RingBufferLogSource(opts.logCapacity ?? DEFAULT_SESSION_LOG_CAPACITY);
    this.stdout = new LineBuffer((line, ts) => this.pushLine(line, ts, 'info', 'stdout'));
    this.stderr = new LineBuffer((line, ts) => this.pushLine(line, ts, 'error', 'stderr'));
    this.extensions = new VmExtensions(
      {
        rpc,
        mainIsolate: () => this.isolateId,
        refreshMainIsolate: () => this.refreshIsolate(),
      },
      opts.extensionPrefixes ?? (() => DEFAULT_EXTENSION_PREFIXES),
      (cause) => this.events.emit('error', { message: 'An app event listener failed', cause }),
    );
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
      // Wake reloads waiting for a service that can no longer be announced.
      for (const check of [...this.serviceWaiters]) check();
      this.extensions.clear();
      this.disposeBuffers();
      this.events.emit('exit', {});
    });
    await Promise.all(
      ['Service', 'Isolate', 'Extension', 'Stdout', 'Stderr', 'Logging'].map((id) =>
        this.streamListen(id),
      ),
    );
    await this.refreshIsolate();
    // Extensions registered before we subscribed are only on the Isolate object.
    if (this.isolateId !== undefined) await this.extensions.load(this.isolateId);
  }

  /** Gains `pid` and, on Android, `device.platform` once the VM has been read during attach. */
  get app(): RunningApp {
    return this.currentApp;
  }

  reload(): Promise<ReloadResult> {
    return this.invoke(RELOAD_SERVICE, 'hot-reload', async (method) => {
      if (this.isolateId === undefined) await this.refreshIsolate();
      // The Flutter tool only checks that the id is a non-empty string, so a stale one is fine.
      await this.reloadIsolate(method);
    });
  }

  private async reloadIsolate(method: string): Promise<void> {
    if (this.isolateId === undefined) throw new NoIsolateError();
    await this.rpc.call(method, { isolateId: this.isolateId });
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
    const method = await this.serviceMethod(service);
    if (this.rpc.closed)
      return { ok: false, reason: 'not-attached', message: 'The app has exited' };
    if (method === undefined) {
      return {
        ok: false,
        reason: 'unsupported',
        message: `This app has no ${service} service. It may not have been started by the Flutter tool.`,
      };
    }
    const label = kind === 'hot-reload' ? 'Hot reload' : 'Hot restart';
    const started = performance.now();
    let result: ReloadResult;
    const own = kind === 'hot-reload' ? this.ownReloads : this.ownRestarts;
    own.started();
    try {
      await run(method);
      result = { ok: true, kind, durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      if (err instanceof ConnectionClosedError || err instanceof NoIsolateError) {
        return { ok: false, reason: 'not-attached', message: err.message };
      }
      if (err instanceof CallTimeoutError) {
        return {
          ok: false,
          reason: 'not-attached',
          message: `${label} got no answer within ${Math.round(err.timeoutMs / 1000)} s. The app may be paused in the debugger or busy; try again.`,
        };
      }
      if (!(err instanceof JsonRpcError)) {
        // Callers expect a ReloadResult, never a rejection.
        const detail = err instanceof Error ? err.message : String(err);
        this.events.emit('error', { message: `${label} failed unexpectedly`, cause: err });
        return {
          ok: false,
          reason: 'not-attached',
          message: `${label} failed unexpectedly: ${detail}`,
        };
      }
      result = reloadFailure(kind, err);
    } finally {
      own.finished();
    }
    this.events.emit('reloaded', result);
    return result;
  }

  /**
   * A hot restart (ours or anyone's) replaces the main isolate with one in a NEW isolate
   * group (seen in QA's recording). Take the new group from the event itself, so a reload
   * right after the restart isn't dropped as another group's while getVM is still on its
   * way; refreshIsolate() confirms it.
   */
  private followMainIsolate(event: z.infer<typeof StreamNotifySchema>['event']): void {
    const isolate = event.isolate;
    if (isolate === undefined || isolate.isSystemIsolate === true) return;
    if (event.kind === 'IsolateExit') {
      // Until the new one starts, accept reloads of any group rather than drop them.
      if (isolate.id === this.isolateId) this.isolateGroupId = undefined;
      return;
    }
    if (isolate.name !== 'main') return;
    const group = isolate.isolateGroupId ?? event.isolateGroup?.id;
    this.isolateId = isolate.id;
    this.isolateGroupId = group;
    if (group === undefined) return;
    const restarted = this.mainGroupSeen !== undefined && group !== this.mainGroupSeen;
    this.mainGroupSeen = group;
    // A hot restart posts no IsolateReload; the move to a new group is the only sign.
    if (restarted && !this.ownRestarts.claim()) {
      this.events.emit('reloaded', { ok: true, kind: 'hot-restart', source: 'external' });
    }
  }

  /**
   * A reload we didn't start: Claude through the Dart MCP server, or the IDE. Our own
   * ones are reported by invoke() with their duration, so their event is dropped here.
   *
   * Known gap, accepted: an own reload with no changed libraries, or one that fails to
   * compile, posts no IsolateReload, and the Flutter tool's answer (`{type: Success}` or
   * error -32603) doesn't say whether one is coming. So the expectation stays open for
   * the grace period (1 s), and a reload by someone else in that time is taken for ours
   * and not reported. See docs/notes/dtd.md.
   */
  private onIsolateReload(event: z.infer<typeof StreamNotifySchema>['event']): void {
    const group = event.isolateGroup?.id;
    if (group !== undefined && this.isolateGroupId !== undefined && group !== this.isolateGroupId) {
      return;
    }
    // One event per own reload; any further one is someone else's.
    if (this.ownReloads.claim()) return;
    // "success" also covers a reload the VM rejected (QA's recording): nothing on the wire
    // tells them apart, so it is reported as the VM says. See docs/notes/dtd.md.
    if (event.status === 'success') {
      this.events.emit('reloaded', { ok: true, kind: 'hot-reload', source: 'external' });
    } else if (event.status === 'failure') {
      const reason = event.reloadFailureReason ?? 'no reason given';
      const message = `Hot reload failed: ${reason}`;
      this.events.emit('reloaded', {
        ok: false,
        reason: 'compile-error',
        message:
          message.length > MAX_FAILURE_REASON
            ? `${message.slice(0, MAX_FAILURE_REASON - 1)}…`
            : message,
        source: 'external',
      });
    }
  }

  private serviceMethod(service: string): Promise<string | undefined> {
    const known = this.services.get(service);
    if (known !== undefined) return Promise.resolve(known);
    // Nothing can be announced on a closed connection.
    if (this.rpc.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const check = (): void => {
        const method = this.services.get(service);
        if (method !== undefined || this.rpc.closed) done(method);
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
        this.recordProcess(vm);
        const isolates = vm.isolates.filter((i) => i.isSystemIsolate !== true);
        const main = isolates.find((i) => i.name === 'main') ?? isolates[0];
        this.isolateId = main?.id;
        this.isolateGroupId = main?.isolateGroupId;
        // Only a first value: a getVM sent before a restart can answer after it, and
        // restarts are detected from the Isolate events instead.
        this.mainGroupSeen ??= main?.isolateGroupId;
      } catch (err) {
        if (!(err instanceof ConnectionClosedError)) throw err;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /**
   * The VM's pid is the app's process on its device (on Android, the app process
   * itself), which log feeds such as logcat need. The device serial is unknown here.
   */
  private recordProcess(vm: z.infer<typeof VmSchema>): void {
    if (this.currentApp.pid !== undefined) return;
    const { pid, operatingSystem } = vm;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
    const next: RunningApp = { ...this.currentApp, pid };
    const platform = platformOf(operatingSystem);
    if (next.device !== undefined && next.device.platform === undefined && platform !== undefined) {
      // Named from the tool's app name before attach; the VM knows the platform.
      next.device = { ...next.device, platform };
    } else if (operatingSystem === 'android' && next.device === undefined) {
      next.device = { id: 'unknown', name: 'Android device', platform: 'android' };
    }
    this.currentApp = next;
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
        if (event.kind === 'ServiceExtensionAdded') {
          if (event.extensionRPC !== undefined && event.isolate !== undefined) {
            this.extensions.added(event.extensionRPC, event.isolate.id);
          }
          return;
        }
        if (event.kind === 'IsolateExit') this.extensions.dropIsolate(event.isolate?.id);
        if (event.kind === 'IsolateReload') this.onIsolateReload(event);
        else if (['IsolateStart', 'IsolateRunnable', 'IsolateExit'].includes(event.kind)) {
          this.followMainIsolate(event);
          void this.refreshIsolate().catch(() => undefined);
        }
        return;
      case 'Extension':
        if (event.kind === 'Extension' && event.extensionKind !== undefined) {
          this.extensions.event(event.isolate?.id, event.extensionKind, event.extensionData);
        }
        return;
      case 'Stdout':
      case 'Stderr':
        if (event.bytes !== undefined) {
          const out = streamId === 'Stdout';
          const text = (out ? this.stdoutDecoder : this.stderrDecoder).write(
            Buffer.from(event.bytes, 'base64'),
          );
          (out ? this.stdout : this.stderr).write(text, event.timestamp ?? Date.now());
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
    // Emit any incomplete trailing bytes (as U+FFFD) rather than dropping them.
    const now = Date.now();
    this.stdout.write(this.stdoutDecoder.end(), now);
    this.stderr.write(this.stderrDecoder.end(), now);
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

/** The VM's operatingSystem as a device platform; undefined when it doesn't say. */
function platformOf(os: string | undefined): DeviceInfo['platform'] {
  if (os === 'android') return 'android';
  if (os === 'ios') return 'ios';
  if (os === 'macos' || os === 'linux' || os === 'windows') return 'desktop';
  return undefined;
}
