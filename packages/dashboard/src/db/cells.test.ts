import { describe, expect, it } from 'vitest';
import { cellText, formatBytes, keyParam, visibleSegments } from './cells.js';

describe('cellText', () => {
  it('shows each cell type as one line of text', () => {
    expect(cellText(null)).toEqual({ text: 'null', muted: true });
    expect(cellText(12)).toEqual({ text: '12', muted: false });
    expect(cellText(1.5)).toEqual({ text: '1.5', muted: false });
    expect(cellText('Coffee')).toEqual({ text: 'Coffee', muted: false });
    expect(cellText({ type: 'int', value: '9007199254740993' })).toEqual({
      text: '9007199254740993',
      muted: false,
    });
    expect(cellText({ type: 'real', value: '-Infinity' })).toEqual({
      text: '-Infinity',
      muted: false,
    });
    expect(cellText({ type: 'blob', bytes: 2150 })).toEqual({ text: 'BLOB 2.1 KB', muted: true });
  });
});

describe('formatBytes', () => {
  it('uses B, KB and MB with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2150)).toBe('2.1 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('visibleSegments', () => {
  it('leaves ordinary text alone', () => {
    expect(visibleSegments('SELECT 1')).toEqual([{ text: 'SELECT 1' }]);
  });

  it('names bidi, zero-width and control characters instead of letting them act', () => {
    expect(visibleSegments('a‮b​c\u0007d⁦')).toEqual([
      { text: 'a' },
      { mark: 'U+202E' },
      { text: 'b' },
      { mark: 'U+200B' },
      { text: 'c' },
      { mark: 'U+0007' },
      { text: 'd' },
      { mark: 'U+2066' },
    ]);
  });

  it('keeps line breaks and tabs in multi-line text, and names them on one line', () => {
    expect(visibleSegments('a\nb\tc', { multiline: true })).toEqual([{ text: 'a\nb\tc' }]);
    expect(visibleSegments('a\r\nb')).toEqual([
      { text: 'a' },
      { mark: 'U+000D' },
      { mark: 'U+000A' },
      { text: 'b' },
    ]);
  });
});

describe('keyParam', () => {
  it('turns key cells into SQL parameters, and refuses those JSON cannot carry', () => {
    expect(keyParam(3)).toEqual({ ok: true, value: 3 });
    expect(keyParam('a')).toEqual({ ok: true, value: 'a' });
    expect(keyParam(null)).toEqual({ ok: true, value: null });
    // Column affinity turns the text back into the integer when SQLite compares.
    expect(keyParam({ type: 'int', value: '9007199254740993' })).toEqual({
      ok: true,
      value: '9007199254740993',
    });
    expect(keyParam({ type: 'blob', bytes: 3, base64: 'AAAA' })).toEqual({ ok: false });
    expect(keyParam({ type: 'real', value: 'NaN' })).toEqual({ ok: false });
  });
});
