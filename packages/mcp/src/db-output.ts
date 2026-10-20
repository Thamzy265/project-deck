/**
 * Database answers for Claude (design note D2, D6). Cells are made safe to show (a blob
 * is only its size), then the whole answer is masked, then cut to 20 kB with a note that
 * says what was left out. Masking runs before the cut, as for get_logs.
 */
import type { Cell, DbDiff, DbList, RowKey, TableDiff, TableInfo } from '@project-deck/core';
import type { JsonValue } from './mask/masker.js';
import { MAX_OUTPUT_BYTES, shorten } from './output.js';

type Json = { [key: string]: JsonValue };

/**
 * Marks an integer cell so the masker sees it as text: a phone number stored as a number
 * is masked like one in text (design review S8). No row value can make this object,
 * because every cell becomes a string, a number or null.
 */
const NUMBER = '\u0000number';

const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= MAX_OUTPUT_BYTES;

export function cellForClaude(cell: Cell): JsonValue {
  if (cell === null || typeof cell === 'string') return cell;
  if (typeof cell === 'number') return Number.isInteger(cell) ? { [NUMBER]: String(cell) } : cell;
  switch (cell.type) {
    case 'int':
      return { [NUMBER]: cell.value };
    case 'real':
      return cell.value;
    case 'blob':
      // Never the bytes: they can hold anything, and Claude can't read them anyway.
      return `[BLOB ${cell.bytes} bytes]`;
  }
}

export function cellsForClaude(cells: readonly Cell[]): JsonValue[] {
  return cells.map(cellForClaude);
}

function keyForClaude(key: RowKey): JsonValue {
  return Array.isArray(key) ? cellsForClaude(key) : cellForClaude(key);
}

/**
 * After masking: a marked integer that masking left alone is a number again (text when
 * past 2^53, so no digit is lost); one masking changed stays the masked text.
 */
export function restoreNumbers<T extends JsonValue>(value: T): T {
  return restore(value) as T;
}

function restore(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(restore);
  if (typeof value !== 'object' || value === null) return value;
  if (NUMBER in value) {
    const text = value[NUMBER];
    if (typeof text !== 'string') return null;
    if (!/^-?\d+$/.test(text)) return text;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = restore(v);
  return out;
}

/** Largest n in [0, max] for which `build(n)` fits, or -1 when not even 0 does. */
function largestFitting(max: number, build: (n: number) => unknown): number {
  if (!fits(build(0))) return -1;
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Cuts every long text shorter and shorter until it fits; the last resort. */
function shortenToFit(value: Json, problem: string): Json {
  for (const max of [2048, 1024, 512, 256, 128, 64, 32]) {
    const cut = shorten(value, max) as Json;
    if (fits(cut)) return cut;
  }
  return { truncated: true, problem };
}

// ---- db_query ----

export function fitQuery(
  frame: Json,
  columns: JsonValue[],
  rows: JsonValue[][],
  moreRows: boolean,
): Json {
  const build = (shownColumns: number, n: number, truncated: boolean): Json => {
    const leftOut = columns.length - shownColumns;
    const cut = (row: JsonValue[]) => (leftOut > 0 ? row.slice(0, shownColumns) : row);
    return {
      ...frame,
      columns: cut(columns),
      rows: rows.slice(0, n).map(cut),
      rowCount: n,
      ...(leftOut > 0 ? { columnsLeftOut: leftOut } : {}),
      truncated,
      ...(truncated ? { hint: queryHint(n, leftOut) } : {}),
    };
  };
  const all = columns.length;
  if (!moreRows && fits(build(all, rows.length, false))) return build(all, rows.length, false);
  // A wide result may not fit even with no rows (MCP-1): show the first columns, with
  // room for one row when there is one, and count the others.
  const firstRows = Math.min(rows.length, 1);
  let shown = all;
  if (!fits(build(all, firstRows, true))) {
    shown = largestFitting(all, (k) => build(k, firstRows, true));
    if (shown < 0) shown = largestFitting(all, (k) => build(k, 0, true));
    if (shown < 0) return shortenToFit(build(0, 0, true), 'The result was too large to show.');
  }
  const n = largestFitting(rows.length, (k) => build(shown, k, true));
  if (n > 0 || rows.length === 0) return build(shown, Math.max(n, 0), true);
  // Not even one row fits: show the first one with its texts cut.
  return shortenToFit(build(shown, 1, true), 'The first row was too large to show.');
}

function queryHint(shown: number, columnsLeftOut: number): string {
  const columns =
    columnsLeftOut > 0
      ? ` ${columnsLeftOut} column${columnsLeftOut === 1 ? ' was' : 's were'} left out too (columnsLeftOut): select fewer columns.`
      : '';
  return `Showing the first ${shown} row${shown === 1 ? '' : 's'}; more rows matched or the answer was cut to 20 kB.${columns} For counts or totals use count(*), sum() or GROUP BY; otherwise narrow with WHERE, fewer columns or a smaller limit.`;
}

// ---- db_schema ----

/** The tables without CREATE text: names, types, keys, defaults, counts and indexes. */
export function schemaForClaude(tables: readonly TableInfo[]): Json[] {
  return tables.map((t) => ({
    name: t.name,
    kind: t.kind,
    ...(t.rowCount === undefined ? {} : { rowCount: t.rowCount }),
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.pk ? { pk: true } : {}),
      ...(c.nullable ? {} : { notNull: true }),
      ...(c.default === null ? {} : { default: c.default }),
    })),
    ...(t.foreignKeys.length === 0
      ? {}
      : { foreignKeys: t.foreignKeys.map((f) => ({ from: f.from, table: f.table, to: f.to })) }),
    ...(t.indexes.length === 0
      ? {}
      : {
          indexes: t.indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })),
        }),
    ...(t.error === undefined ? {} : { error: { code: t.error.code, message: t.error.message } }),
  }));
}

