import type {
  AppConnector,
  AppSession,
  AppSessionEvents,
  ReloadResult,
  RunningApp,
} from '../apps.js';
import type { DbInspector } from '../db.js';
import { EventBus } from '../events.js';
import type { FakeAppExtensions } from './fake-extensions.js';
import { RingBufferLogSource } from '../logs.js';

const OK_RELOAD: ReloadResult = { ok: true, kind: 'hot-reload', durationMs: 120 };
const OK_RESTART: ReloadResult = { ok: true, kind: 'hot-restart', durationMs: 900 };
const NOT_ATTACHED: ReloadResult = {
  ok: false,
  reason: 'not-attached',
  message: 'Session is detached',
};

export interface FakeAppSessionOptions {
  db?: DbInspector;
  extensions?: FakeAppExtensions;
  logCapacity?: number;
}

/** Scriptable session. Push logs with `logs().push`, queue reload outcomes with `nextReload`. */
export class FakeAppSession implements AppSession {
  readonly reloadQueue: ReloadResult[] = [];
  readonly restartQueue: ReloadResult[] = [];
  reloadCount = 0;
  restartCount = 0;
  detached = false;
  private readonly logSource: RingBufferLogSource;
  private readonly events = new EventBus<AppSessionEvents>();
  private readonly dbInspector: DbInspector | undefined;
  readonly extensions?: FakeAppExtensions;

  constructor(
    readonly app: RunningApp,
    opts: FakeAppSessionOptions = {},
  ) {
    this.logSource = new RingBufferLogSource(opts.logCapacity);
    this.dbInspector = opts.db;
    if (opts.extensions !== undefined) this.extensions = opts.extensions;
  }

  nextReload(...results: ReloadResult[]): this {
    this.reloadQueue.push(...results);
    return this;
  }

  nextRestart(...results: ReloadResult[]): this {
    this.restartQueue.push(...results);
    return this;
  }

  reload(): Promise<ReloadResult> {
    this.reloadCount++;
    return Promise.resolve(this.finish(this.reloadQueue.shift() ?? OK_RELOAD));
  }

  restart(): Promise<ReloadResult> {
    this.restartCount++;
    return Promise.resolve(this.finish(this.restartQueue.shift() ?? OK_RESTART));
  }

  logs(): RingBufferLogSource {
    return this.logSource;
  }

  db(): DbInspector | undefined {
    return this.dbInspector;
  }

  detach(): Promise<void> {
    this.detached = true;
    if (this.extensions !== undefined) this.extensions.detached = true;
    return Promise.resolve();
  }

  on<E extends keyof AppSessionEvents>(
    event: E,
    cb: (payload: AppSessionEvents[E]) => void,
  ): () => void {
    return this.events.on(event, cb);
  }

  /** Simulates the app process ending. */
  simulateExit(code?: number): void {
    this.events.emit('exit', code === undefined ? {} : { code });
  }

  /** Simulates a reload by Claude or the IDE, which FlutterDeck only observes. */
  simulateExternalReload(result: ReloadResult = { ok: true, kind: 'hot-reload' }): void {
    this.events.emit('reloaded', { ...result, source: 'external' });
  }

  simulateError(message: string): void {
    this.events.emit('error', { message });
  }

  private finish(result: ReloadResult): ReloadResult {
    if (this.detached) return NOT_ATTACHED;
    this.events.emit('reloaded', result);
    return result;
  }
}

/** In-memory connector. Add and remove apps to drive `onAppsChanged`. */
export class FakeAppConnector implements AppConnector {
  started = false;
  readonly sessions = new Map<string, FakeAppSession>();
  private apps: RunningApp[];
  private readonly listeners = new Set<(apps: RunningApp[]) => void>();

  constructor(
    readonly id = 'fake',
    apps: RunningApp[] = [],
    private readonly sessionOptions: (app: RunningApp) => FakeAppSessionOptions = () => ({}),
  ) {
    this.apps = [...apps];
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.sessions.values()].map((s) => s.detach()));
    this.sessions.clear();
  }

  listApps(): Promise<RunningApp[]> {
    return Promise.resolve([...this.apps]);
  }

  onAppsChanged(cb: (apps: RunningApp[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  attach(appId: string): Promise<FakeAppSession> {
    const app = this.apps.find((a) => a.id === appId);
    if (app === undefined) return Promise.reject(new Error(`No running app with id '${appId}'`));
    let session = this.sessions.get(appId);
    if (session === undefined || session.detached) {
      session = new FakeAppSession(app, this.sessionOptions(app));
      this.sessions.set(appId, session);
    }
    return Promise.resolve(session);
  }

  addApp(app: RunningApp): void {
    this.apps = [...this.apps.filter((a) => a.id !== app.id), app];
    this.notify();
  }

  /** Simulates the app stopping: its session sees `exit`. */
  removeApp(appId: string): void {
    this.apps = this.apps.filter((a) => a.id !== appId);
    this.sessions.get(appId)?.simulateExit();
    this.sessions.delete(appId);
    this.notify();
  }

  private notify(): void {
    const snapshot = [...this.apps];
    for (const cb of this.listeners) cb(snapshot);
  }
}

export function fakeApp(overrides: Partial<RunningApp> = {}): RunningApp {
  return {
    id: 'app-1',
    name: 'com.example.shop',
    device: { id: 'emulator-5554', name: 'Pixel 9 API 36', platform: 'android' },
    framework: 'flutter',
    startedBy: 'ide',
    ...overrides,
  };
}
