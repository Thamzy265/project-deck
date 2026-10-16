import type { AppExtensionCallOptions, AppExtensions } from '../extensions.js';
import {
  AppExtensionError,
  DEFAULT_EXTENSION_PREFIXES,
  checkEventKind,
  checkExtensionCall,
  extensionTimeout,
} from '../extensions.js';

export type FakeExtensionHandler = (params: Record<string, string>) => unknown;

/**
 * Programmable app extensions: `handle()` registers a method, `emit()` posts an event.
 * Validates calls exactly like a real connector, so tests catch disallowed methods.
 */
export class FakeAppExtensions implements AppExtensions {
  readonly calls: { method: string; params: Record<string, string> }[] = [];
  detached = false;
  private readonly handlers = new Map<string, FakeExtensionHandler>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(private readonly prefixes: readonly string[] = DEFAULT_EXTENSION_PREFIXES) {}

  handle(method: string, handler: FakeExtensionHandler): this {
    checkExtensionCall(method, {}, this.prefixes);
    this.handlers.set(method, handler);
    return this;
  }

  /** Simulates the app unregistering an extension, e.g. after a hot restart. */
  remove(method: string): this {
    this.handlers.delete(method);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async call(
    method: string,
    params: Record<string, string>,
    opts: AppExtensionCallOptions = {},
  ): Promise<unknown> {
    checkExtensionCall(method, params, this.prefixes);
    if (this.detached) throw new AppExtensionError('detached', 'The app stopped');
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw new AppExtensionError('not-found', `The app has no extension '${method}'`);
    }
    this.calls.push({ method, params: { ...params } });
    const timeoutMs = extensionTimeout(opts.timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AppExtensionError('timeout', `${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => handler(params)), timeout]);
    } catch (err) {
      if (err instanceof AppExtensionError) throw err;
      throw new AppExtensionError('failed', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  onEvent(kind: string, cb: (data: unknown) => void): () => void {
    checkEventKind(kind, this.prefixes);
    let set = this.listeners.get(kind);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Posts an event as the app would. Kinds nobody listens to are dropped. */
  emit(kind: string, data: unknown): void {
    for (const cb of [...(this.listeners.get(kind) ?? [])]) cb(data);
  }
}
