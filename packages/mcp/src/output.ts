/**
 * Keeps get_logs output small enough for Claude's context (design: ≤ 200 entries and
 * ≤ 20 kB) and says when it was cut. Runs after masking, on masked text.
 */
import type { LogEntry } from '@project-deck/core';

export const MAX_OUTPUT_ENTRIES = 200;
export const MAX_OUTPUT_BYTES = 20_000;

/** What Claude sees of a line: the daemon's own ordering number is left out. */
export type OutputEntry = Omit<LogEntry, 'seq'>;

export interface LogsFrame {
  note: string;
  masking: string;
  warnings: string[];
}

export interface LogsOutput extends LogsFrame {
  entries: OutputEntry[];
  truncated: boolean;
  hint?: string;
}

/**
 * The newest entries that fit both limits, oldest first. `moreMatched` is the daemon's
 * own "truncated": more lines matched than it sent.
 */
export function fitLogs(frame: LogsFrame, entries: LogEntry[], moreMatched: boolean): LogsOutput {
  const all: OutputEntry[] = entries.map(({ seq: _seq, ...rest }) => rest);
  let kept = all.slice(-MAX_OUTPUT_ENTRIES);
  const sizes = kept.map((e) => Buffer.byteLength(JSON.stringify(e)) + 1);
  // The frame, the hint and the JSON punctuation around the list.
  const overhead = Buffer.byteLength(
    JSON.stringify({ ...frame, truncated: true, hint: hint(MAX_OUTPUT_ENTRIES) }),
  );
  let total = overhead + sizes.reduce((a, b) => a + b, 0);
  let drop = 0;
  while (drop < kept.length && total > MAX_OUTPUT_BYTES) total -= sizes[drop++] ?? 0;
  kept = kept.slice(drop);
  const truncated = moreMatched || kept.length < all.length;
  return {
    ...frame,
    entries: kept,
    truncated,
    ...(truncated ? { hint: hint(kept.length) } : {}),
  };
}

function hint(shown: number): string {
  return `Showing the newest ${shown} matching lines; older ones were left out. Narrow with since, minLevel, tag, text or regex to see others.`;
}
