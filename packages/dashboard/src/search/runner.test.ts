import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSearch } from './run-search.js';
import type { SearchReply, SearchRequest, WorkerLike } from './runner.js';
import { SEARCH_BUDGET_MS, createInlineRunner, createWorkerRunner } from './runner.js';

/** A worker that answers with runSearch after `delayMs`, or never when `hang` is set. */
class FakeWorker implements WorkerLike {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: SearchReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  hang = false;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(request: SearchRequest): void {
    if (this.hang) return;
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: runSearch(request) });
    }, 5);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const items: [number, string][] = [
  [1, 'Tap 1'],
  [2, 'Boom'],
  [3, 'tap 2'],
];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.made = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runSearch (the worker body)', () => {
  it('returns the keys whose text matches, case-insensitively', () => {
    expect(runSearch({ id: 7, pattern: 'tap \\d', items })).toEqual({ id: 7, keys: [1, 3] });
  });

  it('reports a pattern that does not compile', () => {
    const reply = runSearch({ id: 1, pattern: '(', items });
    expect(reply.id).toBe(1);
    expect('error' in reply).toBe(true);
  });
});

describe('createWorkerRunner', () => {
  it('answers from the worker within the budget', async () => {
    const runner = createWorkerRunner(() => new FakeWorker());
    const result = runner.run('boom', items);
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toEqual({ ok: true, keys: [2] });
  });

  it('stops a search past the 200 ms budget and starts a fresh worker', async () => {
    const runner = createWorkerRunner(() => new FakeWorker());
    const first = FakeWorker.made[0];
    if (first === undefined) throw new Error('no worker');
    first.hang = true;
    const result = runner.run('x', items);
    await vi.advanceTimersByTimeAsync(SEARCH_BUDGET_MS);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
    expect(first.terminated).toBe(true);
    expect(FakeWorker.made).toHaveLength(2);
    const next = runner.run('tap', items);
    await vi.advanceTimersByTimeAsync(5);
    expect(await next).toEqual({ ok: true, keys: [1, 3] });
  });

  it('cancels the search in flight when a new one starts', async () => {
    const runner = createWorkerRunner(() => new FakeWorker());
    const old = runner.run('tap', items);
    const latest = runner.run('boom', items);
    expect(await old).toEqual({ ok: false, reason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(5);
    expect(await latest).toEqual({ ok: true, keys: [2] });
  });

  it('treats a worker error as a failed search and replaces the worker', async () => {
    const runner = createWorkerRunner(() => new FakeWorker());
    const first = FakeWorker.made[0];
    if (first === undefined) throw new Error('no worker');
    first.hang = true;
    const result = runner.run('x', items);
    first.onerror?.();
    expect(await result).toEqual({ ok: false, reason: 'error' });
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('terminates the worker on dispose', () => {
    const runner = createWorkerRunner(() => new FakeWorker());
    runner.dispose();
    expect(FakeWorker.made[0]?.terminated).toBe(true);
  });
});

describe('createInlineRunner (tests and fallback)', () => {
  it('matches like the worker', async () => {
    expect(await createInlineRunner().run('tap', items)).toEqual({ ok: true, keys: [1, 3] });
  });
});
