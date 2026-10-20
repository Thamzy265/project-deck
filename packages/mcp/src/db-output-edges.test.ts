/**
 * Tester probes of the 20 kB cut for database answers: the exact boundary, wide and
 * empty results, multi-byte text, and that the untrusted note and the "truncated" flag
 * survive every way of cutting.
 */
import { DB_UNTRUSTED_TEXT } from '@project-deck/core';
import type { TableInfo } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { fitDiff, fitQuery, fitSchema, schemaForClaude } from './db-output.js';
import type { JsonValue } from './mask/masker.js';
import { MAX_OUTPUT_BYTES, fitStatus } from './output.js';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const frame = {
  note: DB_UNTRUSTED_TEXT,
  masking: 'Masking for Claude is on.',
  warnings: [],
  durationMs: 1,
};
/** SQLite's default SQLITE_MAX_COLUMN: a SELECT may return this many columns. */
const MAX_COLUMNS = 2000;
const wideColumns = Array.from({ length: MAX_COLUMNS }, (_, i) => `customer_note_column_${i}_x`);
/** A lone UTF-16 surrogate, as JSON.stringify writes one. */
const LONE_SURROGATE =
  /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

describe('fitQuery at the 20 kB boundary', () => {
  const base = size(fitQuery(frame, ['a'], [['']], false));

  it('keeps an answer of exactly 20 000 bytes whole', () => {
    const out = fitQuery(frame, ['a'], [['x'.repeat(MAX_OUTPUT_BYTES - base)]], false);
    expect(size(out)).toBe(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty('hint');
  });

  it('cuts an answer one byte over and says so', () => {
    const out = fitQuery(frame, ['a'], [['x'.repeat(MAX_OUTPUT_BYTES - base + 1)]], false);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(1);
    expect(out.hint).toMatch(/cut to 20 kB/);
  });

  it('counts bytes, not characters, for multi-byte text', () => {
    const rows = Array.from({ length: 300 }, () => ['漢字😀'.repeat(20)]);
    const out = fitQuery(frame, ['t'], rows, false);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.rows).toEqual(rows.slice(0, Number(out.rowCount)));
  });

  it('keeps 500 tiny rows whole when they fit', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    const out = fitQuery(frame, ['n'], rows, false);
    expect(out).toMatchObject({ rowCount: 500, truncated: false });
  });

  it('says the result was cut when the daemon cut it, even with no rows', () => {
    const out = fitQuery(frame, ['n'], [], true);
    expect(out).toMatchObject({ rowCount: 0, truncated: true, note: DB_UNTRUSTED_TEXT });
  });

  // MCP-1: with no rows, a wide result (many or long column names) is returned whole,
  // however big: largestFitting gives -1 and the empty case builds it anyway.
  it.fails('keeps a wide result with no rows within 20 kB', () => {
    const out = fitQuery(frame, wideColumns, [], false);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
  });

  // MCP-2: the last resort answer drops the frame: no untrusted note, no masking line.
  it.fails('keeps the untrusted note when not even one wide row fits', () => {
    const out = fitQuery(frame, wideColumns, [wideColumns.map(() => 1)], false);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
    expect(out.masking).toBe(frame.masking);
  });

  // MCP-2: shortenToFit cuts every string, the note and the hint included, so at 64
  // characters the note no longer says the text is untrusted.
  it.fails('never cuts the untrusted note or the hint while cutting cell text', () => {
    const columns = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const out = fitQuery(frame, columns, [columns.map(() => 'y'.repeat(4096))], false);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
    expect(out.hint).toMatch(/count\(\*\)/);
  });

  // MCP-3: `shorten` cuts at a UTF-16 index, so it can split an emoji (a lone surrogate
  // reaches Claude) and a mask marker; the masker's own cut avoids both.
  it.fails('never splits an emoji when it cuts a cell', () => {
    const out = fitQuery(frame, ['a'], [[`a${'😀'.repeat(6000)}`]], false);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(LONE_SURROGATE);
  });

  it.fails('never splits a mask marker when it cuts a cell', () => {
    const cell = `${'x'.repeat(2040)}[email masked]${'y'.repeat(30_000)}`;
    const out = fitQuery(frame, ['a'], [[cell]], false);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/\[email m(?!asked\])/);
  });
});