/** Names of tables left out, at most this many. */
const MAX_LEFT_OUT_NAMES = 200;

export function fitSchema(frame: Json, tables: Json[]): Json {
  const build = (n: number): Json => {
    const rest = tables.slice(n);
    if (rest.length === 0) return { ...frame, tables, truncated: false };
    return {
      ...frame,
      tables: tables.slice(0, n),
      truncated: true,
      tablesLeftOut: rest.length,
      leftOutNames: rest.slice(0, MAX_LEFT_OUT_NAMES).map((t) => t.name ?? null),
      hint: `${rest.length} table${rest.length === 1 ? ' was' : 's were'} left out to keep this answer under 20 kB. Read one table's columns with db_query: PRAGMA table_info("<table>").`,
    };
  };
  if (fits(build(tables.length))) return build(tables.length);
  const n = largestFitting(tables.length, build);
  if (n >= 0) return build(n);
  return shortenToFit(build(0), 'The schema was too large to show.');
}

// ---- db_diff ----

export function diffForClaude(diff: DbDiff): Json {
  return {
    db: diff.db,
    snapshotId: diff.snapshotId,
    snapshotTakenAt: diff.takenAt,
    tables: diff.tables.map(tableDiffForClaude),
    truncated: diff.truncated,
    tablesLeftOut: diff.tablesOmitted,
  };
}

function tableDiffForClaude(t: TableDiff): Json {
  const row = (r: readonly Cell[] | null) => (r === null ? null : cellsForClaude(r));
  return {
    table: t.table,
    columns: t.columns,
    key: t.key,
    ...(t.matchedByRowid ? { matchedByRowid: true } : {}),
    counts: { ...t.counts },
    added: t.added.map((a) => ({ key: keyForClaude(a.key), row: row(a.row) })),
    changed: t.changed.map((c) => ({
      key: keyForClaude(c.key),
      columns: c.columns,
      row: row(c.row),
    })),
    removed: t.removed.map((r) => ({ key: keyForClaude(r.key) })),
    ...(t.truncated ? { truncated: true } : {}),
    ...(t.tooLarge === true ? { tooLarge: true } : {}),
    ...(t.error === undefined ? {} : { error: { code: t.error.code, message: t.error.message } }),
  };
}

const LISTS = ['added', 'changed', 'removed'] as const;

const listOf = (t: Json, name: (typeof LISTS)[number]): JsonValue[] => {
  const list = t[name];
  return Array.isArray(list) ? list : [];
};

