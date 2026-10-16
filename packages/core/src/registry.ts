import type { AppConnector, RunningApp } from './apps.js';
import type { DbInspector } from './db.js';
import { DEFAULT_EXTENSION_PREFIXES, isValidExtensionPrefix } from './extensions.js';
import type { LogEntry } from './logs.js';
import type { TaskProvider } from './tasks.js';

/**
 * Creates a database inspector for an app without going through its connector,
 * e.g. the SQLite snapshot backend that pulls the file over adb.
 * Inspectors that need the live session (Drift over the VM service) come from
 * `AppSession.db()` instead; the daemon prefers those and falls back to factories.
 */
export interface DbInspectorFactory {
  readonly id: string;
  /** Resolves to undefined when this backend can't serve the app. */
  create(app: RunningApp): Promise<DbInspector | undefined>;
}

/**
 * Extra log stream for an app beyond what its session provides,
 * e.g. Android native logs from `adb logcat`. The daemon merges every feed
 * into the app's log buffer.
 */
export interface LogFeedFactory {
  readonly id: string;
  /**
   * Starts streaming entries for the app. Resolves to a close function,
   * or undefined when this feed doesn't apply to the app.
   */
  open(
    app: RunningApp,
    onEntry: (entry: LogEntry) => void,
  ): Promise<(() => Promise<void>) | undefined>;
}

/** A set of implementations keyed by their `id`. */
export class Catalog<T extends { readonly id: string }> {
  private readonly items = new Map<string, T>();

  constructor(private readonly kind: string) {}

  /** Throws if the id is taken. Returns a function that unregisters the item. */
  register(item: T): () => void {
    if (this.items.has(item.id)) {
      throw new Error(`A ${this.kind} with id '${item.id}' is already registered`);
    }
    this.items.set(item.id, item);
    return () => {
      if (this.items.get(item.id) === item) this.items.delete(item.id);
    };
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const item = this.items.get(id);
    if (item === undefined) throw new Error(`No ${this.kind} registered with id '${id}'`);
    return item;
  }

  list(): T[] {
    return [...this.items.values()];
  }
}

/**
 * The one place framework- and tracker-specific packages plug in.
 * Code outside those packages looks implementations up here instead of
 * branching on framework or provider names.
 */
export class Registry {
  readonly connectors = new Catalog<AppConnector>('connector');
  readonly dbInspectors = new Catalog<DbInspectorFactory>('database inspector');
  readonly logFeeds = new Catalog<LogFeedFactory>('log feed');
  readonly taskProviders = new Catalog<TaskProvider>('task provider');
  /** Prefixes backends added, with how many hold each (the defaults are always on). */
  private readonly prefixHolds = new Map<string, number>();

  /**
   * App extension prefixes connectors may call (ADR 0004). Backends add the ones they
   * use; Flutter's, Drift's and Dart's own extensions can never be added. Each call
   * returns its own release: a prefix stays until every backend that added it releases.
   */
  allowExtensionPrefix(prefix: string): () => void {
    if (!isValidExtensionPrefix(prefix)) throw new Error(`Invalid extension prefix '${prefix}'`);
    this.prefixHolds.set(prefix, (this.prefixHolds.get(prefix) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const holds = (this.prefixHolds.get(prefix) ?? 1) - 1;
      if (holds > 0) this.prefixHolds.set(prefix, holds);
      else this.prefixHolds.delete(prefix);
    };
  }

  extensionPrefixes(): string[] {
    return [...new Set([...DEFAULT_EXTENSION_PREFIXES, ...this.prefixHolds.keys()])];
  }
}
