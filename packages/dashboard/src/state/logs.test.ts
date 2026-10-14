import type { LogEntry } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import type { LogFilters } from './logs.js';
import {
  NO_FILTERS,
  appendLogs,
  compileSearch,
  filterLogs,
  filtersActive,
  mergeBackfill,
} from './logs.js';

const e = (ts: number, message: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  ts,
  level: 'info',
  source: 'app',
  message,
  ...extra,
});

describe('appendLogs', () => {
  it('gives each entry a key and keeps only the newest `cap`', () => {
    const first = appendLogs({ entries: [], nextKey: 0 }, [e(1, 'a'), e(2, 'b')], 3);
    const next = appendLogs(first, [e(3, 'c'), e(4, 'd')], 3);
    expect(next.entries.map((x) => [x.key, x.message])).toEqual([
      [1, 'b'],
      [2, 'c'],
      [3, 'd'],
    ]);
    expect(next.nextKey).toBe(4);
  });
});

describe('mergeBackfill', () => {
  it('adds only the lines missed while disconnected, in time order', () => {
    const live = appendLogs({ entries: [], nextKey: 0 }, [e(1, 'a'), e(5, 'e')], 100);
    const fetched = [e(1, 'a'), e(2, 'b'), e(3, 'c'), e(5, 'e')];
    const merged = mergeBackfill(live, fetched, 100);
    expect(merged.entries.map((x) => x.message)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('keeps identical lines that really happened twice', () => {
    const live = appendLogs({ entries: [], nextKey: 0 }, [e(1, 'tick')], 100);
    const merged = mergeBackfill(live, [e(1, 'tick'), e(1, 'tick')], 100);
    expect(merged.entries.map((x) => x.message)).toEqual(['tick', 'tick']);
  });

  it('keeps lines older than the fetched range', () => {
    const live = appendLogs({ entries: [], nextKey: 0 }, [e(0, 'old'), e(5, 'e')], 100);
    const merged = mergeBackfill(live, [e(4, 'd'), e(5, 'e')], 100);
    expect(merged.entries.map((x) => x.message)).toEqual(['old', 'd', 'e']);
  });
});

describe('compileSearch', () => {
  it('treats the search as a case-insensitive pattern', () => {
    const r = compileSearch('tap \\d');
    expect(r.ok && r.regex?.test('TAP 3')).toBe(true);
    expect(compileSearch('')).toEqual({ ok: true, regex: undefined });
  });

  it('reports an invalid pattern', () => {
    expect(compileSearch('(unclosed')).toEqual({ ok: false });
  });
});

describe('filterLogs', () => {
  const list = appendLogs(
    { entries: [], nextKey: 0 },
    [
      e(1, 'Tap 1', { level: 'debug', tag: 'flutter' }),
      e(2, 'Boom', { level: 'error', source: 'native', tag: 'Choreographer' }),
      e(3, 'Tap 2', { level: 'info', tag: 'flutter', stack: 'at main.dart:12' }),
    ],
    100,
  ).entries;
  const only = (f: Partial<LogFilters>, reloadAt?: number) =>
    filterLogs(list, { ...NO_FILTERS, ...f }, reloadAt).map((x) => x.message);

  it('filters by minimum level, source and tag', () => {
    expect(only({ minLevel: 'info' })).toEqual(['Boom', 'Tap 2']);
    expect(only({ source: 'native' })).toEqual(['Boom']);
    expect(only({ tag: 'flutter' })).toEqual(['Tap 1', 'Tap 2']);
  });

  it('searches message and stack', () => {
    expect(only({ search: 'main\\.dart' })).toEqual(['Tap 2']);
    expect(only({ search: 'tap' })).toEqual(['Tap 1', 'Tap 2']);
  });

  it('leaves the list unchanged while the pattern is invalid', () => {
    expect(only({ search: '(' })).toEqual(['Tap 1', 'Boom', 'Tap 2']);
  });

  it('shows only lines since the last reload when asked', () => {
    expect(only({ sinceReload: true }, 2)).toEqual(['Boom', 'Tap 2']);
    expect(only({ sinceReload: true }, undefined)).toEqual(['Tap 1', 'Boom', 'Tap 2']);
  });

  it('knows when any filter is on', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, tag: 'x' })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, sinceReload: true })).toBe(true);
  });
});
