import type { LogEntry, LogLevel } from '@project-deck/core';
import { MAX_LOG_REGEX_LENGTH, MAX_REGEX_HAYSTACK, isAtLeast } from '@project-deck/core';

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

export type CompiledSearch = { ok: true; regex: RegExp | undefined } | { ok: false };

export function compileSearch(search: string): CompiledSearch {
  if (search === '') return { ok: true, regex: undefined };
  try {
    return { ok: true, regex: new RegExp(search, 'i') };
  } catch {
    return { ok: false };
  }
}

export function filtersActive(f: LogFilters): boolean {
  return (
    f.search !== '' || f.minLevel !== 'all' || f.source !== 'all' || f.tag !== '' || f.sinceReload
  );
}

/** `reloadAt` is when the last reload started; without one "since reload" shows everything. */
export function filterLogs(
  entries: KeyedLog[],
  f: LogFilters,
  reloadAt: number | undefined,
): KeyedLog[] {
  if (!filtersActive(f)) return entries;
  const search = compileSearch(f.search);
  // An invalid pattern leaves the list as it was (UI spec, "Log filters": error).
  const regex = search.ok ? search.regex : undefined;
  return entries.filter((e) => {
    if (f.minLevel !== 'all' && !isAtLeast(e.level, f.minLevel)) return false;
    if (f.source !== 'all' && e.source !== f.source) return false;
    if (f.tag !== '' && e.tag !== f.tag) return false;
    if (f.sinceReload && reloadAt !== undefined && e.ts < reloadAt) return false;
    if (regex !== undefined) {
      // Only the start of long entries, to bound catastrophic backtracking.
      const text = e.stack === undefined ? e.message : `${e.message}\n${e.stack}`;
      if (!regex.test(text.slice(0, MAX_REGEX_HAYSTACK))) return false;
    }
    return true;
  });
}
