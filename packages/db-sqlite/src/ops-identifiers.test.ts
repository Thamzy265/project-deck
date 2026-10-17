/**
 * Tester probes for the snapshot engine's identifier handling: table and column names
 * come from the copied file (untrusted app data) and from the diff's keys, and are put
 * into SQL text by the engine itself, so they must always be quoted, never trusted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenDb } from './ops.js';
import { closeImage, hashes, openImage, query, rowsByKey, schema } from './ops.js';
import { loadSqlite } from './sqlite.js';

let open: OpenDb | undefined;

afterEach(() => {
  if (open !== undefined) closeImage(open);
  open = undefined;
});

async function build(sql: string): Promise<OpenDb> {
  const sqlite = await loadSqlite();
  const db = new sqlite.oo1.DB();
  let bytes: Uint8Array;
  try {
    db.exec(sql);
    bytes = sqlite.capi.sqlite3_js_db_export(db.pointer ?? 0);
  } finally {
    db.close();
  }
  open = openImage(sqlite, bytes);
  return open;
}

const WEIRD = `we"ird; DROP TABLE t; -- ✓ ñ`;
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

describe('snapshot identifiers (tester probes)', () => {
  it('hashes and reads back a table whose name holds quotes, SQL and unicode', async () => {
    const db = await build(
      `CREATE TABLE t(id INTEGER PRIMARY KEY); CREATE TABLE ${q(WEIRD)}(${q('k"ey')} INTEGER PRIMARY KEY, ${q('v a"l')} TEXT); INSERT INTO ${q(WEIRD)} VALUES (1, 'one');`,
    );
    const snap = hashes(db);
    const weird = snap.tables.find((t) => t.name === WEIRD);
    expect(weird).toMatchObject({ key: ['k"ey'], columns: ['k"ey', 'v a"l'] });
    expect(rowsByKey(db, WEIRD, [1]).rows).toEqual([[1, [1, 'one']]]);
    // Table t is still there: nothing in the name ran.
    expect(query(db, 'SELECT count(*) FROM t', [], 1).rows).toEqual([[0]]);
    expect(schema(db).tables.map((t) => t.name)).toEqual(['t', WEIRD]);
  });

  it('answers not-found for table names that look like SQL, a NUL or another case of unicode', async () => {
    const db = await build(
      `CREATE TABLE orders(id INTEGER PRIMARY KEY, v); CREATE TABLE ${q('Ünïcode')}(id INTEGER PRIMARY KEY);`,
    );
    for (const name of [
      'orders" WHERE 1; --',
      'orders"',
      'orders\u0000',
      'main.orders',
      'sqlite_schema',
      'ünïcode',
      '',
    ]) {
      expect(() => rowsByKey(db, name, [1]), JSON.stringify(name)).toThrow(
        expect.objectContaining({ code: 'not-found' }),
      );
    }
    expect(rowsByKey(db, 'ÜnÏcode'.replace('Ï', 'ï'), [1]).missing).toEqual([1]);
  });

  it('refuses keys of the wrong shape or type without crashing', async () => {
    const db = await build(
      "CREATE TABLE p(a INTEGER NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)); INSERT INTO p VALUES (1, 'x');",
    );
    expect(rowsByKey(db, 'p', [[1, 'x']]).rows).toHaveLength(1);
    for (const key of [1, [1], [1, 'x', 2]]) {
      expect(() => rowsByKey(db, 'p', [key]), JSON.stringify(key)).toThrow(
        expect.objectContaining({ code: 'refused' }),
      );
    }
    const outOfRange = rowsByKey(db, 'p', [[{ type: 'int', value: '99999999999999999999' }, 'x']]);
    expect(outOfRange.rows).toEqual([]);
  });

  it('never reads sqlite_ tables or views into a diff snapshot', async () => {
    const db = await build(
      'CREATE TABLE a(id INTEGER PRIMARY KEY AUTOINCREMENT, v); INSERT INTO a(v) VALUES (1); CREATE VIEW va AS SELECT * FROM a; ANALYZE;',
    );
    expect(hashes(db).tables.map((t) => t.name)).toEqual(['a']);
  });
});
