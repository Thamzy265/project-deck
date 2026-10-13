import { DaemonAlreadyRunningError } from './daemon.js';

/**
 * One readable line for the terminal; stacks only help when debugging the daemon itself.
 * Never throws: it runs in the last-resort handler, where a second error would hide the first.
 */
export function formatStartupError(err: unknown): string {
  if (err instanceof DaemonAlreadyRunningError) return err.message;
  return `project-deck daemon could not start: ${oneLine(describe(err))}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function describe(err: unknown, depth = 0): string {
  try {
    if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return String(err);
    const message = stringProp(err, 'message');
    if (message !== undefined) return message;
    if (err instanceof AggregateError && depth < 3) {
      const inner = Array.from(err.errors as unknown[], (e) => describe(e, depth + 1));
      if (inner.length > 0) return inner.join('; ');
    }
    const code = stringProp(err, 'code');
    if (code !== undefined) return code;
    const name = stringProp(err, 'name');
    if (name !== undefined) return name;
    return 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/** A non-empty string property, read without triggering a throwing toString. */
function stringProp(obj: object, key: string): string | undefined {
  const value: unknown = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
