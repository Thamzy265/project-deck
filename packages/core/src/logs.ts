import { z } from 'zod';

export const LOG_LEVELS = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** True when `level` is at least as severe as `min`. */
export function isAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}

export const LogEntrySchema = z.object({
  /** Epoch milliseconds. */
  ts: z.number(),
  level: LogLevelSchema,
  source: z.enum(['app', 'framework', 'native', 'tool']),
  tag: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const DEFAULT_LOG_LIMIT = 200;
/**
 * Regex filters run on the daemon's only thread, so keep patterns short and
 * only test them against the start of each entry. This bounds, but cannot fully
 * prevent, catastrophic backtracking (no native RE2 allowed).
 */
export const MAX_LOG_REGEX_LENGTH = 200;
export const MAX_REGEX_HAYSTACK = 4096;
export const MAX_LOG_LIMIT = 5000;

export const LogQuerySchema = z.object({
  /** Only entries with `ts >= since`. */
  since: z.number().optional(),
  minLevel: LogLevelSchema.optional(),
  /** Case-insensitive substring match on message and stack. */
  text: z.string().optional(),
  /** JavaScript regular expression matched against message and stack. */
  regex: z
    .string()
    .max(MAX_LOG_REGEX_LENGTH)
    .refine(isValidRegex, { message: 'Invalid regular expression' })
    .optional(),
  tag: z.string().optional(),
  /** Most recent N matches. */
  limit: z.number().int().positive().max(MAX_LOG_LIMIT).optional(),
});
export type LogQuery = z.infer<typeof LogQuerySchema>;

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export interface LogSource {
  /** Matching entries, oldest first. */
  query(q: LogQuery): Promise<LogEntry[]>;
  subscribe(cb: (entry: LogEntry) => void): () => void;
  clear(): void;
}

/** Builds a predicate for a validated query. Shared by every LogSource so filtering is identical. */
export function logMatcher(q: LogQuery): (e: LogEntry) => boolean {
  const text = q.text?.toLowerCase();
  const re = q.regex === undefined ? undefined : new RegExp(q.regex);
  return (e) => {
    if (q.since !== undefined && e.ts < q.since) return false;
    if (q.minLevel !== undefined && !isAtLeast(e.level, q.minLevel)) return false;
    if (q.tag !== undefined && e.tag !== q.tag) return false;
    const haystack = e.stack === undefined ? e.message : `${e.message}\n${e.stack}`;
    if (text !== undefined && !haystack.toLowerCase().includes(text)) return false;
    if (re !== undefined && !re.test(haystack.slice(0, MAX_REGEX_HAYSTACK))) return false;
    return true;
  };
}

export const DEFAULT_LOG_CAPACITY = 20_000;

/** In-memory LogSource that keeps the newest `capacity` entries. */
export class RingBufferLogSource implements LogSource {
  private readonly entries: (LogEntry | undefined)[];
  private start = 0;
  private size = 0;
  private readonly listeners = new Set<(e: LogEntry) => void>();

  constructor(readonly capacity: number = DEFAULT_LOG_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.entries = new Array<LogEntry | undefined>(capacity);
  }

  push(entry: LogEntry): void {
    const end = (this.start + this.size) % this.capacity;
    this.entries[end] = entry;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
    for (const cb of this.listeners) cb(entry);
  }

  query(q: LogQuery): Promise<LogEntry[]> {
    const matches = logMatcher(q);
    const limit = q.limit ?? DEFAULT_LOG_LIMIT;
    const out: LogEntry[] = [];
    // Walk newest to oldest so the limit keeps the most recent matches.
    for (let i = this.size - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[(this.start + i) % this.capacity];
      if (e !== undefined && matches(e)) out.push(e);
    }
    return Promise.resolve(out.reverse());
  }

  subscribe(cb: (entry: LogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  clear(): void {
    this.entries.fill(undefined);
    this.start = 0;
    this.size = 0;
  }
}
