import type { ActivityEntry } from './activity.js';
import type { ReloadResult, RunningApp } from './apps.js';
import type { LogEntry } from './logs.js';
import type { Task } from './tasks.js';

/** Everything the daemon broadcasts to the dashboard and activity feed. */
export interface DeckEvents {
  'apps.changed': { connectorId: string; apps: RunningApp[] };
  /** Discovery started or finished; while true, an empty app list isn't final. */
  'apps.discovering': { discovering: boolean };
  'app.attached': { app: RunningApp };
  'app.detached': { appId: string };
  'app.reloaded': { appId: string; result: ReloadResult };
  /** The app went away by itself. `crashed`: an error log line arrived within 5 s before. */
  'app.exit': { appId: string; code?: number; crashed: boolean };
  'app.log': { appId: string; entry: LogEntry };
  /** The log buffer was emptied (epoch ms), so every open dashboard empties its list too. */
  'logs.cleared': { at: number };
  'task.current': { task: Task | null };
  'claude.done': { sessionId?: string };
  'claude.waiting': { sessionId?: string; message?: string };
  /** Outcome of Claude's hot_reload or hot_restart call, from the reload hook. */
  'claude.reload': {
    sessionId?: string;
    ok: boolean;
    kind: 'hot-reload' | 'hot-restart';
    message?: string;
  };
  /**
   * Rows of a table in a live database changed (coalesced to at most one per table per
   * 250 ms). Names only, never row values: open views re-query.
   */
  'db.changed': { source: string; db: string; table: string };
  /** A new Activity feed entry, already stored. */
  activity: ActivityEntry;
}

type Listener<P> = (payload: P) => void;
type AnyListener<Events> = <E extends keyof Events>(event: E, payload: Events[E]) => void;

/** Synchronous typed pub/sub. A throwing listener never stops the others. */
export class EventBus<Events extends object = DeckEvents> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  private readonly anyListeners = new Set<AnyListener<Events>>();

  constructor(
    private readonly onListenerError: (err: unknown, event: keyof Events) => void = (
      err,
      event,
    ) => {
      console.error(`Listener for '${String(event)}' threw`, err);
    },
  ) {}

  on<E extends keyof Events>(event: E, cb: Listener<Events[E]>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Receives every event, e.g. to forward them over a WebSocket. */
  onAny(cb: AnyListener<Events>): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.listeners.get(event) as Set<Listener<Events[E]>> | undefined;
    for (const cb of [...(set ?? [])]) this.call(event, () => cb(payload));
    for (const cb of [...this.anyListeners]) this.call(event, () => cb(event, payload));
  }

  private call(event: keyof Events, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.onListenerError(err, event);
    }
  }
}
