import type { ActivityEntry, EventBus } from '@project-deck/core';
import { ACTIVITY_CAPACITY, MAX_ACTIVITY_NAME, MAX_ACTIVITY_TABLES } from '@project-deck/core';

/**
 * A name from the app's database, cut to what an entry keeps: one long name must not
 * make the whole `/api/activity` answer invalid (review R6). A cut surrogate pair is
 * dropped whole.
 */
function cut(name: string): string {
  if (name.length <= MAX_ACTIVITY_NAME) return name;
  return name.slice(0, MAX_ACTIVITY_NAME).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * How close a hook result and a VM "success" of the same kind must be to count as one
 * reload (lead decision 15 Oct 2026, design note "Seeing reloads"):
 * - A FAILED hook result replaces a VM success from the 3 s before it: the VM says
 *   "success" even when it rejected the reload. Otherwise it is its own row, and it never
 *   hides a later VM event (a compile failure posts none, so a later one is another reload).
 * - A SUCCESSFUL hook result is a duplicate of a VM success from the 3 s before it and adds
 *   nothing (that row already reads "from Claude or the IDE"). Otherwise it is its own row
 *   and hides the next VM success within 3 s after it. It never replaces an earlier row.
 * - A FAILED hook result also replaces an external VM failure from the 3 s before it,
 *   whatever its kind (a VM failure has none), so one failure is one row.
 * Each VM row pairs with one hook result at most.
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
  /** Recent successful hook results whose VM event may still come. */
  private unpairedHooks: { ts: number; kind: ReloadKind }[] = [];
  /** Ids of recent VM rows a successful hook result already counted as its own. */
  private pairedVmRows: { id: number; ts: number }[] = [];
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
      this.bus.on('db.snapshot', ({ db }) => this.add({ kind: 'db.snapshot', db: cut(db) })),
      this.bus.on('db.diff', ({ db }) => this.add({ kind: 'db.diff', db: cut(db) })),
      this.bus.on('db.write', ({ db, tables, allowed, changes }) => {
        this.add({
          kind: 'db.write',
          db: cut(db),
          tables: tables.slice(0, MAX_ACTIVITY_TABLES).map(cut),
          allowed,
          ...(changes === undefined ? {} : { changes }),
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
    this.pairedVmRows = this.pairedVmRows.filter((p) => now - p.ts <= RELOAD_MERGE_WINDOW_MS);
    // The oldest free one: hook results arrive in the order of their reloads (C4).
    const at = this.entries.findIndex(
      (e) =>
        now - e.ts <= RELOAD_MERGE_WINDOW_MS &&
        e.kind === 'app.reloaded' &&
        e.result.source === 'external' &&
        // A VM failure carries no kind; a failed hook result is the same failure (C3).
        (e.result.ok ? e.result.kind === fields.reload : !fields.ok) &&
        !this.pairedVmRows.some((p) => p.id === e.id),
    );
    const old = this.entries[at];
    if (fields.ok) {
      if (old !== undefined) {
        this.pairedVmRows.push({ id: old.id, ts: old.ts });
        return;
      }
      this.unpairedHooks = [
        ...this.unpairedHooks.filter((h) => now - h.ts <= RELOAD_MERGE_WINDOW_MS),
        { ts: now, kind: fields.reload },
      ];
      this.add(fields);
      return;
    }
    if (old === undefined) {
      this.add(fields);
      return;
    }
    // Same id and time: dashboards replace the row in place.
    // It is the VM row's reload, so it keeps that row's app (C5).
    const app = old.kind === 'app.reloaded' ? { appId: old.appId, appName: old.appName } : {};
    const entry = { id: old.id, ts: old.ts, ...fields, ...app };
    this.entries[at] = entry;
    queueMicrotask(() => this.bus.emit('activity', entry));
  }

  /** True when a successful hook result just came for this reload: the VM's is a duplicate. */
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
