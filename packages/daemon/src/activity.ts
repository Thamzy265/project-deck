import type { ActivityEntry, EventBus } from '@project-deck/core';
import { ACTIVITY_CAPACITY } from '@project-deck/core';

/**
 * A hook result this close to a VM "success" for the same kind is the same reload. The VM
 * says "success" even when it rejected the reload, and says nothing when the code didn't
 * compile, so the hook's result (which knows the tool's outcome) wins.
 */
export const RELOAD_MERGE_WINDOW_MS = 3000;

type ReloadKind = 'hot-reload' | 'hot-restart';

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
  /** Recent hook results not yet paired with a VM event that may still come. */
  private unpairedHooks: { ts: number; kind: ReloadKind }[] = [];
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
        if (result.ok && result.source === 'external' && this.pairWithHook(result.kind)) return;
        this.add({ kind: 'app.reloaded', ...this.app(appId), result });
      }),
      this.bus.on('claude.reload', ({ sessionId, ok, kind, message }) => {
        this.claudeReload({
          kind: 'claude.reload',
          ...(sessionId === undefined ? {} : { sessionId }),
          ok,
          reload: kind,
          ...(message === undefined ? {} : { message }),
          ...(this.attached === undefined
            ? {}
            : { appId: this.attached.id, appName: this.attached.name }),
        });
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

  /** Replaces the VM's report of the same reload, if one came just before. */
  private claudeReload(fields: Extract<NewEntry, { kind: 'claude.reload' }>): void {
    const now = this.now();
    const at = this.entries.findLastIndex(
      (e) =>
        now - e.ts <= RELOAD_MERGE_WINDOW_MS &&
        e.kind === 'app.reloaded' &&
        e.result.ok &&
        e.result.source === 'external' &&
        e.result.kind === fields.reload,
    );
    const old = this.entries[at];
    if (old === undefined) {
      this.unpairedHooks = [
        ...this.unpairedHooks.filter((h) => now - h.ts <= RELOAD_MERGE_WINDOW_MS),
        { ts: now, kind: fields.reload },
      ];
      this.add(fields);
      return;
    }
    // Same id and time: dashboards replace the row in place.
    const entry = { id: old.id, ts: old.ts, ...fields };
    this.entries[at] = entry;
    queueMicrotask(() => this.bus.emit('activity', entry));
  }

  /** True when a hook result just came for this reload, so the VM's report is dropped. */
  private pairWithHook(kind: string): boolean {
    if (this.unpairedHooks.length === 0) return false;
    const now = this.now();
    const at = this.unpairedHooks.findIndex(
      (h) => h.kind === kind && now - h.ts <= RELOAD_MERGE_WINDOW_MS,
    );
    if (at === -1) return false;
    this.unpairedHooks.splice(at, 1);
    return true;
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
