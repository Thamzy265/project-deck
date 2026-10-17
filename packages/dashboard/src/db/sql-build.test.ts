import { describe, expect, it } from 'vitest';
import {
  countQuery,
  deleteRow,
  escapeLike,
  inputParam,
  insertRow,
  pageQuery,
  quoteIdent,
  updateRow,
} from './sql-build.js';

describe('quoteIdent', () => {
  it('quotes any name, doubling quotes inside it', () => {
    expect(quoteIdent('orders')).toBe('"orders"');
    expect(quoteIdent('we"ird; DROP TABLE x')).toBe('"we""ird; DROP TABLE x"');
    expect(quoteIdent('')).toBe('""');
  });
});

describe('escapeLike', () => {
  it('escapes the LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('pageQuery', () => {
  const base = { table: 'orders', columns: ['id', 'item'], key: ['id'], offset: 0, limit: 100 };

  it('reads one page in key order, with the limit and offset as parameters', () => {
    expect(pageQuery(base)).toEqual({
      sql: 'SELECT * FROM "orders" ORDER BY "id" LIMIT ? OFFSET ?',
      params: [100, 0],
    });
  });

  it('sorts by a column, then by the key so pages never overlap', () => {
    expect(pageQuery({ ...base, sort: { column: 'item', dir: 'desc' }, offset: 200 })).toEqual({
      sql: 'SELECT * FROM "orders" ORDER BY "item" DESC, "id" LIMIT ? OFFSET ?',
      params: [100, 200],
    });
  });

  it('filters every column as text, with the user text only in a parameter', () => {
    expect(pageQuery({ ...base, filter: "50%'; DROP" })).toEqual({
      sql: 'SELECT * FROM "orders" WHERE (CAST("id" AS TEXT) LIKE ? ESCAPE \'\\\' OR CAST("item" AS TEXT) LIKE ? ESCAPE \'\\\') ORDER BY "id" LIMIT ? OFFSET ?',
      params: ["%50\\%'; DROP%", "%50\\%'; DROP%", 100, 0],
    });
  });

  it('narrows to one value of one column (foreign-key navigation)', () => {
    expect(pageQuery({ ...base, match: { column: 'id', value: 3 } })).toEqual({
      sql: 'SELECT * FROM "orders" WHERE "id" IS ? ORDER BY "id" LIMIT ? OFFSET ?',
      params: [3, 100, 0],
    });
  });

  it('leaves the order to SQLite for views without a key', () => {
    expect(pageQuery({ ...base, key: [] })).toEqual({
      sql: 'SELECT * FROM "orders" LIMIT ? OFFSET ?',
      params: [100, 0],
    });
  });
});

describe('countQuery', () => {
  it('counts the rows the same filter selects', () => {
    expect(countQuery({ table: 'a"b', columns: ['x'], filter: 'q' })).toEqual({
      sql: 'SELECT count(*) FROM "a""b" WHERE (CAST("x" AS TEXT) LIKE ? ESCAPE \'\\\')',
      params: ['%q%'],
    });
    expect(countQuery({ table: 't', columns: ['x'] })).toEqual({
      sql: 'SELECT count(*) FROM "t"',
      params: [],
    });
  });
});

describe('edits', () => {
  const key = { columns: ['id'], values: [3] };

  it('updates the changed columns of one row by its key', () => {
    expect(
      updateRow('orders', key, [
        { column: 'status', value: 'shipped' },
        { column: 'note', value: null },
      ]),
    ).toEqual({
      sql: 'UPDATE "orders" SET "status" = ?, "note" = ? WHERE "id" IS ?',
      params: ['shipped', null, 3],
    });
  });

  it('matches every column of a composite key', () => {
    expect(deleteRow('t', { columns: ['a', 'b'], values: ['x', 2] })).toEqual({
      sql: 'DELETE FROM "t" WHERE "a" IS ? AND "b" IS ?',
      params: ['x', 2],
    });
  });

  it('adds a row with the given columns, or all defaults', () => {
    expect(insertRow('orders', [{ column: 'item', value: 'Cake' }])).toEqual({
      sql: 'INSERT INTO "orders" ("item") VALUES (?)',
      params: ['Cake'],
    });
    expect(insertRow('orders', [])).toEqual({
      sql: 'INSERT INTO "orders" DEFAULT VALUES',
      params: [],
    });
  });

  it('puts hostile values and names only where they cannot become SQL', () => {
    const edit = updateRow('o"; --', { columns: ['i"d'], values: ["1' OR 1=1"] }, [
      { column: 'x"', value: "'); DROP TABLE orders; --" },
    ]);
    expect(edit.sql).toBe('UPDATE "o""; --" SET "x""" = ? WHERE "i""d" IS ?');
    expect(edit.params).toEqual(["'); DROP TABLE orders; --", "1' OR 1=1"]);
  });
});

describe('inputParam', () => {
  it('reads numbers for numeric columns and keeps text as typed', () => {
    expect(inputParam('42', 'INTEGER')).toBe(42);
    expect(inputParam('4.5', 'REAL')).toBe(4.5);
    expect(inputParam(' 42', 'INTEGER')).toBe(' 42');
    expect(inputParam('42', 'TEXT')).toBe('42');
    expect(inputParam('abc', 'INTEGER')).toBe('abc');
    expect(inputParam('9007199254740993', 'INTEGER')).toBe('9007199254740993');
    expect(inputParam('', 'INTEGER')).toBe('');
    expect(inputParam('1e3', 'NUMERIC')).toBe(1000);
  });
});
