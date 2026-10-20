/**
 * Keeps get_logs output small enough for Claude's context (design: ≤ 200 entries and
 * ≤ 20 kB) and says when it was cut. Runs after masking, on masked text.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LogEntry } from '@project-deck/core';
import { cutText } from './mask/masker.js';

/**
 * Characters that don't show or that break lines unseen: every default-ignorable code
 * point (bidi controls and isolates, zero-width characters, the byte order mark, soft
 * hyphen, variation selectors, tag characters), the line and paragraph separators, NEL
 * and the interlinear annotation characters. App text could use them to reorder or hide
 * parts of an answer in the user's transcript (MCP-6, review R3).
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u0085\u2028\u2029\uFFF9-\uFFFB]/gu;

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
      [field]: n >= text.length ? text : cutText(text, n),
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

function hint(shown: number): string {
  return `Showing the newest ${shown} matching lines; older ones were left out. Narrow with since, minLevel, tag, text or regex to see others.`;
}

/**
 * A small answer (deck_status, db_list, db_snapshot) within the same 20 kB; `truncated`
 * says whether it was cut. `problem` is the tool's own words for the last resort.
 */
export function fitStatus(
  value: Record<string, unknown>,
  problem = 'FlutterDeck status was too large to show.',
): Record<string, unknown> {
  const whole = { ...value, truncated: false };
  if (fitsOutput(whole)) return whole;
  return fitKeepingFrame(value, problem);
}

/**
 * Fields every answer keeps whole, however much else is cut: what Claude must read
 * about the rest (the untrusted note, masking, warnings, the hint) (MCP-2).
 */
export const FRAME_KEYS: readonly string[] = ['note', 'masking', 'warnings', 'hint'];

const fitsOutput = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) <= MAX_OUTPUT_BYTES;

/**
 * The last resort for an answer over 20 kB: cuts the text of everything but the frame
 * shorter and shorter, then long lists, and finally gives the frame with `problem`.
 */
export function fitKeepingFrame(
  value: Record<string, unknown>,
  problem: string,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FRAME_KEYS.includes(key)) frame[key] = item;
    else body[key] = item;
  }
  for (const max of [2048, 1024, 512, 256, 128, 64, 32]) {
    const cut = { ...frame, ...(shorten(body, max) as object), truncated: true };
    if (fitsOutput(cut)) return cut;
  }
  for (const items of [100, 20, 5, 1, 0]) {
    const limited = shorten(limitLists(body, items), 32) as Record<string, unknown>;
    const cut = {
      ...frame,
      ...limited,
      ...recount(body, limited),
      truncated: true,
      listsCut: true,
      listsCutNote: LISTS_CUT_NOTE,
    };
    if (fitsOutput(cut)) return cut;
  }
  return { ...frame, truncated: true, problem };
}

const LISTS_CUT_NOTE =
  'Lists were cut to fit 20 kB. rowCount, columnsLeftOut and tablesLeftOut describe what is shown; counts inside items (such as a diff table’s counts) are the full totals.';

/**
 * The top-level counters of a cut answer, made true to the lists it still shows (R7):
 * rowCount is the rows shown, and columns or tables cut away join the left-out counts.
 */
function recount(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const length = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const count = (v: unknown) => (typeof v === 'number' ? v : 0);
  const out: Record<string, unknown> = {};
  if ('rowCount' in before) out.rowCount = length(after.rows);
  if (Array.isArray(before.columns) && 'columnsLeftOut' in before) {
    out.columnsLeftOut =
      count(before.columnsLeftOut) + length(before.columns) - length(after.columns);
  } else if (Array.isArray(before.columns) && length(after.columns) < length(before.columns)) {
    out.columnsLeftOut = length(before.columns) - length(after.columns);
  }
  if (Array.isArray(before.tables) && length(after.tables) < length(before.tables)) {
    out.tablesLeftOut = count(before.tablesLeftOut) + length(before.tables) - length(after.tables);
  }
  return out;
}

/** Every list cut to its first `max` items. */
function limitLists(value: unknown, max: number): unknown {
  if (Array.isArray(value)) return value.slice(0, max).map((v) => limitLists(v, max));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, limitLists(v, max)]));
  }
  return value;
}

export function shorten(value: unknown, max: number): unknown {
  // The masker's cut: never inside a surrogate pair or a mask marker (MCP-3).
  if (typeof value === 'string') return cutText(value, max);
  if (Array.isArray(value)) return value.map((v) => shorten(v, max));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, max)]));
  }
  return value;
}
