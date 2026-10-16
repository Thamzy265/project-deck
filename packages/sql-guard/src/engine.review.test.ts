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
