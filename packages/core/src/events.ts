import type { ReloadResult, RunningApp } from './apps.js';
import type { LogEntry } from './logs.js';
import type { Task } from './tasks.js';

/** Everything the daemon broadcasts to the dashboard and activity feed. */
export interface DeckEvents {
  'apps.changed': { connectorId: string; apps: RunningApp[] };
  'app.attached': { app: RunningApp };
  'app.detached': { appId: string };
  'app.reloaded': { appId: string; result: ReloadResult };
  'app.exit': { appId: string; code?: number };
  'app.log': { appId: string; entry: LogEntry };
  'task.current': { task: Task | null };
  'claude.done': { sessionId?: string };
  'claude.waiting': { sessionId?: string; message?: string };
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
