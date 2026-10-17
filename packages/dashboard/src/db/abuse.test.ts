/**
 * Tester probes of the Database tab's helpers against the design note's abuse cases
 * (docs/design/m3-drift-inspector.md, "Trust boundaries and abuse cases", U3) and the
 * UI spec's confirm dialog rules (docs/ui/m3-database-tab.md).
 */
import type { TableInfo } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { visibleSegments, visibleText } from './cells.js';
import { csvField, exportName, toCsv, toJson } from './export.js';
import { rowKey } from './keys.js';
import { deleteRow, inputParam, insertRow, quoteIdent, updateRow } from './sql-build.js';

const cp = (ch: string) =>
  `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

describe('CSV export: formula injection (U3)', () => {
  it('defuses every trigger character the design note lists', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvField(`${lead}cmd|' /C calc'!A0`)).toBe(
        `"'${`${lead}cmd|' /C calc'!A0`.replaceAll('"', '""')}"`,
      );
    }
  });

  it.fails(
    'defuses a formula behind leading spaces, which spreadsheets that trim on import run',
    () => {
      // Google Sheets and LibreOffice can trim fields on import and then read `=` as a formula.
      for (const text of [' =HYPERLINK("http://x")', ' =1+1', '  +1+1', ' @SUM(A1)']) {
        expect(csvField(text).startsWith(`"'`), JSON.stringify(text)).toBe(true);
      }
    },
  );

  it('defuses formula-shaped column names in the header row', () => {
    const csv = toCsv(['=cmd', 'ok'], [[1, 'a']]);
    expect(csv.split('\r\n')[0]).toBe(`"'=cmd","ok"`);
  });

  it('keeps quotes, newlines and unicode inside one quoted field', () => {
    const csv = toCsv(['v'], [['a "b"\r\nc,d ‮\u0000 😀']]);
    expect(csv).toBe(`"v"\r\n"a ""b""\r\nc,d ‮\u0000 😀"\r\n`);
  });

  it('writes numbers as numbers and blobs as their size, never bytes', () => {
    expect(csvField(-5)).toBe('"-5"');
    expect(csvField({ type: 'int', value: '-9007199254740993' })).toBe('"-9007199254740993"');
    expect(csvField({ type: 'blob', bytes: 3 })).toBe('"BLOB 3 bytes"');
    expect(csvField(null)).toBe('""');
  });

  it('JSON export keeps lone surrogates and NUL as valid JSON', () => {
    const json = toJson(['v'], [['\ud800x\u0000']]);
    expect(JSON.parse(json)).toEqual({ columns: ['v'], rows: [['\ud800x\u0000']] });
  });
});

describe('export file names from untrusted table names', () => {
  it('never keeps a path, a bidi override or a leading dot', () => {
    expect(exportName('../../etc/passwd', 'csv')).toBe('etc_passwd.csv');
    expect(exportName('..\\..\\x', 'json')).toBe('x.json');
    expect(exportName('orders‮txt.exe', 'csv')).toBe('orders_txt.exe.csv');
    expect(exportName('.hidden', 'csv')).toBe('hidden.csv');
    expect(exportName('注文', 'csv')).toBe('export.csv');
    expect(exportName('a\u0000b', 'csv')).toBe('a_b.csv');
    expect(exportName('x'.repeat(500), 'csv')).toBe(`${'x'.repeat(80)}.csv`);
  });
});

describe('visible marks for characters that act unseen (abuse cases)', () => {
  it('names bidi, zero-width and control characters (regression lock)', () => {
    for (const ch of ['‮', '⁦', '​', '‍', '﻿', '\u0000', '\u007f']) {
      expect(visibleSegments(`a${ch}b`)).toEqual([{ text: 'a' }, { mark: cp(ch) }, { text: 'b' }]);
    }
  });

  it.fails(
    'names the other invisible characters too: tags, soft hyphen, separators, fillers',
    () => {
      // Each renders as nothing (or as an unexpected line break) in Chromium, so a value or
      // the confirm dialog's SQL could carry text the user never sees.
      const invisible = [
        '\u{E0041}', // TAG LATIN CAPITAL LETTER A ("ASCII smuggling")
        '\u{E0001}', // LANGUAGE TAG
        '­', // SOFT HYPHEN
        '͏', // COMBINING GRAPHEME JOINER
        '᠎', // MONGOLIAN VOWEL SEPARATOR
        ' ', // LINE SEPARATOR
        ' ', // PARAGRAPH SEPARATOR
        'ᅟ', // HANGUL CHOSEONG FILLER
        'ㅤ', // HANGUL FILLER
        '￹', // INTERLINEAR ANNOTATION ANCHOR
      ];
      for (const ch of invisible) {
        expect(visibleText(`a${ch}b`), cp(ch)).toBe(`a<${cp(ch)}>b`);
      }
    },
  );
});