describe('fitSchema edges', () => {
  const table = (name: string, columns: number): TableInfo => ({
    name,
    kind: 'table',
    columns: Array.from({ length: columns }, (_, i) => ({
      name: `col_${i}`,
      type: 'TEXT',
      nullable: true,
      pk: false,
      default: null,
    })),
    foreignKeys: [],
    indexes: [],
  });

  it('names at most 200 left-out tables and counts all of them', () => {
    const tables = schemaForClaude(Array.from({ length: 1000 }, (_, i) => table(`t${i}`, 20)));
    const out = fitSchema(frame, tables);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect((out.leftOutNames as unknown[]).length).toBeLessThanOrEqual(200);
    expect(Number(out.tablesLeftOut) + (out.tables as unknown[]).length).toBe(1000);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
  });

  it('cuts a single table too wide to show and stays within 20 kB', () => {
    const out = fitSchema(frame, schemaForClaude([table('wide', MAX_COLUMNS)]));
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
  });

  // MCP-2: the same cut-every-string fallback shortens the note here too.
  it.fails('keeps the note when 200 long left-out names alone pass 20 kB', () => {
    const tables = schemaForClaude(
      Array.from({ length: 300 }, (_, i) => table(`${'n'.repeat(4000)}${i}`, 1)),
    );
    const out = fitSchema(frame, tables);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
  });
});

describe('fitDiff edges', () => {
  const tableDiff = (name: string, rows: number, text = 'x'): JsonValue => ({
    table: name,
    columns: ['id', 'note'],
    key: ['id'],
    counts: { added: rows, changed: 0, removed: 0 },
    added: Array.from({ length: rows }, (_, i) => ({ key: i, row: [i, text] })),
    changed: [],
    removed: [],
  });

  it('cuts rows before tables, keeps real counts and the note', () => {
    const diff = {
      db: 'app',
      snapshotId: 's',
      snapshotTakenAt: 1,
      tables: Array.from({ length: 20 }, (_, i) => tableDiff(`t${i}`, 50, 'y'.repeat(100))),
      truncated: false,
      tablesLeftOut: 0,
    };
    const out = fitDiff(frame, diff);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
    const tables = out.tables as {
      counts: { added: number };
      added: unknown[];
      truncated?: boolean;
    }[];
    expect(tables).toHaveLength(20);
    for (const t of tables) {
      expect(t.counts.added).toBe(50);
      expect(t.added.length).toBeLessThan(50);
      expect(t.truncated).toBe(true);
    }
  });

  it('leaves out tables when even empty lists pass 20 kB, and counts them', () => {
    const diff = {
      db: 'app',
      snapshotId: 's',
      snapshotTakenAt: 1,
      tables: Array.from({ length: 20 }, (_, i) => ({
        ...(tableDiff(`t${i}`, 1) as object),
        columns: Array.from({ length: 300 }, (_, c) => `column_${c}`),
      })),
      truncated: false,
      tablesLeftOut: 3,
    };
    const out = fitDiff(frame, diff);
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(Number(out.tablesLeftOut) + (out.tables as unknown[]).length).toBe(23);
  });

  it("keeps the daemon's truncated flag when nothing more is cut here", () => {
    const diff = {
      db: 'app',
      snapshotId: 's',
      snapshotTakenAt: 1,
      tables: [tableDiff('t', 1)],
      truncated: true,
      tablesLeftOut: 0,
    };
    const out = fitDiff(frame, diff);
    expect(out.truncated).toBe(true);
    expect(out.hint).toBeDefined();
  });
});

describe('db_list and db_snapshot cuts (fitStatus)', () => {
  // MCP-2: past 20 kB at 32 characters a string, the answer is only
  // "FlutterDeck status was too large to show": wrong tool, and no untrusted note.
  it.fails('keeps the note, and names the database list, when many databases pass 20 kB', () => {
    const databases = Array.from({ length: 1000 }, (_, i) => ({
      name: `db_${i}_${'x'.repeat(100)}`,
      backend: 'live',
      source: 'drift',
    }));
    const out = fitStatus({ ...frame, databases, problems: [] });
    expect(size(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.note).toBe(DB_UNTRUSTED_TEXT);
    expect(JSON.stringify(out)).not.toMatch(/status was too large/);
  });
});
