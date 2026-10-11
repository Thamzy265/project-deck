import type { LogEntry, LogLevel } from '@project-deck/core';

/** Maps package:logging / dart:developer levels (0–2000) to ours. */
export function levelFromDart(level: number): LogLevel {
  // developer.log defaults to 0, which people use for ordinary messages.
  if (level === 0) return 'info';
  if (level <= 400) return 'verbose'; // FINEST, FINER
  if (level <= 700) return 'debug'; // FINE, CONFIG
  if (level <= 800) return 'info';
  if (level <= 900) return 'warn';
  if (level <= 1000) return 'error'; // SEVERE
  return 'fatal'; // SHOUT
}

/** Text of an `@Instance` reference, or undefined for null / non-string values. */
export function instanceText(ref: unknown): string | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined;
  const r = ref as { kind?: unknown; valueAsString?: unknown; valueAsStringIsTruncated?: unknown };
  if (r.kind === 'Null' || typeof r.valueAsString !== 'string') return undefined;
  return r.valueAsStringIsTruncated === true ? `${r.valueAsString}…` : r.valueAsString;
}

/** Converts a VM service `Logging` event's `logRecord` into a LogEntry. */
export function entryFromLogRecord(record: unknown, fallbackTs: number): LogEntry | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const r = record as {
    message?: unknown;
    level?: unknown;
    time?: unknown;
    loggerName?: unknown;
    error?: unknown;
    stackTrace?: unknown;
  };
  const message = instanceText(r.message);
  if (message === undefined) return undefined;
  const error = instanceText(r.error);
  const tag = instanceText(r.loggerName);
  const stack = instanceText(r.stackTrace);
  return {
    ts: typeof r.time === 'number' ? r.time : fallbackTs,
    level: levelFromDart(typeof r.level === 'number' ? r.level : 0),
    source: 'app',
    message: error === undefined ? message : `${message}\n${error}`,
    ...(tag === undefined || tag === '' ? {} : { tag }),
    ...(stack === undefined || stack === '' ? {} : { stack }),
  };
}

/**
 * Reassembles lines from `WriteEvent` chunks: `print` sends the text and the
 * newline as separate events. A partial line is flushed after a short idle gap.
 */
export class LineBuffer {
  private partial = '';
  /** When the first chunk of the pending line arrived; replayed history keeps its real time. */
  private partialTs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onLine: (line: string, ts: number) => void,
    private readonly idleFlushMs = 250,
  ) {}

  write(chunk: string, ts: number): void {
    if (this.partial === '') this.partialTs = ts;
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.onLine(line.replace(/\r$/, ''), this.partialTs);
      this.partialTs = ts;
    }
    clearTimeout(this.timer);
    this.timer = this.partial === '' ? undefined : setTimeout(() => this.flush(), this.idleFlushMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.partial === '') return;
    const line = this.partial.replace(/\r$/, '');
    this.partial = '';
    this.onLine(line, this.partialTs);
  }
}
