/**
 * Error copy of the Database tab (UI spec, "Copy"). The daemon's answers carry a code,
 * and for refusals the gate's own code as `detail`; these pick the words.
 */

export interface ErrorInfo {
  code: string;
  error: string;
  detail?: string | undefined;
}

const WRITE_VERB: [RegExp, string][] = [
  [/^DELETE\b/i, 'it deletes rows'],
  [/^(INSERT|REPLACE)\b/i, 'it adds rows'],
  [/^UPDATE\b/i, 'it changes rows'],
  [/^(CREATE|DROP|ALTER)\b/i, 'it changes the schema'],
];

const REASON: Record<string, string> = {
  attach: 'it adds a database',
  pragma: 'it changes a setting',
  'multiple-statements': 'it has more than one statement',
  transaction: 'it starts or ends a transaction',
  vacuum: 'it rewrites the database',
};

function writeReason(detail: string, sql: string): string | undefined {
  const reason = REASON[detail];
  if (reason !== undefined) return reason;
  if (detail !== 'writes-data' && detail !== 'not-an-edit') return undefined;
  const start = sql.trimStart();
  return WRITE_VERB.find(([re]) => re.test(start))?.[1] ?? 'it changes data';
}

/** SQLite names the token it stopped at; find the line it is on. */
function lineOf(message: string, sql: string): number | undefined {
  const near = /near "((?:[^"]|"")*)"/.exec(message)?.[1]?.replaceAll('""', '"');
  if (near === undefined || near === '') return undefined;
  const at = sql.indexOf(near);
  if (at === -1) return undefined;
  return sql.slice(0, at).split('\n').length;
}

/** What the SQL editor says when a query didn't run. */
export function queryErrorText(err: ErrorInfo, sql: string): { text: string; line?: number } {
  if (err.code === 'refused' && err.detail !== undefined) {
    if (err.detail === 'invalid-sql') {
      const line = lineOf(err.error, sql);
      return line === undefined ? { text: err.error } : { text: err.error, line };
    }
    const reason = writeReason(err.detail, sql);
    if (reason !== undefined) {
      return { text: `Only reading queries run here. This one would change data (${reason}).` };
    }
    return { text: `Only reading queries run here: ${err.error}` };
  }
  if (err.code === 'sql-error') {
    const line = lineOf(err.error, sql);
    return line === undefined ? { text: err.error } : { text: err.error, line };
  }
  return { text: err.error };
}

/** What the edit confirm dialog says when a change didn't run. */
export function editErrorText(err: ErrorInfo): string {
  if (err.code === 'network') return 'Lost connection; the change did not run';
  if (err.code === 'refused' && err.detail === 'multiple-tables') {
    const tables = /also changes (.+?) \(/.exec(err.error)?.[1];
    const which = tables === undefined ? '' : `: changing it also changes ${tables}`;
    return `This table can't be changed here${which}. A trigger counts as a second table, and an edit may change one table only.`;
  }
  if (err.code === 'bad-token' && /already answered or cancelled/.test(err.error)) {
    return 'Answered in another tab';
  }
  if (err.code === 'timeout') return 'Not run: no answer in 60 s';
  if (err.code === 'sql-error') return `Couldn't save: ${err.error}`;
  return err.error;
}

/** An edit or delete from row details that matched no row: it changed meanwhile (L3). */
export const ROW_CHANGED_TEXT = 'This row changed since you opened it. Reload it and try again.';
