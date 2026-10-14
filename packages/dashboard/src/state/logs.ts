import type { LogEntry, LogLevel } from '@project-deck/core';
import {
  MAX_LOG_REGEX_LENGTH,
  MAX_REGEX_HAYSTACK,
  hasNestedQuantifier,
  isAtLeast,
} from '@project-deck/core';

/** A log entry with a key that is stable for this page, for React and the virtual list. */
export type KeyedLog = LogEntry & { key: number };

export interface LogList {
  entries: KeyedLog[];
  nextKey: number;
}

export interface LogFilters {
  /** A case-insensitive regular expression; empty means no search. */
  search: string;
  minLevel: LogLevel | 'all';
  source: LogEntry['source'] | 'all';
  /** Empty means every tag. */
  tag: string;
  sinceReload: boolean;
}

export const NO_FILTERS: LogFilters = {
  search: '',
  minLevel: 'all',
  source: 'all',
  tag: '',
  sinceReload: false,
};

export const MAX_SEARCH_LENGTH = MAX_LOG_REGEX_LENGTH;

export function appendLogs(list: LogList, incoming: LogEntry[], cap: number): LogList {
  let key = list.nextKey;
  const added = incoming.map((entry) => ({ ...entry, key: key++ }));
  const entries = [...list.entries, ...added];
  return { entries: entries.length > cap ? entries.slice(-cap) : entries, nextKey: key };
}

function identity(e: LogEntry): string {
  return JSON.stringify([e.ts, e.level, e.source, e.tag ?? null, e.message, e.stack ?? null]);
}

/**
 * Fills the gap after a reconnect. Log entries have no id, so within the time range of
 * the fetched lines it adds each line as many times as the fetch has it beyond what the
 * list already holds; identical lines that really repeated are kept.
 */
export function mergeBackfill(list: LogList, fetched: LogEntry[], cap: number): LogList {
  if (fetched.length > 0 && hasSeq(fetched) && hasSeq(list.entries)) {
    return mergeBySeq(list, fetched, cap);
  }
  const from = fetched[0]?.ts;
  if (from === undefined) return list;
  const have = new Map<string, number>();
  for (const e of list.entries) {
    if (e.ts < from) continue;
    const id = identity(e);
    have.set(id, (have.get(id) ?? 0) + 1);
  }
  const missing: LogEntry[] = [];
  for (const e of fetched) {
    const id = identity(e);
    const count = have.get(id) ?? 0;
    if (count > 0) have.set(id, count - 1);
    else missing.push(e);
  }
  if (missing.length === 0) return list;
  const appended = appendLogs({ entries: list.entries, nextKey: list.nextKey }, missing, Infinity);
  // Stable sort: equal times keep arrival order.
  const sorted = [...appended.entries].sort((a, b) => a.ts - b.ts);
  return { entries: sorted.length > cap ? sorted.slice(-cap) : sorted, nextKey: appended.nextKey };
}

function hasSeq(entries: LogEntry[]): entries is (LogEntry & { seq: number })[] {
  return entries.every((e) => e.seq !== undefined);
}

/** With the daemon's numbers, matching and ordering are exact. */
function mergeBySeq(list: LogList, fetched: (LogEntry & { seq: number })[], cap: number): LogList {
  const have = new Set(list.entries.map((e) => e.seq));
  const missing = fetched.filter((e) => !have.has(e.seq));
  if (missing.length === 0) return list;
  const appended = appendLogs(list, missing, Infinity);
  const sorted = [...appended.entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { entries: sorted.length > cap ? sorted.slice(-cap) : sorted, nextKey: appended.nextKey };
}

/**
 * Where "since the last reload" starts: the daemon's next line number when the page saw
 * the reload start, and the page's next arrival key for lines without one. Never a clock.
 */
export interface LogMark {
  seq: number | undefined;
  key: number;
}

export function isAfter(e: KeyedLog, mark: LogMark): boolean {
  if (e.seq !== undefined && mark.seq !== undefined) return e.seq >= mark.seq;
  return e.key >= mark.key;
}

export type CompiledSearch =
  | { ok: true; regex: RegExp | undefined }
  /** `unsafe`: nested quantifiers, which can backtrack long enough to freeze the page. */
  | { ok: false; reason: 'invalid' | 'unsafe' };

export function compileSearch(search: string): CompiledSearch {
  if (search === '') return { ok: true, regex: undefined };
  let regex: RegExp;
  try {
    regex = new RegExp(search, 'i');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (hasNestedQuantifier(search)) return { ok: false, reason: 'unsafe' };
  return { ok: true, regex };
}

/** The text a search runs on: message and stack, only the first 4 kB. */
export function searchText(e: LogEntry): string {
  const text = e.stack === undefined ? e.message : `${e.message}\n${e.stack}`;
  return text.slice(0, MAX_REGEX_HAYSTACK);
}

export function filtersActive(f: LogFilters): boolean {
  return (
    f.search !== '' || f.minLevel !== 'all' || f.source !== 'all' || f.tag !== '' || f.sinceReload
  );
}

/**
 * Level, source, tag and "since last reload". The search pattern is not applied here: it
 * runs in the search worker (see search/useRegexSearch.ts).
 */
export function filterLogs(
  entries: KeyedLog[],
  f: LogFilters,
  reload: LogMark | undefined,
): KeyedLog[] {
  const since = f.sinceReload ? reload : undefined;
  if (f.minLevel === 'all' && f.source === 'all' && f.tag === '' && since === undefined) {
    return entries;
  }
  return entries.filter((e) => {
    if (f.minLevel !== 'all' && !isAtLeast(e.level, f.minLevel)) return false;
    if (f.source !== 'all' && e.source !== f.source) return false;
    if (f.tag !== '' && e.tag !== f.tag) return false;
    if (since !== undefined && !isAfter(e, since)) return false;
    return true;
  });
}
