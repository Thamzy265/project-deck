import type { LogEntry } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import type { LogFilters, LogMark } from './logs.js';
import {
  NO_FILTERS,
  appendLogs,
  compileSearch,
  filterLogs,
  filtersActive,
  isAfter,
  mergeBackfill,
  searchText,
} from './logs.js';
import { runSearch } from '../search/run-search.js';

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

describe('mergeBackfill with daemon sequence numbers (review C2)', () => {
  it('matches lines by seq and orders by it, whatever their device times', () => {
    const live = appendLogs(
      { entries: [], nextKey: 0 },
      [e(500, 'tick', { seq: 1 }), e(100, 'late', { seq: 4 })],
      100,
    );
    const fetched = [
      e(500, 'tick', { seq: 1 }),
      e(500, 'tick', { seq: 2 }),
      e(900, 'b', { seq: 3 }),
      e(100, 'late', { seq: 4 }),
    ];
    const merged = mergeBackfill(live, fetched, 100);
    expect(merged.entries.map((x) => [x.message, x.seq])).toEqual([
      ['tick', 1],
      ['tick', 2],
      ['b', 3],
      ['late', 4],
    ]);
  });
});

describe('isAfter (since last reload, review C2)', () => {
  it('uses the daemon order, not the device clock', () => {
    const [before, after] = appendLogs(
      { entries: [], nextKey: 0 },
      [e(9_999, 'before', { seq: 7 }), e(1, 'after', { seq: 8 })],
      10,
    ).entries;
    if (before === undefined || after === undefined) throw new Error('no entries');
    const mark = { seq: 8, key: 0 };
    expect(isAfter(before, mark)).toBe(false);
    expect(isAfter(after, mark)).toBe(true);
  });

  it('falls back to arrival order for lines without a seq', () => {
    const list = appendLogs({ entries: [], nextKey: 0 }, [e(5, 'a'), e(1, 'b')], 10).entries;
    expect(list.map((x) => isAfter(x, { seq: undefined, key: 1 }))).toEqual([false, true]);
  });
});

describe('compileSearch', () => {
  it('treats the search as a case-insensitive pattern', () => {
    const r = compileSearch('tap \\d');
    expect(r.ok && r.regex?.test('TAP 3')).toBe(true);
    expect(compileSearch('')).toEqual({ ok: true, regex: undefined });
  });

  it('reports an invalid pattern', () => {
    expect(compileSearch('(unclosed')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses nested quantifiers, which could freeze the page (BUG-M2-T1)', () => {
    expect(compileSearch('(a+)+$')).toEqual({ ok: false, reason: 'unsafe' });
    expect(compileSearch('(x*){2,}')).toEqual({ ok: false, reason: 'unsafe' });
    expect(compileSearch('(tap)+ \\d+')).toMatchObject({ ok: true });
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
  const only = (f: Partial<LogFilters>, mark?: LogMark) =>
    filterLogs(list, { ...NO_FILTERS, ...f }, mark).map((x) => x.message);

  it('filters by minimum level, source and tag', () => {
    expect(only({ minLevel: 'info' })).toEqual(['Boom', 'Tap 2']);
    expect(only({ source: 'native' })).toEqual(['Boom']);
    expect(only({ tag: 'flutter' })).toEqual(['Tap 1', 'Tap 2']);
  });

  it('leaves the pattern to the search worker (review D3)', () => {
    expect(only({ search: 'main\\.dart' })).toEqual(['Tap 1', 'Boom', 'Tap 2']);
    expect(only({ search: '(' })).toEqual(['Tap 1', 'Boom', 'Tap 2']);
  });

  it('gives the worker message and stack as the search text', () => {
    const items = list.map((x): [number, string] => [x.key, searchText(x)]);
    expect(runSearch({ id: 0, pattern: 'main\\.dart', items })).toEqual({ id: 0, keys: [2] });
    expect(runSearch({ id: 0, pattern: 'tap', items })).toEqual({ id: 0, keys: [0, 2] });
  });

  it('shows only lines since the last reload when asked', () => {
    expect(only({ sinceReload: true }, { seq: undefined, key: 1 })).toEqual(['Boom', 'Tap 2']);
    expect(only({ sinceReload: true }, undefined)).toEqual(['Tap 1', 'Boom', 'Tap 2']);
  });

  it('knows when any filter is on', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, tag: 'x' })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, sinceReload: true })).toBe(true);
  });
});
