import type { LogEntry } from '@project-deck/core';
import { LogEntrySchema } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { THREADTIME_FIXTURE } from './testing/fixtures.js';
import { MAX_LINES_PER_ENTRY, ThreadtimeParser, timestampFor } from './threadtime.js';

const NOW = new Date(2026, 9, 13, 15, 0, 0);

function parse(text: string, now: Date = NOW): LogEntry[] {
  const out: LogEntry[] = [];
  const parser = new ThreadtimeParser(
    (e) => out.push(e),
    () => now,
  );
  parser.write(text);
  parser.flush();
  return out;
}

describe('ThreadtimeParser', () => {
  it('turns the fixture into valid native entries, grouping multi-line messages', () => {
    const entries = parse(THREADTIME_FIXTURE);
    for (const e of entries) expect(LogEntrySchema.parse(e)).toEqual(e);
    expect(entries.map((e) => [e.level, e.tag])).toEqual([
      ['verbose', 'FlutterLoader'],
      ['debug', 'FlutterJNI'],
      ['debug', 'FlutterJNI'],
      ['info', 'flutter'],
      ['info', 'flutter'],
      ['warn', 'ResourceType'],
      ['warn', 'libEGL'],
      ['error', 'OkHttp'],
      ['info', 'Choreographer'],
      ['error', 'AndroidRuntime'],
      ['fatal', 'libc'],
    ]);
    expect(entries.every((e) => e.source === 'native')).toBe(true);
  });

  it('keeps colons in the message and only strips the tag padding', () => {
    const [first] = parse('10-13 14:02:31.552  4242  4281 I flutter : listening on http://a:1/\n');
    expect(first).toMatchObject({ tag: 'flutter', message: 'listening on http://a:1/' });
  });

  it('accepts an empty message', () => {
    const entries = parse(
      '10-13 14:02:31.552  4242  4281 I flutter: \n10-13 14:02:31.553  4242  4281 I other:\n',
    );
    expect(entries.map((e) => [e.tag, e.message])).toEqual([
      ['flutter', ''],
      ['other', ''],
    ]);
  });

  it('maps the assert level to fatal', () => {
    const [entry] = parse('10-13 14:02:31.552  4242  4242 A libc    : abort\n');
    expect(entry?.level).toBe('fatal');
  });

  it('reads the timestamp in local time in the current year', () => {
    const [entry] = parse('10-13 14:02:31.004  4242  4242 I a: b\n');
    expect(entry?.ts).toBe(new Date(2026, 9, 13, 14, 2, 31, 4).getTime());
  });

  it('splits a Java stack trace from the first line of its message', () => {
    const entries = parse(THREADTIME_FIXTURE);
    const okhttp = entries.find((e) => e.tag === 'OkHttp');
    expect(okhttp?.message).toBe('Request to /api/cart failed');
    expect(okhttp?.stack?.split('\n')).toEqual([
      'java.net.SocketTimeoutException: timeout',
      '\tat okhttp3.internal.http2.Http2Stream$StreamTimeout.newTimeoutException(Http2Stream.kt:675)',
      '\tat okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:143)',
      '\t... 12 more',
    ]);
    const crash = entries.find((e) => e.tag === 'AndroidRuntime');
    expect(crash?.message).toBe('FATAL EXCEPTION: main');
    expect(crash?.stack).toMatch(/^Process: com\.example\.shop, PID: 4242\n/);
    expect(crash?.stack).toContain('\nCaused by: java.lang.IllegalStateException: boom\n');
    expect(crash?.stack?.split('\n')).toHaveLength(7);
  });

  it('keeps a multi-line message without stack frames in the message', () => {
    const [entry] = parse(
      '10-13 14:02:31.004  4242  4242 I a: line one\n10-13 14:02:31.004  4242  4242 I a: line two\n',
    );
    expect(entry).toMatchObject({ message: 'line one\nline two' });
    expect(entry?.stack).toBeUndefined();
  });

  it('does not merge lines from another thread or millisecond', () => {
    const entries = parse(
      [
        '10-13 14:02:31.004  4242  4242 I a: one',
        '10-13 14:02:31.004  4242  4243 I a: two',
        '10-13 14:02:31.005  4242  4243 I a: three',
        '10-13 14:02:31.005  4242  4243 W a: four',
        '10-13 14:02:31.005  4242  4243 W b: five',
        '',
      ].join('\n'),
    );
    expect(entries.map((e) => e.message)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('handles lines split across chunks and CRLF endings', () => {
    const out: LogEntry[] = [];
    const parser = new ThreadtimeParser(
      (e) => out.push(e),
      () => NOW,
    );
    parser.write('10-13 14:02:31.004  4242  42');
    parser.write('42 I a: one\r\r\n10-13 14:02:31.005  4242  4242 I a: two\r\n');
    parser.flush();
    expect(out.map((e) => e.message)).toEqual(['one', 'two']);
  });

  it('holds the last entry until the next header or a flush', () => {
    const out: LogEntry[] = [];
    const parser = new ThreadtimeParser(
      (e) => out.push(e),
      () => NOW,
    );
    parser.write('10-13 14:02:31.004  4242  4242 E a: boom\n');
    expect(out).toHaveLength(0);
    parser.write('10-13 14:02:31.004  4242  4242 E a: \tat x.y(Z.java:1)\n');
    expect(out).toHaveLength(0);
    parser.flush();
    expect(out).toEqual([
      expect.objectContaining({ message: 'boom', stack: '\tat x.y(Z.java:1)' }),
    ]);
    parser.flush();
    expect(out).toHaveLength(1);
  });

  it('attaches stray lines to the pending entry and drops them otherwise', () => {
    const entries = parse(
      'stray before\n10-13 14:02:31.004  4242  4242 I a: one\nwrapped tail\n--------- beginning of main\n',
    );
    expect(entries).toEqual([expect.objectContaining({ message: 'one\nwrapped tail' })]);
  });

  it('caps the number of lines in one entry', () => {
    const header = '10-13 14:02:31.004  4242  4242 E a: ';
    const lines = [`${header}boom`];
    for (let i = 0; i < MAX_LINES_PER_ENTRY + 50; i++) lines.push(`${header}\tat f${i}(A.java:1)`);
    const [entry] = parse(lines.join('\n') + '\n');
    const stack = entry?.stack?.split('\n') ?? [];
    expect(stack).toHaveLength(MAX_LINES_PER_ENTRY);
    expect(stack.at(-1)).toBe('… lines dropped');
  });

  it('caps an endless line without a newline', () => {
    const out: LogEntry[] = [];
    const parser = new ThreadtimeParser(
      (e) => out.push(e),
      () => NOW,
    );
    parser.write('10-13 14:02:31.004  4242  4242 I a: ' + 'x'.repeat(100_000));
    parser.write('\n');
    parser.flush();
    expect(out[0]?.message.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('timestampFor', () => {
  it('puts a December line read in January in the previous year', () => {
    const now = new Date(2027, 0, 1, 0, 5);
    expect(timestampFor(12, 31, 23, 59, 59, 900, now)).toBe(
      new Date(2026, 11, 31, 23, 59, 59, 900).getTime(),
    );
  });

  it('puts a January line read on 31 December in the next year', () => {
    const now = new Date(2026, 11, 31, 23, 59, 58);
    expect(timestampFor(1, 1, 0, 0, 1, 0, now)).toBe(new Date(2027, 0, 1, 0, 0, 1).getTime());
  });

  it('keeps the current year for lines from earlier this year', () => {
    expect(timestampFor(3, 1, 9, 0, 0, 0, NOW)).toBe(new Date(2026, 2, 1, 9).getTime());
  });
});
