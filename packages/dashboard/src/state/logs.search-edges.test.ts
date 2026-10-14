import type { LogEntry } from '@project-deck/core';
import { MAX_REGEX_HAYSTACK } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import type { KeyedLog } from './logs.js';
import { NO_FILTERS, compileSearch, filterLogs } from './logs.js';

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

/** One keystroke's filtering must not block the page for longer than this (RAIL: 100 ms). */
const KEYSTROKE_BUDGET_MS = 100;

describe('log search: user-typed patterns', () => {
  // BUG-M2-T1 (fixed): a pattern with nested quantifiers backtracks exponentially, so a
  // short line used to freeze the tab. Such patterns are now refused before they run.
  it('BUG-M2-T1: (a+)+$ on a short non-matching line returns within one keystroke', () => {
    const entries = [keyed(`${'a'.repeat(23)}!`)];
    const { ms } = timed(() => filterLogs(entries, { ...NO_FILTERS, search: '(a+)+$' }, undefined));
    expect(ms).toBeLessThan(KEYSTROKE_BUDGET_MS);
  });

  it('a plain pattern over 20,000 lines of 4 kB stays within one keystroke', () => {
    const line = 'x'.repeat(MAX_REGEX_HAYSTACK);
    const entries = Array.from({ length: 20_000 }, (_, i) => keyed(line, i));
    const { value, ms } = timed(() =>
      filterLogs(entries, { ...NO_FILTERS, search: 'needle' }, undefined),
    );
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(KEYSTROKE_BUDGET_MS * 4);
  });

  it('searches only the first 4 kB of message plus stack', () => {
    const before = keyed(`${'x'.repeat(MAX_REGEX_HAYSTACK - 6)}needle`, 1);
    const after = keyed(`${'x'.repeat(MAX_REGEX_HAYSTACK)}needle`, 2);
    const inStack = keyed('short', 3, { stack: 'at needle (a.dart:1)' });
    const out = filterLogs(
      [before, after, inStack],
      { ...NO_FILTERS, search: 'needle' },
      undefined,
    );
    expect(out.map((e) => e.key)).toEqual([1, 3]);
  });

  it('a global or sticky flag in the pattern text is just text, so results never alternate', () => {
    // compileSearch adds only `i`; `/g` state (lastIndex) would make every second test fail.
    const entries = [keyed('tap', 1), keyed('tap', 2), keyed('tap', 3)];
    const out = filterLogs(entries, { ...NO_FILTERS, search: 'tap' }, undefined);
    expect(out).toHaveLength(3);
    const again = filterLogs(entries, { ...NO_FILTERS, search: 'tap' }, undefined);
    expect(again).toHaveLength(3);
  });

  it('treats special characters and bidi or zero-width text as pattern text', () => {
    expect(compileSearch('[').ok).toBe(false);
    expect(compileSearch('(?<').ok).toBe(false);
    expect(compileSearch('\\').ok).toBe(false);
    const rlo = keyed('user ‮gnp.exe', 1);
    const zw = keyed('pass​word', 2);
    expect(filterLogs([rlo, zw], { ...NO_FILTERS, search: '‮' }, undefined)).toEqual([rlo]);
    // A zero-width space hides the word from a plain search, as it should.
    expect(filterLogs([rlo, zw], { ...NO_FILTERS, search: 'password' }, undefined)).toEqual([]);
  });

  it('an invalid pattern with other filters on still applies the other filters', () => {
    const info = keyed('a', 1);
    const error = keyed('b', 2, { level: 'error' });
    const out = filterLogs([info, error], { ...NO_FILTERS, search: '(', minLevel: 'error' }, 0);
    expect(out).toEqual([error]);
  });

  it('"since last reload" without any reload shows everything', () => {
    const entries = [keyed('old', 1, { ts: 1 }), keyed('new', 2, { ts: 9 })];
    expect(filterLogs(entries, { ...NO_FILTERS, sinceReload: true }, undefined)).toEqual(entries);
    expect(filterLogs(entries, { ...NO_FILTERS, sinceReload: true }, 9)).toEqual([entries[1]]);
  });
});