const col = (name: string, type: string, pk: number | undefined) => ({
  name,
  type,
  nullable: true,
  pk: pk !== undefined,
  ...(pk === undefined ? {} : { pkPosition: pk }),
  default: null,
});

describe('edit keys: the WHERE clause must match one row only', () => {
  it('composite keys keep key order, whatever the column order (regression lock)', () => {
    const t: TableInfo = {
      name: 't',
      kind: 'table',
      columns: [col('v', 'TEXT', undefined), col('b', 'TEXT', 2), col('a', 'INTEGER', 1)],
      foreignKeys: [],
      indexes: [],
    };
    const key = rowKey(t, ['v', 'b', 'a'], ['x', 'k', 7]);
    expect(key).toEqual({ columns: ['a', 'b'], values: [7, 'k'] });
    expect(deleteRow('t', key ?? { columns: [], values: [] })).toEqual({
      sql: 'DELETE FROM "t" WHERE "a" IS ? AND "b" IS ?',
      params: [7, 'k'],
    });
  });

  it.fails(
    'a NULL key value is not editable: SQLite allows many NULL keys in a rowid table',
    () => {
      // `CREATE TABLE t (code TEXT PRIMARY KEY, v)` accepts two rows with code NULL, and
      // `DELETE FROM "t" WHERE "code" IS ?` with null then deletes both.
      const t: TableInfo = {
        name: 't',
        kind: 'table',
        columns: [col('code', 'TEXT', 1), col('v', 'TEXT', undefined)],
        foreignKeys: [],
        indexes: [],
      };
      expect(rowKey(t, ['code', 'v'], [null, 'first'])).toBeUndefined();
    },
  );

  it.fails('a key past 2^53 in a column without numeric affinity is not editable', () => {
    // The key travels as text; with no type affinity SQLite won't turn it back into the
    // integer, so `"k" IS '9007199254740993'` matches a text row with those digits instead.
    const t: TableInfo = {
      name: 't',
      kind: 'table',
      columns: [col('k', '', 1), col('v', 'TEXT', undefined)],
      foreignKeys: [],
      indexes: [],
    };
    expect(
      rowKey(t, ['k', 'v'], [{ type: 'int', value: '9007199254740993' }, 'x']),
    ).toBeUndefined();
  });
});

describe('edit SQL building with hostile identifiers (regression locks)', () => {
  it('doubles quotes and leaves brackets, backticks and NUL inside the quoted name', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent('"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"');
    expect(quoteIdent('[x]`y`')).toBe('"[x]`y`"');
    expect(quoteIdent('a\u0000b')).toBe('"a\u0000b"');
  });

  it('keeps every value a parameter, in the order the SQL names them', () => {
    const built = updateRow('o"rders', { columns: ['id'], values: [1] }, [
      { column: 'it"em', value: "x'); DROP TABLE orders; --" },
      { column: 'n', value: null },
    ]);
    expect(built).toEqual({
      sql: 'UPDATE "o""rders" SET "it""em" = ?, "n" = ? WHERE "id" IS ?',
      params: ["x'); DROP TABLE orders; --", null, 1],
    });
    expect(insertRow('t', [])).toEqual({ sql: 'INSERT INTO "t" DEFAULT VALUES', params: [] });
  });

  it('turns typed text into a number only when it reads as one exactly', () => {
    expect(inputParam('1e400', 'REAL')).toBe('1e400');
    expect(inputParam('Infinity', 'REAL')).toBe('Infinity');
    expect(inputParam('0x10', 'INTEGER')).toBe('0x10');
    expect(inputParam(' 5', 'INTEGER')).toBe(' 5');
    expect(inputParam('9007199254740993', 'INTEGER')).toBe('9007199254740993');
    expect(inputParam('12', 'TEXT')).toBe('12');
    expect(inputParam('12', 'INTEGER')).toBe(12);
  });
});