/** `diff` is a masked `diffForClaude` answer. Counts stay the real totals. */
export function fitDiff(frame: Json, diff: Json): Json {
  const tables = Array.isArray(diff.tables) ? (diff.tables as Json[]) : [];
  const leftOutBefore = typeof diff.tablesLeftOut === 'number' ? diff.tablesLeftOut : 0;
  const longest = Math.max(0, ...tables.flatMap((t) => LISTS.map((l) => listOf(t, l).length)));
  const build = (perList: number, shown: number): Json => {
    let cut = diff.truncated === true || shown < tables.length;
    const kept = tables.slice(0, shown).map((t) => {
      const out: Json = { ...t };
      let tableCut = t.truncated === true;
      for (const l of LISTS) {
        const list = listOf(t, l);
        if (list.length > perList) tableCut = true;
        out[l] = list.slice(0, perList);
      }
      if (tableCut) {
        out.truncated = true;
        cut = true;
      }
      return out;
    });
    const leftOut = leftOutBefore + tables.length - shown;
    return {
      ...frame,
      db: diff.db ?? null,
      snapshotId: diff.snapshotId ?? null,
      snapshotTakenAt: diff.snapshotTakenAt ?? null,
      tables: kept,
      truncated: cut || leftOut > 0,
      ...(leftOut > 0 ? { tablesLeftOut: leftOut } : {}),
      ...(cut || leftOut > 0 ? { hint: DIFF_HINT } : {}),
    };
  };
  const whole = build(longest, tables.length);
  if (fits(whole)) return whole;
  const perList = largestFitting(longest, (k) => build(k, tables.length));
  if (perList >= 0) return build(perList, tables.length);
  const shown = largestFitting(tables.length, (n) => build(0, n));
  if (shown >= 0) return build(0, shown);
  return shortenToFit(build(0, 0), 'The diff was too large to show.');
}

const DIFF_HINT =
  'Some rows or tables were left out to keep this answer small; counts are the real totals. Read the rows you need with db_query, for example by key.';

// ---- db_list ----

/** What Claude is told to do about a backend's problem. */
export function problemHint(code: string): string | undefined {
  switch (code) {
    case 'choose-device':
      return 'More than one device or simulator has this app. Ask the user to pick one in the FlutterDeck dashboard (Database tab), then try again. Claude cannot pick it.';
    case 'unsupported':
      return "This app or platform has no database inspection (for example a Linux or Windows desktop app). Don't retry.";
    case 'busy':
      return 'The app is writing to its database. Try again in a moment.';
    case 'timeout':
      return 'It took too long and was stopped. Narrow the query (WHERE, LIMIT, fewer columns) or try again.';
    case 'setup-needed':
      return 'The app needs the flutterdeck_drift package for live reads; the dashboard Database tab shows the setup.';
    case 'update-needed':
      return 'Update the flutterdeck_drift package in the app.';
    case 'not-debuggable':
      return 'Android lets FlutterDeck copy files only from a debug build of the app.';
    case 'app-gone':
      return 'No app is attached. Ask the user to start the app from their IDE or flutter run; call deck_status to check.';
    case 'not-found':
      return 'Call db_list for the database names and db_schema for the tables.';
    case 'refused':
      return "Only one reading statement runs here (SELECT, WITH … SELECT, EXPLAIN, or PRAGMA table_info / table_xinfo / index_list / foreign_key_list). Claude can't change data: if data must change, tell the user, who can edit rows in the dashboard's Database tab.";
    default:
      return undefined;
  }
}

export function listForClaude(list: DbList): Json {
  return {
    databases: list.databases.map((d) => ({
      name: d.name,
      backend: d.backend,
      source: d.source,
      ...(d.takenAt === undefined ? {} : { snapshotTakenAt: d.takenAt }),
    })),
    problems: list.sources.flatMap((s) => {
      if (s.error === undefined) return [];
      const hint = problemHint(s.error.code);
      return [
        {
          source: s.id,
          code: s.error.code,
          message: s.error.message,
          ...(hint === undefined ? {} : { hint }),
        },
      ];
    }),
  };
}
