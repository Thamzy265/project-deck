import type { ActivityEntry, EventBus } from '@project-deck/core';
import { ACTIVITY_CAPACITY } from '@project-deck/core';

export interface ActivityFeedOptions {
  capacity?: number;
  now?: () => number;
}

/** ActivityEntry without the fields the feed assigns. */
type NewEntry = ActivityEntry extends infer E
  ? E extends ActivityEntry
    ? Omit<E, 'id' | 'ts'>
    : never
  : never;

/**
 * Turns bus events into Activity entries, keeps the newest `capacity` in memory, and
 * announces each one as an `activity` event. Entries are built field by field, so
 * nothing a hook sends beyond the schema (such as Stop's last_assistant_message) is kept.
 */
export class ActivityFeed {
  private readonly entries: ActivityEntry[] = [];
  /**
   * Names for entries: the apps in the latest list, plus the attached app, which may
   * already have left the list when its exit arrives. Nothing else is kept, so this
   * never grows past the current app list.
   */
  private listed = new Map<string, string>();
  private attached: { id: string; name: string } | undefined;
  private nextId = 0;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(
    private readonly bus: EventBus,
    opts: ActivityFeedOptions = {},
  ) {
    this.capacity = opts.capacity ?? ACTIVITY_CAPACITY;
    this.now = opts.now ?? Date.now;
  }

  /** Subscribes to the bus. Returns a function that unsubscribes. */
  start(): () => void {
    const offs = [
      this.bus.on('apps.changed', ({ apps }) => {
        this.listed = new Map(apps.map((app) => [app.id, app.name]));
      }),
      this.bus.on('app.attached', ({ app }) => {
        this.attached = { id: app.id, name: app.name };
        this.add({ kind: 'app.attached', ...this.app(app.id) });
      }),
      this.bus.on('app.detached', ({ appId }) => {
        this.add({ kind: 'app.detached', ...this.app(appId) });
        this.forgetAttached(appId);
      }),
      this.bus.on('app.reloaded', ({ appId, result }) => {
        this.add({ kind: 'app.reloaded', ...this.app(appId), result });
      }),
      this.bus.on('app.exit', ({ appId, code, crashed }) => {
        this.add({
          kind: crashed ? 'app.crashed' : 'app.stopped',
          ...this.app(appId),
          ...(code === undefined ? {} : { code }),
        });
        this.forgetAttached(appId);
      }),
      this.bus.on('claude.done', ({ sessionId }) => {
        this.add({ kind: 'claude.done', ...(sessionId === undefined ? {} : { sessionId }) });
      }),
      this.bus.on('claude.waiting', ({ sessionId, message }) => {
        this.add({
          kind: 'claude.waiting',
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(message === undefined ? {} : { message }),
        });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /** Oldest first. */
  list(): ActivityEntry[] {
    return [...this.entries];
  }

  private app(appId: string): { appId: string; appName: string } {
    const name = this.attached?.id === appId ? this.attached.name : this.listed.get(appId);
    return { appId, appName: name ?? appId };
  }

  private forgetAttached(appId: string): void {
    if (this.attached?.id === appId) this.attached = undefined;
  }

  private add(fields: NewEntry): void {
    const entry = { id: this.nextId++, ts: this.now(), ...fields };
    this.entries.push(entry);
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
    // After the current dispatch, so WebSocket clients see the source event first.
    queueMicrotask(() => this.bus.emit('activity', entry));
  }
}
