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
import { MAX_LOG_LIMIT, RingBufferLogSource } from '@project-deck/core';

interface Attached {
  app: RunningApp;
  /** Undefined once the app has exited; logs stay readable until the next attach. */
  session: AppSession | undefined;
  logs: RingBufferLogSource;
  cleanup: (() => Promise<void> | void)[];
}

export interface AppManagerOptions {
  logCapacity?: number;
  /** Called when a connector fails to start. The daemon keeps running without it. */
  onConnectorError?: (connectorId: string, err: unknown) => void;
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

  constructor(
    private readonly registry: Registry,
    private readonly bus: EventBus,
    private readonly opts: AppManagerOptions = {},
  ) {}

  async start(): Promise<void> {
    await Promise.all(this.registry.connectors.list().map((c) => this.startConnector(c)));
  }

  async stop(): Promise<void> {
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
    try {
      await connector.start();
      this.unsubscribers.push(
        connector.onAppsChanged((apps) => this.onAppsChanged(connector, apps)),
      );
      this.onAppsChanged(connector, await connector.listApps());
    } catch (err) {
      this.opts.onConnectorError?.(connector.id, err);
    }
  }

  private onAppsChanged(connector: AppConnector, apps: RunningApp[]): void {
    this.appsByConnector.set(connector.id, apps);
    this.bus.emit('apps.changed', { connectorId: connector.id, apps: this.apps() });
    const all = this.apps();
    const only = all.length === 1 ? all[0] : undefined;
    if (this.autoAttach && this.attached?.session === undefined && only !== undefined) {
      void this.serial(() => this.doAttach(only.id)).catch(() => undefined);
    }
  }

  private async doAttach(appId: string): Promise<RunningApp> {
    const connector = this.connectorFor(appId);
    if (this.attached?.session !== undefined && this.attached.app.id === appId) {
      return this.attached.app;
    }
    await this.release();
    const session = await connector.attach(appId);
    const app = session.app;
    const logs = new RingBufferLogSource(this.opts.logCapacity);
    const attached: Attached = { app, session, logs, cleanup: [] };
    this.attached = attached;

    const push = (entry: LogEntry): void => {
      logs.push(entry);
      this.bus.emit('app.log', { appId: app.id, entry });
    };
    for (const entry of await session.logs().query({ limit: MAX_LOG_LIMIT })) logs.push(entry);
    attached.cleanup.push(
      session.logs().subscribe(push),
      session.on('reloaded', (result) => {
        this.bus.emit('app.reloaded', { appId: app.id, result });
      }),
      session.on('exit', ({ code }) => {
        void this.serial(() => this.onExit(attached, code));
      }),
    );
    for (const feed of this.registry.logFeeds.list()) {
      const close = await feed.open(app, push).catch(() => undefined);
      if (close !== undefined) attached.cleanup.push(close);
    }

    this.bus.emit('app.attached', { app });
    return app;
  }

  private async onExit(attached: Attached, code: number | undefined): Promise<void> {
    if (this.attached !== attached || attached.session === undefined) return;
    await this.runCleanup(attached);
    attached.session = undefined;
    this.bus.emit(
      'app.exit',
      code === undefined ? { appId: attached.app.id } : { appId: attached.app.id, code },
    );
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
