/**
 * Regression tests for the reviewer's findings on batch 1 (S1–S6, C1). Every statement
 * runs through the real bundled sqlite-wasm.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GuardEngine, loadSqlite } from './engine.js';
import type { GuardResult, HiddenColumn } from './types.js';

let engine: GuardEngine;
beforeAll(async () => {
  engine = new GuardEngine(await loadSqlite());
});

function read(
  schemaSql: readonly string[],
  sql: string,
  hiddenColumns: HiddenColumn[] = [],
): GuardResult {
  return engine.check(sql, { schemaSql, mode: 'read', hiddenColumns });
}

describe('S4: names that contain a dot', () => {
  const schema = [
    'CREATE TABLE "a.b"(c TEXT, d TEXT)',
    'CREATE INDEX "a.b_c" ON "a.b"(c)',
    'CREATE TABLE a("b.c" TEXT, x TEXT)',
  ];

  it('never mixes up table "a.b" column c with table a column "b.c"', () => {
    const hidden = [{ table: 'a', column: 'b.c' }];
    expect(read(schema, 'SELECT c FROM "a.b"', hidden)).toMatchObject({ ok: true });
    expect(read(schema, 'SELECT "b.c" FROM a', hidden)).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
  });

  it('checks a hidden column of a table with a dot in its name at the bytecode level', () => {
    const hidden = [{ table: 'a.b', column: 'c' }];
    expect(
      read(schema, 'SELECT d FROM "a.b" JOIN (SELECT 1 AS c) USING (c)', hidden),
    ).toMatchObject({ ok: false, code: 'hidden-column' });
    expect(read(schema, 'SELECT d FROM "a.b" INDEXED BY "a.b_c"', hidden)).toMatchObject({
      ok: false,
      code: 'hidden-column',
    });
    expect(read(schema, 'SELECT d FROM "a.b"', hidden)).toMatchObject({ ok: true });
  });
});

describe('S1: shadow tables of virtual tables the gate could not create', () => {
  // As SQLite writes them into sqlite_schema for an fts4 table (fts3_write.c).
  const fts4 = [
    'CREATE VIRTUAL TABLE notes USING fts4(title, body)',
    "CREATE TABLE 'notes_content'(docid INTEGER PRIMARY KEY, 'c0title', 'c1body')",
    "CREATE TABLE 'notes_segments'(blockid INTEGER PRIMARY KEY, block BLOB)",
    "CREATE TABLE 'notes_segdir'(level INTEGER,idx INTEGER,start_block INTEGER,leaves_end_block INTEGER,end_block INTEGER,root BLOB,PRIMARY KEY(level, idx))",
    "CREATE TABLE 'notes_docsize'(docid INTEGER PRIMARY KEY, size BLOB)",
    "CREATE TABLE 'notes_stat'(id INTEGER PRIMARY KEY, value BLOB)",
    'CREATE TABLE audit(id INTEGER PRIMARY KEY, what TEXT)',
  ];
  // An fts5 table whose tokenizer the app registers itself, so it fails to load here.
  const fts5Custom = [
    "CREATE VIRTUAL TABLE notes USING fts5(title, body, tokenize='custom')",
    "CREATE TABLE 'notes_data'(id INTEGER PRIMARY KEY, block BLOB)",
    "CREATE TABLE 'notes_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
    "CREATE TABLE 'notes_content'(id INTEGER PRIMARY KEY, c0, c1)",
    "CREATE TABLE 'notes_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
    "CREATE TABLE 'notes_config'(k PRIMARY KEY, v) WITHOUT ROWID",
  ];
  const hidden = [{ table: 'notes', column: 'body' }];

  it('hides the shadow tables of an fts4 table with a hidden column', () => {
    for (const sql of [
      'SELECT c1body FROM notes_content',
      'SELECT c0title FROM notes_content',
      'SELECT count(*) FROM notes_content',
      'SELECT block FROM notes_segments',
    ]) {
      expect(read(fts4, sql, hidden), sql).toMatchObject({ ok: false, code: 'hidden-column' });
    }
    expect(read(fts4, 'SELECT what FROM audit', hidden)).toMatchObject({ ok: true });
  });

  it('hides the shadow tables of an fts5 table with a custom tokenizer', () => {
    for (const sql of ['SELECT c1 FROM notes_content', 'SELECT * FROM notes_data']) {
      expect(read(fts5Custom, sql, hidden), sql).toMatchObject({
        ok: false,
        code: 'hidden-column',
      });
    }
  });

  it('refuses edits of those shadow tables', () => {
    for (const [schema, sql] of [
      [fts4, 'DELETE FROM notes_content'],
      [fts4, 'UPDATE notes_segments SET block = NULL'],
      [fts5Custom, 'DELETE FROM notes_data'],
    ] as const) {
      expect(engine.check(sql, { schemaSql: schema, mode: 'write' }), sql).toMatchObject({
        ok: false,
        code: 'not-an-edit',
      });
    }
    expect(
      engine.check("INSERT INTO audit(what) VALUES ('x')", { schemaSql: fts4, mode: 'write' }),
    ).toMatchObject({ ok: true });
  });
});

describe('S2: stand-ins for modules the gate never runs', () => {
  const schema = [
    'CREATE VIRTUAL TABLE notes USING fts5(title, body)',
    'CREATE VIRTUAL TABLE vocab USING fts5vocab(notes, row)',
    'CREATE VIRTUAL TABLE other USING whatever(a, b)',
  ];

  it.each([
    'SELECT * FROM vocab',
    'SELECT notes FROM vocab',
    'SELECT count(*) FROM vocab',
    'SELECT 1 FROM vocab',
    'SELECT * FROM other',
    'SELECT a FROM other',
    'SELECT count(*) FROM other',
  ])('refuses %s, with or without hidden columns', (sql) => {
    expect(read(schema, sql)).toMatchObject({ ok: false, code: 'table' });
    expect(read(schema, sql, [{ table: 'notes', column: 'body' }])).toMatchObject({ ok: false });
  });

  it('still reads the allowlisted fts5 table itself', () => {
    expect(read(schema, 'SELECT title FROM notes')).toMatchObject({ ok: true });
  });
});
