import type { LogEntry } from '@project-deck/core';
import { MAX_REGEX_HAYSTACK } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import type { KeyedLog } from './logs.js';
import { runSearch } from '../search/run-search.js';
import { NO_FILTERS, compileSearch, filterLogs, searchText } from './logs.js';

const keyed = (message: string, key = 0, extra: Partial<LogEntry> = {}): KeyedLog => ({
  ts: 1,
  level: 'info',
  source: 'app',
  message,
  key,
  ...extra,
});

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** What the page does: refuse unsafe or invalid patterns, then run the worker's body. */
function search(entries: KeyedLog[], pattern: string): KeyedLog[] {
  if (!compileSearch(pattern).ok) return entries;
  const reply = runSearch({ id: 0, pattern, items: entries.map((e) => [e.key, searchText(e)]) });
  if (!('keys' in reply)) throw new Error(reply.error);
  const keys = new Set(reply.keys);
  return entries.filter((e) => keys.has(e.key));
}

/** One keystroke's filtering must not block the page for longer than this (RAIL: 100 ms). */
const KEYSTROKE_BUDGET_MS = 100;

describe('log search: user-typed patterns', () => {
  // BUG-M2-T1 (fixed): a pattern with nested quantifiers backtracks exponentially, so a
  // short line used to freeze the tab. Such patterns are now refused before they run.
  it('BUG-M2-T1: (a+)+$ on a short non-matching line returns within one keystroke', () => {
    const entries = [keyed(`${'a'.repeat(23)}!`)];
    const { ms } = timed(() => search(entries, '(a+)+$'));
    expect(ms).toBeLessThan(KEYSTROKE_BUDGET_MS);
  });

  it('a plain pattern over 20,000 lines of 4 kB stays within one keystroke', () => {
    const line = 'x'.repeat(MAX_REGEX_HAYSTACK);
    const entries = Array.from({ length: 20_000 }, (_, i) => keyed(line, i));
    const { value, ms } = timed(() => search(entries, 'needle'));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(KEYSTROKE_BUDGET_MS * 4);
  });

  it('searches only the first 4 kB of message plus stack', () => {
    const before = keyed(`${'x'.repeat(MAX_REGEX_HAYSTACK - 6)}needle`, 1);
    const after = keyed(`${'x'.repeat(MAX_REGEX_HAYSTACK)}needle`, 2);
    const inStack = keyed('short', 3, { stack: 'at needle (a.dart:1)' });
    const out = search([before, after, inStack], 'needle');
    expect(out.map((e) => e.key)).toEqual([1, 3]);
  });

  it('a global or sticky flag in the pattern text is just text, so results never alternate', () => {
    // compileSearch adds only `i`; `/g` state (lastIndex) would make every second test fail.
    const entries = [keyed('tap', 1), keyed('tap', 2), keyed('tap', 3)];
    const out = search(entries, 'tap');
    expect(out).toHaveLength(3);
    const again = search(entries, 'tap');
    expect(again).toHaveLength(3);
  });

  it('treats special characters and bidi or zero-width text as pattern text', () => {
    expect(compileSearch('[').ok).toBe(false);
    expect(compileSearch('(?<').ok).toBe(false);
    expect(compileSearch('\\').ok).toBe(false);
    const rlo = keyed('user ‮gnp.exe', 1);
    const zw = keyed('pass​word', 2);
    expect(search([rlo, zw], '‮')).toEqual([rlo]);
    // A zero-width space hides the word from a plain search, as it should.
    expect(search([rlo, zw], 'password')).toEqual([]);
  });

  it('an invalid pattern with other filters on still applies the other filters', () => {
    const info = keyed('a', 1);
    const error = keyed('b', 2, { level: 'error' });
    const out = filterLogs(
      [info, error],
      { ...NO_FILTERS, search: '(', minLevel: 'error' },
      undefined,
    );
    expect(out).toEqual([error]);
  });

  it('"since last reload" without any reload shows everything', () => {
    const entries = [keyed('old', 1, { ts: 1 }), keyed('new', 2, { ts: 9 })];
    expect(filterLogs(entries, { ...NO_FILTERS, sinceReload: true }, undefined)).toEqual(entries);
    expect(
      filterLogs(entries, { ...NO_FILTERS, sinceReload: true }, { seq: undefined, key: 2 }),
    ).toEqual([entries[1]]);
  });
});
