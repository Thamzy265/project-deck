import type {
  AppConnector,
  AppSession,
  EventBus,
  LogEntry,
  LogSource,
  ReloadResult,
  Registry,
  RunningApp,
} from '@project-deck/core';
import { MAX_LOG_LIMIT, RingBufferLogSource, isAtLeast } from '@project-deck/core';

/** Discovery counts as done after this long even if a connector is still starting. */
export const DISCOVERY_BOUND_MS = 10_000;

/** An exit within this long after an error log line counts as a crash. */
export const CRASH_WINDOW_MS = 5000;

interface Attached {
  app: RunningApp;
  /** Undefined once the app has exited; logs stay readable until the next attach. */
  session: AppSession | undefined;
  logs: RingBufferLogSource;
  /** When the daemon last received an error-level line live (backfill doesn't count). */
  lastErrorAt: number | undefined;
  cleanup: (() => Promise<void> | void)[];
}

export interface AppManagerOptions {
  logCapacity?: number;
  /** Called when a connector fails to start. The daemon keeps running without it. */
  onConnectorError?: (connectorId: string, err: unknown) => void;
  /** Clock for the crash window; tests pass a fake one. */
  now?: () => number;
}

const NOT_ATTACHED: ReloadResult = {
  ok: false,
  reason: 'not-attached',
  message: 'No app is attached. Start one from your IDE or `flutter run`, then pick it.',
};

/**
 * Tracks running apps across all connectors and keeps at most one attached.
 * Merges the session's logs and every registered log feed into one buffer.
 */
