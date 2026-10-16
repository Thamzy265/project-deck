import type { AppExtensionCallOptions, AppExtensions } from '@project-deck/core';
import {
  AppExtensionError,
  checkEventKind,
  checkExtensionCall,
  extensionTimeout,
  isAllowedExtensionMethod,
} from '@project-deck/core';
import { z } from 'zod';
import type { JsonRpcClient } from './json-rpc.js';
import { CallTimeoutError, ConnectionClosedError, JsonRpcError } from './json-rpc.js';

/** What the extensions need from their session. */
export interface ExtensionHost {
  readonly rpc: JsonRpcClient;
  /** The app's main isolate, if known. */
  mainIsolate(): string | undefined;
  /** Re-reads the main isolate, e.g. after a hot restart replaced it. */
  refreshMainIsolate(): Promise<void>;
}

const METHOD_NOT_FOUND = -32601;
/** dart:developer's ServiceExtensionResponse.extensionErrorMin / Max. */
const EXTENSION_ERROR_MIN = -32016;
const EXTENSION_ERROR_MAX = -32000;
/** Error text comes from app code; keep enough to read, not a whole stack. */
const MAX_ERROR_MESSAGE = 500;

const IsolateSchema = z.object({
  extensionRPCs: z.array(z.string()).optional().catch(undefined),
});
const SentinelSchema = z.object({ type: z.literal('Sentinel') }).loose();

function shorten(text: string): string {
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE - 1)}…` : text;
}

/**
 * App extensions over the VM service (ADR 0004). A method is called on the isolate that
 * announced it (ServiceExtensionAdded or Isolate.extensionRPCs), else on the main
 * isolate. Events reach listeners only from isolates that announced an allowed
 * extension, so another isolate can't pose as flutterdeck_drift.
 */
export class VmExtensions implements AppExtensions {
  /** Allowed method → the isolate that announced it most recently. */
  private readonly owners = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(
    private readonly host: ExtensionHost,
    private readonly prefixes: () => readonly string[],
    private readonly onListenerError: (err: unknown) => void = () => undefined,
  ) {}

  has(method: string): boolean {
    return isAllowedExtensionMethod(method, this.prefixes()) && this.owners.has(method);
  }

  async call(
    method: string,
    params: Record<string, string>,
    opts: AppExtensionCallOptions = {},
  ): Promise<unknown> {
    checkExtensionCall(method, params, this.prefixes());
    const timeoutMs = extensionTimeout(opts.timeoutMs);
    const first = await this.target(method);
    const result = await this.send(method, params, first, timeoutMs);
    if (!SentinelSchema.safeParse(result).success) return result;
    // The isolate is gone, usually replaced by a hot restart: find the new one once.
    this.dropIsolate(first);
    await this.host.refreshMainIsolate().catch(() => undefined);
    const second = await this.target(method);
    if (second !== first) {
      const retried = await this.send(method, params, second, timeoutMs);
      if (!SentinelSchema.safeParse(retried).success) return retried;
      this.dropIsolate(second);
    }
    throw new AppExtensionError('detached', 'The app stopped');
  }

  onEvent(kind: string, cb: (data: unknown) => void): () => void {
    checkEventKind(kind, this.prefixes());
    let set = this.listeners.get(kind);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Reads what an isolate registered before we attached. Best effort. */
  async load(isolateId: string): Promise<void> {
    try {
      const isolate = IsolateSchema.safeParse(
        await this.host.rpc.call('getIsolate', { isolateId }),
      );
      if (!isolate.success) return;
      for (const method of isolate.data.extensionRPCs ?? []) this.added(method, isolateId);
    } catch {
      // Not runnable yet, or gone: its ServiceExtensionAdded events will follow.
    }
  }

  /** ServiceExtensionAdded on the Isolate stream. */
  added(method: string, isolateId: string): void {
    if (isAllowedExtensionMethod(method, this.prefixes())) this.owners.set(method, isolateId);
  }

  /** IsolateExit, or a Sentinel for the isolate. */
  dropIsolate(isolateId: string | undefined): void {
    for (const [method, owner] of this.owners) {
      if (owner === isolateId) this.owners.delete(method);
    }
  }

  /** The connection closed: nothing is callable any more. */
  clear(): void {
    this.owners.clear();
  }

  /** An `Extension` event from the app. */
  event(isolateId: string | undefined, kind: string, data: unknown): void {
    if (isolateId === undefined || ![...this.owners.values()].includes(isolateId)) return;
    for (const cb of [...(this.listeners.get(kind) ?? [])]) {
      try {
        cb(data);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  private async target(method: string): Promise<string> {
    if (this.host.rpc.closed) throw new AppExtensionError('detached', 'The app stopped');
    const owner = this.owners.get(method);
    if (owner !== undefined) return owner;
    if (this.host.mainIsolate() === undefined) {
      await this.host.refreshMainIsolate().catch(() => undefined);
    }
    const main = this.host.mainIsolate();
    if (main === undefined)
      throw new AppExtensionError('detached', 'The app has no running isolate');
    return main;
  }

  private async send(
    method: string,
    params: Record<string, string>,
    isolateId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.host.rpc.call(method, { ...params, isolateId }, { timeoutMs });
    } catch (err) {
      throw this.mapError(method, err);
    }
  }

  private mapError(method: string, err: unknown): AppExtensionError {
    if (err instanceof ConnectionClosedError) {
      return new AppExtensionError('detached', 'The app stopped');
    }
    if (err instanceof CallTimeoutError) {
      return new AppExtensionError(
        'timeout',
        `${method} got no answer within ${err.timeoutMs} ms. The app may be paused in the debugger or busy.`,
      );
    }
    if (err instanceof JsonRpcError) {
      if (err.code === METHOD_NOT_FOUND) {
        this.owners.delete(method);
        return new AppExtensionError('not-found', `The app has no extension ${method}`);
      }
      if (
        err.code !== undefined &&
        err.code >= EXTENSION_ERROR_MIN &&
        err.code <= EXTENSION_ERROR_MAX
      ) {
        return new AppExtensionError('failed', shorten(err.message));
      }
      const code = err.code === undefined ? 'no code' : `code ${err.code}`;
      return new AppExtensionError('failed', shorten(`VM service error (${code}): ${err.message}`));
    }
    return new AppExtensionError(
      'failed',
      shorten(err instanceof Error ? err.message : String(err)),
    );
  }
}
