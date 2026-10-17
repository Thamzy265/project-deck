import { describe, expect, it } from 'vitest';
import { editErrorText, queryErrorText } from './copy.js';

describe('queryErrorText (UI spec, Copy)', () => {
  const refused = (detail: string, error = 'gate text') => ({ code: 'refused', detail, error });

  it('says why a write was refused in the spec words', () => {
    const cases: [string, string, string][] = [
      ['DELETE FROM orders', 'writes-data', 'it deletes rows'],
      ['delete from orders', 'writes-data', 'it deletes rows'],
      ["INSERT INTO orders VALUES (1, 'a')", 'writes-data', 'it adds rows'],
      ['UPDATE orders SET a = 1', 'writes-data', 'it changes rows'],
      ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'writes-data', 'it changes data'],
      ["ATTACH 'x.db' AS x", 'attach', 'it adds a database'],
      ['PRAGMA user_version = 3', 'pragma', 'it changes a setting'],
      ['SELECT 1; DROP TABLE t', 'multiple-statements', 'it has more than one statement'],
      ['BEGIN', 'transaction', 'it starts or ends a transaction'],
      ['VACUUM', 'vacuum', 'it rewrites the database'],
      ['DROP TABLE orders', 'writes-data', 'it changes the schema'],
    ];
    for (const [sql, detail, reason] of cases) {
      expect(queryErrorText(refused(detail), sql), sql).toEqual({
        text: `Only reading queries run here. This one would change data (${reason}).`,
      });
    }
  });

  it("shows the gate's own reason for other refusals", () => {
    expect(
      queryErrorText(refused('function', 'The function load_extension is never allowed.'), 'x'),
    ).toEqual({
      text: 'Only reading queries run here: The function load_extension is never allowed.',
    });
  });

  it("shows SQLite's message and the line it points at", () => {
    const sql = 'SELECT *\nFROM orders\nWHER id = 1';
    expect(
      queryErrorText(
        {
          code: 'refused',
          detail: 'invalid-sql',
          error: 'SQLite could not prepare the statement: near "id": syntax error.',
        },
        sql,
      ),
    ).toEqual({
      text: 'SQLite could not prepare the statement: near "id": syntax error.',
      line: 3,
    });
    expect(queryErrorText({ code: 'sql-error', error: 'no such column: x' }, 'SELECT x')).toEqual({
      text: 'no such column: x',
    });
  });

  it('passes other errors through', () => {
    expect(queryErrorText({ code: 'timeout', error: 'That query took too long.' }, 'x')).toEqual({
      text: 'That query took too long.',
    });
  });
});

describe('editErrorText (UI spec, write confirm)', () => {
  it('explains that a trigger counts as a second table (QA G2)', () => {
    expect(
      editErrorText({
        code: 'refused',
        detail: 'multiple-tables',
        error:
          'An edit may change one table only; this one also changes customers, audit_log (for example through a trigger).',
      }),
    ).toBe(
      "This table can't be changed here: changing it also changes customers, audit_log. A trigger counts as a second table, and an edit may change one table only.",
    );
  });

  it('names a confirm answered elsewhere, an app restart, a timeout and lost connection', () => {
    expect(
      editErrorText({
        code: 'bad-token',
        error: 'Not run: this change was already answered or cancelled.',
      }),
    ).toBe('Answered in another tab');
    expect(
      editErrorText({ code: 'bad-token', error: 'Not run: the app restarted since you asked.' }),
    ).toBe('Not run: the app restarted since you asked.');
    expect(editErrorText({ code: 'timeout', error: 'Not run: no answer in 60 s.' })).toBe(
      'Not run: no answer in 60 s',
    );
    expect(editErrorText({ code: 'network', error: 'Failed to fetch' })).toBe(
      'Lost connection; the change did not run',
    );
  });

  it("shows SQLite's message for a failed save", () => {
    expect(
      editErrorText({ code: 'sql-error', error: 'NOT NULL constraint failed: orders.item' }),
    ).toBe("Couldn't save: NOT NULL constraint failed: orders.item");
  });
});
