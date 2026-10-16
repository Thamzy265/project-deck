/**
 * App extensions (ADR 0004): named calls into the running app and events back from it,
 * e.g. `flutterdeck_drift`'s `ext.flutterdeck.drift.v1.*` service extensions. Connectors
 * implement them over their own channel; backends such as db-drift use them through
 * `AppSession.extensions` without knowing the protocol.
 *
 * Only methods under an allowed prefix are ever called (design review D7): the
 * Flutter framework's, Drift's and Dart's own extensions can never be reached, so no
 * client can exit the app, dump state or run SQL through Drift's DevTools extension.
 */

export type AppExtensionErrorCode =
  /** The method name or parameters are malformed. */
  | 'invalid-call'
  /** The method is outside the allowed prefixes. */
  | 'not-allowed'
  /** The app has not registered this extension. */
  | 'not-found'
  | 'timeout'
  /** The session is gone (app exited or detached). */
  | 'detached'
  /** The extension ran and reported an error. Its message is untrusted app text. */
  | 'failed';

export class AppExtensionError extends Error {
  constructor(
    readonly code: AppExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppExtensionError';
  }
}

export interface AppExtensionCallOptions {
  /** Defaults to DEFAULT_EXTENSION_TIMEOUT_MS; capped at MAX_EXTENSION_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface AppExtensions {
  /**
   * Calls an extension on the isolate that registered it. Rejects with an
   * AppExtensionError. Every call has a timeout, the default when none is given.
   */
  call(
    method: string,
    params: Record<string, string>,
    opts?: AppExtensionCallOptions,
  ): Promise<unknown>;
  /** Whether the app has announced this (allowed) extension. */
  has(method: string): boolean;
  /**
   * Listens for app events of one kind (allowed kinds only; throws otherwise). The data
   * is untrusted: consumers validate it with their own zod schema.
   */
  onEvent(kind: string, cb: (data: unknown) => void): () => void;
}

export const DEFAULT_EXTENSION_PREFIXES: readonly string[] = ['ext.flutterdeck.'];
/** Never callable, whatever prefixes are registered. */
const BLOCKED_PREFIXES = ['ext.flutter.', 'ext.drift.', 'ext.dart.', 'ext.dds.'];

export const DEFAULT_EXTENSION_TIMEOUT_MS = 5000;
export const MAX_EXTENSION_TIMEOUT_MS = 60_000;
export const MAX_EXTENSION_PARAMS = 32;
/** Total size of all parameter values: room for the largest SQL text and more. */
export const MAX_EXTENSION_PARAMS_LENGTH = 256 * 1024;

const METHOD = /^ext(\.[a-z0-9_]+)+$/;
const PREFIX = /^ext(\.[a-z0-9_]+)+\.$/;
const EVENT_KIND = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_NAME = 128;

function blocked(name: string): boolean {
  return BLOCKED_PREFIXES.some((p) => name.startsWith(p));
}

/** A prefix must name at least one level below `ext.` and end with a dot. */
export function isValidExtensionPrefix(prefix: string): boolean {
  return prefix.length <= MAX_NAME && PREFIX.test(prefix) && !blocked(prefix);
}

export function isAllowedExtensionMethod(method: string, prefixes: readonly string[]): boolean {
  if (method.length > MAX_NAME || !METHOD.test(method) || blocked(method)) return false;
  return prefixes.some(
    (p) => isValidExtensionPrefix(p) && method.startsWith(p) && method.length > p.length,
  );
}

/** Event kinds mirror the method prefixes without `ext.`: `flutterdeck.drift.tables`. */
export function eventKindAllowed(kind: string, prefixes: readonly string[]): boolean {
  if (kind.length > MAX_NAME || !EVENT_KIND.test(kind)) return false;
  return prefixes.some((p) => {
    if (!isValidExtensionPrefix(p)) return false;
    const eventPrefix = p.slice('ext.'.length);
    return kind.startsWith(eventPrefix) && kind.length > eventPrefix.length;
  });
}

/** Throws an AppExtensionError unless the call may be sent. */
export function checkExtensionCall(
  method: string,
  params: Record<string, string>,
  prefixes: readonly string[],
): void {
  if (!isAllowedExtensionMethod(method, prefixes)) {
    throw new AppExtensionError(
      'not-allowed',
      `Extension '${method.slice(0, MAX_NAME)}' is not allowed`,
    );
  }
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > MAX_EXTENSION_PARAMS) {
    throw new AppExtensionError('invalid-call', 'Too many extension parameters');
  }
  let total = 0;
  for (const [key, value] of entries) {
    // The connector sets isolateId itself; a caller must not pick the isolate.
    if (!PARAM_KEY.test(key) || key === 'isolateId') {
      throw new AppExtensionError('invalid-call', 'Invalid extension parameter name');
    }
    if (typeof value !== 'string') {
      throw new AppExtensionError('invalid-call', 'Extension parameters must be strings');
    }
    total += value.length;
  }
  if (total > MAX_EXTENSION_PARAMS_LENGTH) {
    throw new AppExtensionError('invalid-call', 'Extension parameters are too large');
  }
}

/** Throws unless listeners may subscribe to this event kind. */
export function checkEventKind(kind: string, prefixes: readonly string[]): void {
  if (!eventKindAllowed(kind, prefixes)) {
    throw new AppExtensionError(
      'not-allowed',
      `Event kind '${kind.slice(0, MAX_NAME)}' is not allowed`,
    );
  }
}

export function extensionTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_EXTENSION_TIMEOUT_MS;
  }
  return Math.min(Math.ceil(timeoutMs), MAX_EXTENSION_TIMEOUT_MS);
}
