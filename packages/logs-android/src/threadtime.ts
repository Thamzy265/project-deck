import type { LogEntry, LogLevel } from '@project-deck/core';

/** One entry never holds more lines than this; a runaway dump can't exhaust memory. */
export const MAX_LINES_PER_ENTRY = 200;
/** Longest line kept; the rest of it is dropped. */
export const MAX_LINE_LENGTH = 64 * 1024;

const LEVELS: Record<string, LogLevel> = {
  V: 'verbose',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'fatal',
  A: 'fatal',
};

/**
 * `MM-DD HH:MM:SS.mmm  PID  TID L TAG     : message`. The tag is padded with spaces
 * before the colon; the message starts after the first `: ` (or is empty).
 */
const HEADER =
  /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+) ([VDIWEFA]) (.*?)\s*:(?: (.*))?$/;
const FRAME = /^\s+at |^\s+\.\.\. \d+ more$/;

interface Pending {
  /** Everything before the message: lines with the same header belong to one log call. */
  key: string;
  ts: number;
  level: LogLevel;
  tag: string;
  first: string;
  rest: string[];
  dropped: boolean;
}

/** How far ahead of the host a device clock may run before a line is taken as last year's. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch ms for a threadtime timestamp, read as local time. The format has no year, so
 * take the latest year that doesn't put the line in the future: a December line read
 * on 1 January is last year's, and a 1 January line from a device clock slightly ahead
 * on 31 December is next year's.
 */
export function timestampFor(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  now: Date,
): number {
  const at = (y: number): number => new Date(y, month - 1, day, hour, minute, second, ms).getTime();
  const limit = now.getTime() + CLOCK_SKEW_MS;
  const year = now.getFullYear();
  for (const y of [year + 1, year]) {
    const t = at(y);
    if (t <= limit) return t;
  }
  return at(year - 1);
}

/**
 * Turns `adb logcat -v threadtime` output into log entries. logcat prints a multi-line
 * message (such as a Java stack trace) as one line per text line with the same header,
 * so consecutive lines with an identical header are joined into one entry. The last
 * entry is held until a different header arrives or `flush()` is called.
 */
export class ThreadtimeParser {
  private partial = '';
  private pending: Pending | undefined;

  constructor(
    private readonly onEntry: (entry: LogEntry) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(chunk: string): void {
    const lines = (this.partial + chunk).split('\n');
    this.partial = (lines.pop() ?? '').slice(0, MAX_LINE_LENGTH);
    for (const line of lines) this.line(line.slice(0, MAX_LINE_LENGTH).replace(/\r+$/, ''));
  }

  /** Emits the held entry. Call when the stream goes quiet or ends. */
  flush(): void {
    const p = this.pending;
    if (p === undefined) return;
    this.pending = undefined;
    const rest = p.dropped ? [...p.rest, '… lines dropped'] : p.rest;
    const entry: LogEntry = {
      ts: p.ts,
      level: p.level,
      source: 'native',
      tag: p.tag,
      message: p.first,
    };
    if (rest.some((l) => FRAME.test(l))) entry.stack = rest.join('\n');
    else if (rest.length > 0) entry.message = [p.first, ...rest].join('\n');
    this.onEntry(entry);
  }

  private line(line: string): void {
    const m = HEADER.exec(line);
    if (m === null) {
      // Separators such as `--------- beginning of main`; anything else continues the last entry.
      if (line === '' || line.startsWith('--------- ')) return;
      if (this.pending !== undefined) this.append(this.pending, line);
      return;
    }
    const [, mo, d, h, mi, s, ms, pid, tid, lvl, tag, message] = m;
    const key = `${mo}-${d} ${h}:${mi}:${s}.${ms} ${pid} ${tid} ${lvl} ${tag}`;
    const text = message ?? '';
    if (this.pending?.key === key) {
      this.append(this.pending, text);
      return;
    }
    this.flush();
    this.pending = {
      key,
      ts: timestampFor(
        Number(mo),
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
        Number(ms),
        this.now(),
      ),
      level: LEVELS[lvl ?? ''] ?? 'info',
      tag: tag ?? '',
      first: text,
      rest: [],
      dropped: false,
    };
  }

  private append(p: Pending, text: string): void {
    // Keep one slot for the "dropped" marker.
    if (p.rest.length < MAX_LINES_PER_ENTRY - 1) p.rest.push(text);
    else p.dropped = true;
  }
}
