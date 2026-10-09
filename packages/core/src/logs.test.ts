import { describe, expect, it, vi } from 'vitest';
import type { LogEntry } from './logs.js';
import { LogQuerySchema, RingBufferLogSource, isAtLeast } from './logs.js';

const entry = (ts: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts,
  level: 'info',
  source: 'app',
  message: `message ${ts}`,
  ...overrides,
});

describe('isAtLeast', () => {
  it('orders levels by severity', () => {
    expect(isAtLeast('error', 'warn')).toBe(true);
    expect(isAtLeast('warn', 'warn')).toBe(true);
    expect(isAtLeast('debug', 'info')).toBe(false);
  });
});

describe('RingBufferLogSource', () => {
  it('keeps only the newest entries once full', async () => {
    const logs = new RingBufferLogSource(3);
    for (let i = 1; i <= 5; i++) logs.push(entry(i));
    const all = await logs.query({});
    expect(all.map((e) => e.ts)).toEqual([3, 4, 5]);
  });

  it('returns the most recent matches, oldest first, up to the limit', async () => {
    const logs = new RingBufferLogSource(10);
    for (let i = 1; i <= 6; i++) logs.push(entry(i));
    const result = await logs.query({ limit: 2 });
    expect(result.map((e) => e.ts)).toEqual([5, 6]);
  });

  it('filters by since, level, tag, text and regex', async () => {
    const logs = new RingBufferLogSource(10);
    logs.push(entry(1, { level: 'error', message: 'Boom', tag: 'flutter' }));
    logs.push(entry(2, { level: 'debug', message: 'boom quietly' }));
    logs.push(entry(3, { level: 'warn', message: 'other', stack: 'at boom.dart:12' }));
    logs.push(entry(4, { level: 'error', message: 'fine', tag: 'native' }));

    const ts = async (q: Parameters<RingBufferLogSource['query']>[0]) =>
      (await logs.query(q)).map((e) => e.ts);

    expect(await ts({ since: 3 })).toEqual([3, 4]);
    expect(await ts({ minLevel: 'warn' })).toEqual([1, 3, 4]);
    expect(await ts({ tag: 'native' })).toEqual([4]);
    expect(await ts({ text: 'BOOM' })).toEqual([1, 2, 3]);
    expect(await ts({ regex: String.raw`boom\.dart:\d+` })).toEqual([3]);
    expect(await ts({ text: 'boom', minLevel: 'warn' })).toEqual([1, 3]);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const logs = new RingBufferLogSource(10);
    const cb = vi.fn();
    const off = logs.subscribe(cb);
    logs.push(entry(1));
    off();
    logs.push(entry(2));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clears', async () => {
    const logs = new RingBufferLogSource(2);
    logs.push(entry(1));
    logs.push(entry(2));
    logs.push(entry(3));
    logs.clear();
    expect(await logs.query({})).toEqual([]);
    logs.push(entry(4));
    expect((await logs.query({})).map((e) => e.ts)).toEqual([4]);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBufferLogSource(0)).toThrow(RangeError);
  });
});

describe('LogQuerySchema', () => {
  it('rejects an invalid regex and an oversized limit', () => {
    expect(LogQuerySchema.safeParse({ regex: '(' }).success).toBe(false);
    expect(LogQuerySchema.safeParse({ limit: 1_000_000 }).success).toBe(false);
    expect(LogQuerySchema.safeParse({ regex: 'a+', limit: 10 }).success).toBe(true);
  });
});
