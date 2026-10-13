import type { LogEntry } from '@project-deck/core';
import { LogEntrySchema } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { EPOCH_FIXTURE, THREADTIME_FIXTURE } from './testing/fixtures.js';
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

describe('ThreadtimeParser edge cases', () => {
  const at = (rest: string, time = '14:02:31.004', ids = ' 4242  4242'): string =>
    `10-13 ${time} ${ids} ${rest}`;

  it('reads tags with spaces, colons or nothing at all', () => {
    const entries = parse(
      [
        at('I Some Tag: spaced'),
        at('I chromium:render: colon in tag', '14:02:31.005'),
        at('W         : empty tag', '14:02:31.006'),
        at('I VeryLongTagWithoutPadding: tight', '14:02:31.007'),
        '',
      ].join('\n'),
    );
    expect(entries.map((e) => [e.tag, e.message])).toEqual([
      ['Some Tag', 'spaced'],
      ['chromium:render', 'colon in tag'],
      ['', 'empty tag'],
      ['VeryLongTagWithoutPadding', 'tight'],
    ]);
  });

  it('keeps leading spaces in the message after the separator', () => {
    const [entry] = parse(at('I a:    indented\n'));
    expect(entry?.message).toBe('   indented');
  });

  it('reads seven-digit pids and tids (64-bit pid_max)', () => {
    const [entry] = parse(at('I a: big', '14:02:31.004', '1234567 4194303') + '\n');
    expect(entry).toMatchObject({ tag: 'a', message: 'big' });
  });

  it('maps F to fatal and ignores every logcat buffer separator', () => {
    const entries = parse(
      [
        '--------- beginning of crash',
        at('F libc    : Fatal signal 11 (SIGSEGV)'),
        '--------- beginning of events',
        '--------- switch to main',
        at('F libc    : second', '14:02:31.010'),
        '',
      ].join('\n'),
    );
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['fatal', 'Fatal signal 11 (SIGSEGV)'],
      ['fatal', 'second'],
    ]);
  });

  it('keeps a 200-line native backtrace as separate entries when each line has its own timestamp', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      const ms = String(i % 1000).padStart(3, '0');
      const s = String(10 + Math.floor(i / 1000)).padStart(2, '0');
      lines.push(
        at(`F DEBUG   :       #${i} pc 000${i} /system/lib64/libc.so`, `14:02:${s}.${ms}`),
      );
    }
    const entries = parse(lines.join('\n') + '\n');
    expect(entries).toHaveLength(200);
    expect(entries.every((e) => e.level === 'fatal' && e.stack === undefined)).toBe(true);
  });

  it('keeps a 200-line dump from one log call in one entry with the dropped marker', () => {
    const lines = [at('F DEBUG   : *** *** *** *** *** ***')];
    for (let i = 0; i < 200; i++) lines.push(at(`F DEBUG   :       #${i} pc 0000 libc.so`));
    const [entry, ...others] = parse(lines.join('\n') + '\n');
    expect(others).toEqual([]);
    const all = entry?.message.split('\n') ?? [];
    // The cap counts the continuation lines; the first line comes on top.
    expect(all).toHaveLength(MAX_LINES_PER_ENTRY + 1);
    expect(all.at(-1)).toBe('… lines dropped');
  });

  it('does not merge lines that alternate between two threads', () => {
    const entries = parse(
      [
        at('E a: A1', '14:02:31.004', ' 4242  4242'),
        at('E a: B1', '14:02:31.004', ' 4242  4243'),
        at('E a: A2', '14:02:31.004', ' 4242  4242'),
        '',
      ].join('\n'),
    );
    expect(entries.map((e) => e.message)).toEqual(['A1', 'B1', 'A2']);
  });

  it('caps a very long complete line and keeps parsing after it', () => {
    const entries = parse(
      at('I a: ' + 'x'.repeat(200_000)) + '\n' + at('I b: after', '14:02:31.005') + '\n',
    );
    expect(entries.map((e) => e.tag)).toEqual(['a', 'b']);
    expect(entries[0]?.message.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('accepts a leap-day line in a leap year', () => {
    const [entry] = parse(
      '02-29 12:00:00.000  4242  4242 I a: leap\n',
      new Date(2028, 2, 1, 9, 0, 0),
    );
    expect(entry?.ts).toBe(new Date(2028, 1, 29, 12).getTime());
  });
});

describe('ThreadtimeParser date validation', () => {
  it('treats a header-like line with an impossible date as continuation text', () => {
    const entries = parse(
      [
        '10-13 14:02:31.004  4242  4242 I a: real',
        '13-45 14:02:31.004  4242  4242 I a: not a date',
        '02-30 14:02:31.004  4242  4242 I a: nor this',
        '',
      ].join('\n'),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        message:
          'real\n13-45 14:02:31.004  4242  4242 I a: not a date\n02-30 14:02:31.004  4242  4242 I a: nor this',
      }),
    ]);
  });
});

describe('timestampFor edge cases', () => {
  // A 29 February line can only come from a leap year; Date silently rolls it over to 1 March.
  it('puts 29 February in the latest leap year that is not in the future', () => {
    const now = new Date(2027, 2, 5, 12);
    expect(timestampFor(2, 29, 12, 0, 0, 0, now)).toBe(new Date(2024, 1, 29, 12).getTime());
  });

  it.each([
    [13, 1, 0, 0, 0],
    [0, 10, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [4, 31, 0, 0, 0],
    [2, 30, 0, 0, 0],
    [10, 13, 24, 0, 0],
    [10, 13, 23, 60, 0],
    [10, 13, 23, 59, 60],
  ])('rejects the impossible date %i-%i %i:%i:%i', (mo, d, h, mi, s) => {
    expect(timestampFor(mo, d, h, mi, s, 0, NOW)).toBeUndefined();
  });

  it('keeps millisecond order across midnight on 31 December', () => {
    const now = new Date(2027, 0, 1, 0, 0, 5);
    const before = timestampFor(12, 31, 23, 59, 59, 999, now);
    const after = timestampFor(1, 1, 0, 0, 0, 1, now);
    expect((after ?? Number.NaN) - (before ?? Number.NaN)).toBe(2);
  });
});

describe('ThreadtimeParser with -v epoch', () => {
  it('reads epoch seconds exactly, whatever the host date or timezone', () => {
    const entries = parse(EPOCH_FIXTURE, new Date(2031, 0, 1));
    for (const e of entries) expect(LogEntrySchema.parse(e)).toEqual(e);
    expect(entries.map((e) => [e.ts, e.level, e.tag])).toEqual([
      [1697050000123, 'info', 'FlutterJNI'],
      [1697050000456, 'info', 'flutter'],
      [1697050001002, 'warn', 'ResourceType'],
      [1697050002870, 'error', 'OkHttp'],
      [1697050003460, 'fatal', 'libc'],
    ]);
  });

  it('groups a multi-line epoch message and splits off its stack', () => {
    const okhttp = parse(EPOCH_FIXTURE).find((e) => e.tag === 'OkHttp');
    expect(okhttp).toMatchObject({
      message: 'Request to /api/cart failed',
      stack:
        'java.net.SocketTimeoutException: timeout\n\tat okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:143)',
    });
  });

  it('accepts either format in the same stream', () => {
    const entries = parse(
      '1697050000.123  4242  4242 I a: epoch\n10-13 14:02:31.004  4242  4242 I b: threadtime\n',
    );
    expect(entries.map((e) => e.tag)).toEqual(['a', 'b']);
  });
});
