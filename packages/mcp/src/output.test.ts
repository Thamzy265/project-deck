import type { LogEntry } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_ENTRIES, fitLogs } from './output.js';

function entry(i: number, size = 10): LogEntry {
  return { ts: i, level: 'info', source: 'app', message: `${i} ${'x'.repeat(size)}`, seq: i };
}

const frame = { note: 'n', masking: 'm', warnings: [] };

describe('fitLogs', () => {
  it('keeps everything that fits, without seq', () => {
    const out = fitLogs(frame, [entry(1), entry(2)], false);
    expect(out.entries).toEqual([
      { ts: 1, level: 'info', source: 'app', message: '1 xxxxxxxxxx' },
      { ts: 2, level: 'info', source: 'app', message: '2 xxxxxxxxxx' },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.hint).toBeUndefined();
  });

  it('drops the oldest lines until the output is at most 20 kB', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(i, 1000));
    const out = fitLogs(frame, entries, false);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.entries.length).toBeGreaterThan(10);
    expect(out.entries.at(-1)?.ts).toBe(99);
    expect(out.truncated).toBe(true);
    expect(out.hint).toBe(
      `Showing the newest ${out.entries.length} matching lines; older ones were left out. Narrow with since, minLevel, tag, text or regex to see others.`,
    );
  });

  it('counts bytes, not characters', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      ...entry(i),
      message: '€'.repeat(400),
    }));
    const out = fitLogs(frame, entries, false);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
  });

  it('keeps at most 200 lines', () => {
    const entries = Array.from({ length: 250 }, (_, i) => entry(i, 1));
    const out = fitLogs(frame, entries, false);
    expect(out.entries).toHaveLength(MAX_OUTPUT_ENTRIES);
    expect(out.entries[0]?.ts).toBe(50);
    expect(out.truncated).toBe(true);
  });

  it('passes on that the daemon had more matches', () => {
    const out = fitLogs(frame, [entry(1)], true);
    expect(out.truncated).toBe(true);
    expect(out.hint).toContain('Narrow with since');
  });
});