export class AppManager {
  private readonly appsByConnector = new Map<string, RunningApp[]>();
  private attached: Attached | undefined;
  /** Turned off when the user detaches, so we don't immediately re-attach. */
  private autoAttach = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];
  /** Set by stop(); connectors that finish starting afterwards are ignored. */
  private stopped = false;
  /** Until start() is done, an empty app list may just mean "not scanned yet". */
  private discoveringNow = true;

  constructor(
    private readonly registry: Registry,
    private readonly bus: EventBus,
    private readonly opts: AppManagerOptions = {},
  ) {}

  async start(): Promise<void> {
    // A connector that hangs (say, a DTD that never answers) mustn't keep the dashboard
    // on "Finding apps…": discovery counts as done after the bound, whichever comes first.
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DISCOVERY_BOUND_MS);
      timer.unref();
    });
    const all = Promise.all(this.registry.connectors.list().map((c) => this.startConnector(c)));
    await Promise.race([all, bound]);
    clearTimeout(timer);
    this.endDiscovery();
    await all;
  }

  private endDiscovery(): void {
    if (!this.discoveringNow) return;
    this.discoveringNow = false;
    if (!this.stopped) this.bus.emit('apps.discovering', { discovering: false });
  }

  /** True until every connector has finished starting (or failed to). */
  discovering(): boolean {
    return this.discoveringNow;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.unsubscribers.splice(0)) off();
    await this.serial(() => this.release());
    await Promise.all(this.registry.connectors.list().map((c) => c.stop()));
  }

  apps(): RunningApp[] {
    return [...this.appsByConnector.values()].flat();
  }

  attachedApp(): RunningApp | undefined {
    return this.attached?.session === undefined ? undefined : this.attached.app;
  }

  /** Logs of the attached app, or of the last one if it exited. */
  logs(): LogSource | undefined {
    return this.attached?.logs;
  }

  attach(appId: string): Promise<RunningApp> {
    this.autoAttach = true;
    return this.serial(() => this.doAttach(appId));
  }

  detach(): Promise<void> {
    this.autoAttach = false;
    return this.serial(() => this.release());
  }

  reload(): Promise<ReloadResult> {
    const session = this.attached?.session;
    return session === undefined ? Promise.resolve(NOT_ATTACHED) : session.reload();
  }

  restart(): Promise<ReloadResult> {
    const session = this.attached?.session;
    return session === undefined ? Promise.resolve(NOT_ATTACHED) : session.restart();
  }

  private async startConnector(connector: AppConnector): Promise<void> {
    // Subscribe before start(): a connector may report apps while its first scan is still running.
    const off = connector.onAppsChanged((apps) => this.onAppsChanged(connector, apps));
    this.unsubscribers.push(off);
    try {
      await connector.start();
      if (this.stopped) return;
      this.onAppsChanged(connector, await connector.listApps());
    } catch (err) {
      off();
      this.forgetConnector(connector);
      this.opts.onConnectorError?.(connector.id, err);
    }
  }

  /** Drops whatever a connector that failed to start reported while it was starting. */
  private forgetConnector(connector: AppConnector): void {
    const apps = this.appsByConnector.get(connector.id);
    if (apps === undefined) return;
    this.appsByConnector.delete(connector.id);
    if (this.stopped) return;
    this.bus.emit('apps.changed', { connectorId: connector.id, apps: this.apps() });
    const attachedId = this.attached?.app.id;
    if (attachedId !== undefined && apps.some((a) => a.id === attachedId)) {
      void this.serial(() => this.release()).catch(() => undefined);
    }
  }

  private onAppsChanged(connector: AppConnector, apps: RunningApp[]): void {
    if (this.stopped) return;
    this.appsByConnector.set(connector.id, apps);
    this.bus.emit('apps.changed', { connectorId: connector.id, apps: this.apps() });
    const all = this.apps();
    const only = all.length === 1 ? all[0] : undefined;
    if (this.autoAttach && this.attached?.session === undefined && only !== undefined) {
      void this.serial(() => this.doAttach(only.id)).catch(() => undefined);
    }
  }

  private async doAttach(appId: string): Promise<RunningApp> {
    if (this.stopped) throw new Error('App manager is stopped');
    const connector = this.connectorFor(appId);
    if (this.attached?.session !== undefined && this.attached.app.id === appId) {
      return this.attached.app;
    }
    await this.release();
    // Lines logged before this (logcat prints the app's recent history first) don't count
    // towards a crash. Compared with the line's own time, so it assumes the device clock
    // roughly matches this machine's, as emulators and network-synced phones do.
    const attachedAt = this.now();
    const session = await connector.attach(appId);
    const app = session.app;
    const logs = new RingBufferLogSource(this.opts.logCapacity);
    const attached: Attached = { app, session, logs, lastErrorAt: undefined, cleanup: [] };
    this.attached = attached;

    const push = (entry: LogEntry): void => {
      if (isAtLeast(entry.level, 'error') && entry.ts >= attachedAt) {
        attached.lastErrorAt = this.now();
      }
      logs.push(entry);
      this.bus.emit('app.log', { appId: app.id, entry });
    };
    // Subscribe before backfilling so nothing that arrives during the query is lost.
    // Entries seen both live and in the backfill are the same objects, so dedupe by identity.
    let pending: LogEntry[] | undefined = [];
    attached.cleanup.push(
      session.logs().subscribe((entry) => {
        if (pending === undefined) push(entry);
        else pending.push(entry);
      }),
      session.on('reloaded', (result) => {
        this.bus.emit('app.reloaded', { appId: app.id, result });
      }),
      session.on('exit', ({ code }) => {
        // Judged now: queued attach steps and cleanup can take a while before onExit runs.
        const crashed =
          attached.lastErrorAt !== undefined &&
          this.now() - attached.lastErrorAt <= CRASH_WINDOW_MS;
        void this.serial(() => this.onExit(attached, code, crashed));
      }),
    );
    const backfill = await session.logs().query({ limit: MAX_LOG_LIMIT });
    for (const entry of backfill) logs.push(entry);
    const seen = new Set(backfill);
    const live = pending;
    pending = undefined;
    for (const entry of live) if (!seen.has(entry)) push(entry);
    for (const feed of this.registry.logFeeds.list()) {
      const close = await feed.open(app, push).catch(() => undefined);
      if (close !== undefined) attached.cleanup.push(close);
    }

    this.bus.emit('app.attached', { app });
    return app;
  }

  private async onExit(
    attached: Attached,
    code: number | undefined,
    crashed: boolean,
  ): Promise<void> {
    const session = attached.session;
    if (this.attached !== attached || session === undefined) return;
    await this.runCleanup(attached);
    attached.session = undefined;
    // The app is gone, but the connector may still hold resources for the session.
    await session.detach().catch(() => undefined);
    this.bus.emit('app.exit', {
      appId: attached.app.id,
      ...(code === undefined ? {} : { code }),
      crashed,
    });
  }

  /** Detaches without ever stopping the app. */
  private async release(): Promise<void> {
    const current = this.attached;
    if (current === undefined) return;
    this.attached = undefined;
    await this.runCleanup(current);
    if (current.session !== undefined) {
      await current.session.detach();
      this.bus.emit('app.detached', { appId: current.app.id });
    }
  }

  private async runCleanup(attached: Attached): Promise<void> {
    await Promise.allSettled(
      attached.cleanup.splice(0).map(async (fn) => {
        await fn();
      }),
    );
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private connectorFor(appId: string): AppConnector {
    for (const [connectorId, apps] of this.appsByConnector) {
      if (apps.some((a) => a.id === appId)) return this.registry.connectors.require(connectorId);
    }
    throw new UnknownAppError(appId);
  }

  /** Runs attach/detach steps one at a time so they can't interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export class UnknownAppError extends Error {
  constructor(readonly appId: string) {
    super(`No running app with id '${appId}'`);
  }
}
