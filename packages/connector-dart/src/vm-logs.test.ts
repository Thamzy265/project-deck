import { describe, expect, it, vi } from 'vitest';
import { LineBuffer, entryFromLogRecord, levelFromDart } from './vm-logs.js';
import { loggingEvent } from './testing/fixtures.js';

describe('levelFromDart', () => {
  it('maps package:logging levels', () => {
    expect(levelFromDart(0)).toBe('info');
    expect(levelFromDart(300)).toBe('verbose');
    expect(levelFromDart(500)).toBe('debug');
    expect(levelFromDart(800)).toBe('info');
    expect(levelFromDart(900)).toBe('warn');
    expect(levelFromDart(1000)).toBe('error');
    expect(levelFromDart(1200)).toBe('fatal');
  });
});

describe('entryFromLogRecord', () => {
  it('builds an entry with tag, error and stack', () => {
    const { logRecord } = loggingEvent({
      message: 'Order failed',
      level: 1000,
      loggerName: 'orders',
      error: 'StateError: closed',
      stackTrace: '#0 main (package:shop/main.dart:12:3)',
      time: 42,
    }).event;
    expect(entryFromLogRecord(logRecord, 0)).toEqual({
      ts: 42,
      level: 'error',
      source: 'app',
      tag: 'orders',
      message: 'Order failed\nStateError: closed',
      stack: '#0 main (package:shop/main.dart:12:3)',
    });
  });

  it('omits empty logger names and null references', () => {
    const { logRecord } = loggingEvent({ message: 'hi' }).event;
    expect(entryFromLogRecord(logRecord, 0)).toEqual({
      ts: 2000,
      level: 'info',
      source: 'app',
      message: 'hi',
    });
  });

  it('marks truncated strings and ignores records without a message', () => {
    const record = {
      message: { kind: 'String', valueAsString: 'long', valueAsStringIsTruncated: true },
      level: 800,
    };
    expect(entryFromLogRecord(record, 5)?.message).toBe('long…');
    expect(entryFromLogRecord({ level: 800 }, 5)).toBeUndefined();
    expect(entryFromLogRecord(null, 5)).toBeUndefined();
  });
});

describe('LineBuffer', () => {
  it('joins chunks into lines and keeps the first chunk time', () => {
    const lines: [string, number][] = [];
    const buf = new LineBuffer((line, ts) => lines.push([line, ts]));
    buf.write('flutter: hel', 1);
    buf.write('lo', 2);
    buf.write('\n', 3);
    buf.write('a\r\nb\n', 4);
    expect(lines).toEqual([
      ['flutter: hello', 1],
      ['a', 4],
      ['b', 4],
    ]);
  });

  it('flushes a dangling partial line after an idle gap', () => {
    vi.useFakeTimers();
    const onLine = vi.fn();
    const buf = new LineBuffer(onLine, 100);
    buf.write('no newline', 7);
    expect(onLine).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onLine).toHaveBeenCalledWith('no newline', 7);
    vi.useRealTimers();
  });
});
