/**
 * Keeps get_logs output small enough for Claude's context (design: ≤ 200 entries and
 * ≤ 20 kB) and says when it was cut. Runs after masking, on masked text.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LogEntry } from '@project-deck/core';

/**
 * Invisible format characters: bidi controls and isolates, zero-width characters, the
 * byte order mark, soft hyphen, fillers and Unicode tag characters. App text could use
 * them to reorder or hide parts of an answer in the user's transcript (MCP-6).
 */
const INVISIBLE =
  /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

/** Writes each invisible character as `\uXXXX` (per UTF-16 unit), valid inside JSON strings. */
export function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE, (c) => {
    let out = '';
    for (let i = 0; i < c.length; i++) {
      out += `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
    return out;
  });
}

/** Every tool's answer as text: JSON with invisible characters escaped. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: escapeInvisible(JSON.stringify(value)) }] };
}

/** A failed call's plain text, with invisible characters escaped. */
export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: escapeInvisible(text) }] };
}

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
    JSON.stringify({ ...frame, entries: [], truncated: true, hint: hint(MAX_OUTPUT_ENTRIES) }),
  );
  let total = overhead + sizes.reduce((a, b) => a + b, 0);
  let drop = 0;
  while (drop < kept.length && total > MAX_OUTPUT_BYTES) total -= sizes[drop++] ?? 0;
  kept = kept.slice(drop);
  const newest = all.at(-1);
  const shrunk = kept.length === 0 && newest !== undefined;
  if (shrunk) {
    // Never an empty answer while lines matched: the newest one, cut to fit.
    kept = [shrinkToFit(newest, MAX_OUTPUT_BYTES - overhead)];
  }
  const truncated = moreMatched || shrunk || kept.length < all.length;
  return {
    ...frame,
    entries: kept,
    truncated,
    ...(truncated ? { hint: hint(kept.length) } : {}),
  };
}

/** Cuts the stack, then the message, then the tag until the entry fits in `budget` bytes. */
function shrinkToFit(entry: OutputEntry, budget: number): OutputEntry {
  const size = (e: OutputEntry) => Buffer.byteLength(JSON.stringify(e));
  let out = { ...entry };
  for (const field of ['stack', 'message', 'tag'] as const) {
    if (size(out) <= budget) break;
    const text = out[field];
    if (text === undefined) continue;
    const withText = (n: number): OutputEntry => ({
      ...out,
      [field]: n >= text.length ? text : `${text.slice(0, n)}${CUT}`,
    });
    // The longest prefix that fits, found by halving.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(withText(mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    out = withText(lo);
  }
  return out;
}

const CUT = ' …[cut]';

function hint(shown: number): string {
  return `Showing the newest ${shown} matching lines; older ones were left out. Narrow with since, minLevel, tag, text or regex to see others.`;
}

/**
 * deck_status within the same 20 kB: if it doesn't fit, every long string is cut
 * shorter and shorter until it does, and `truncated` says so.
 */
export function fitStatus(value: Record<string, unknown>): Record<string, unknown> {
  const fits = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) <= MAX_OUTPUT_BYTES;
  const whole = { ...value, truncated: false };
  if (fits(whole)) return whole;
  for (const max of [2048, 1024, 512, 256, 128, 64, 32]) {
    const cut = { ...(shorten(value, max) as Record<string, unknown>), truncated: true };
    if (fits(cut)) return cut;
  }
  return { truncated: true, problem: 'FlutterDeck status was too large to show.' };
}

export function shorten(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => shorten(v, max));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, max)]));
  }
  return value;
}
