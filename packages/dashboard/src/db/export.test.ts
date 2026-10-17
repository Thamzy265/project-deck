import { describe, expect, it } from 'vitest';
import { csvField, toCsv, toJson } from './export.js';

describe('csvField (design note U3)', () => {
  it('quotes every field and doubles quotes inside it', () => {
    expect(csvField('Coffee')).toBe('"Coffee"');
    expect(csvField('say "hi", ok\nnext')).toBe('"say ""hi"", ok\nnext"');
    expect(csvField(null)).toBe('""');
  });

  it('defuses text that a spreadsheet would run as a formula', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvField(`${lead}HYPERLINK("http://x")`)).toBe(`"'${lead}HYPERLINK(""http://x"")"`);
    }
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('a=1')).toBe('"a=1"');
    // Behind no-break, ideographic and zero-width spaces too (TAB-8).
    for (const space of ['\u00a0', '\u3000', '\u200b', '\u2003']) {
      expect(csvField(`${space}=1+1`).startsWith(`"'`), JSON.stringify(space)).toBe(true);
    }
    expect(csvField(' a=1')).toBe('" a=1"');
  });

  it('leaves numbers as numbers, negative ones included', () => {
    expect(csvField(-5)).toBe('"-5"');
    expect(csvField(1.25)).toBe('"1.25"');
    expect(csvField({ type: 'int', value: '-9007199254740993' })).toBe('"-9007199254740993"');
    expect(csvField({ type: 'real', value: '-Infinity' })).toBe('"-Infinity"');
  });

  it('writes blobs as their size, never their bytes', () => {
    expect(csvField({ type: 'blob', bytes: 2150, base64: 'AAAA' })).toBe('"BLOB 2150 bytes"');
  });
});

describe('toCsv', () => {
  it('writes a header and one line per row, with CRLF line ends', () => {
    expect(
      toCsv(
        ['id', '=evil'],
        [
          [1, 'a'],
          [2, null],
        ],
      ),
    ).toBe(`"id","'=evil"\r\n"1","a"\r\n"2",""\r\n`);
  });
});

describe('toJson', () => {
  it('keeps the columns and rows as they are, even with repeated column names', () => {
    const json = toJson(['a', 'a'], [[1, { type: 'blob', bytes: 2 }]]);
    expect(JSON.parse(json)).toEqual({
      columns: ['a', 'a'],
      rows: [[1, { type: 'blob', bytes: 2 }]],
    });
  });
});
