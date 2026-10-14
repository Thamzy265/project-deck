import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KeyedLog } from '../state/logs.js';
import { MemoryStorage, fakeDaemon, renderDashboard } from '../testing/harness.js';
import type { RegexRunner, SearchResult } from './runner.js';
import { useRegexSearch } from './useRegexSearch.js';

const line = (key: number, message: string): KeyedLog => ({
  key,
  ts: key,
  level: 'info',
  source: 'app',
  message,
});

/** A runner whose answers the test releases by hand. */
function manualRunner() {
  const calls: { pattern: string; keys: number[]; answer: (r: SearchResult) => void }[] = [];
  const runner: RegexRunner = {
    run: vi.fn(
      (pattern: string, items: [number, string][]) =>
        new Promise<SearchResult>((answer) => {
          calls.push({ pattern, keys: items.map(([k]) => k), answer });
        }),
    ),
    dispose: () => undefined,
  };
  return { runner, calls };
}

describe('useRegexSearch', () => {
  it('shows results only for the pattern that produced them (review C3)', async () => {
    const { runner, calls } = manualRunner();
    const base = [line(1, 'tap'), line(2, 'boom')];
    const { result, rerender } = renderHook(({ p }) => useRegexSearch(runner, base, p), {
      initialProps: { p: 'tap' },
    });
    // Never the unfiltered list while the first answer is on its way.
    expect(result.current).toEqual({ shown: [], status: 'searching' });
    await act(async () => {
      calls[0]?.answer({ ok: true, keys: [1] });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ shown: [base[0]], status: 'done' });
    rerender({ p: 'boom' });
    expect(result.current).toEqual({ shown: [], status: 'searching' });
    await act(async () => {
      calls[1]?.answer({ ok: false, reason: 'timeout' });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ shown: [], status: 'too-slow' });
    rerender({ p: '' });
    expect(result.current).toEqual({ shown: base, status: 'idle' });
  });

  it('keeps the last good result for the same pattern when a later pass is stopped', async () => {
    const { runner, calls } = manualRunner();
    const { result, rerender } = renderHook(({ base }) => useRegexSearch(runner, base, 'tap'), {
      initialProps: { base: [line(1, 'tap')] },
    });
    await act(async () => {
      calls[0]?.answer({ ok: true, keys: [1] });
      await Promise.resolve();
    });
    rerender({ base: [line(1, 'tap'), line(2, 'tap')] });
    await act(async () => {
      calls[1]?.answer({ ok: false, reason: 'timeout' });
      await Promise.resolve();
    });
    expect(result.current.shown.map((e) => e.key)).toEqual([1]);
    expect(result.current.status).toBe('too-slow');
  });

  it('says the search is broken rather than showing everything (review C3)', async () => {
    const { runner, calls } = manualRunner();
    const base = [line(1, 'tap')];
    const { result } = renderHook(() => useRegexSearch(runner, base, 'tap'));
    await act(async () => {
      calls[0]?.answer({ ok: false, reason: 'error' });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ shown: [], status: 'error' });
  });

  it('queues one more pass for new lines instead of cancelling the one in flight', async () => {
    const { runner, calls } = manualRunner();
    const { rerender } = renderHook(({ base }) => useRegexSearch(runner, base, 'x'), {
      initialProps: { base: [line(1, 'x')] },
    });
    rerender({ base: [line(1, 'x'), line(2, 'x')] });
    rerender({ base: [line(1, 'x'), line(2, 'x'), line(3, 'x')] });
    expect(calls).toHaveLength(1);
    await act(async () => {
      calls[0]?.answer({ ok: true, keys: [1] });
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.keys).toEqual([1, 2, 3]);
  });
});

describe('search box with a stopped search (BUG-M2-T1)', () => {
  it('says the search took too long and shows no unfiltered lines', async () => {
    const slow: RegexRunner = {
      run: () => Promise.resolve({ ok: false, reason: 'timeout' }),
      dispose: () => undefined,
    };
    const t = renderDashboard(
      fakeDaemon({ logs: [{ ts: 1, level: 'info', source: 'app', message: 'aaaa!' }] }),
      new MemoryStorage(),
      slow,
    );
    await t.connect();
    await screen.findByText('aaaa!');
    const search = screen.getByRole('searchbox', { name: 'Search logs' });
    await userEvent.type(search, '(a|a)*b');
    expect(await screen.findByText('That search took too long and was stopped.')).toBeVisible();
    expect(search).toHaveAccessibleDescription('That search took too long and was stopped.');
    expect(screen.queryByText('aaaa!')).not.toBeInTheDocument();
  });

  it('says the search is broken when the worker fails (review C3)', async () => {
    const broken: RegexRunner = {
      run: () => Promise.resolve({ ok: false, reason: 'error' }),
      dispose: () => undefined,
    };
    const t = renderDashboard(
      fakeDaemon({ logs: [{ ts: 1, level: 'info', source: 'app', message: 'secret line' }] }),
      new MemoryStorage(),
      broken,
    );
    await t.connect();
    await screen.findByText('secret line');
    const search = screen.getByRole('searchbox', { name: 'Search logs' });
    await userEvent.type(search, 'nomatch');
    expect(await screen.findByText("Search isn't working. Reload the page.")).toBeVisible();
    expect(search).toHaveAccessibleDescription("Search isn't working. Reload the page.");
    expect(screen.queryByText('secret line')).not.toBeInTheDocument();
  });
});
