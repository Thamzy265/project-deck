import type { Cell, TableInfo } from '@project-deck/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbApiError } from '../../api/db-client.js';
import { asDbApiError } from '../../api/db-client.js';
import type { Param } from '../../db/cells.js';
import { paramLabel, visibleText } from '../../db/cells.js';
import { changedRows, keyColumns, rowIdentity, rowKeyOrReason } from '../../db/keys.js';
import { seenNewRows, withNewRows } from '../../db/new-rows.js';
import type { PageSpec } from '../../db/sql-build.js';
import { countQuery, keysetQuery, pageQuery } from '../../db/sql-build.js';
import { useDebounced } from '../../search/useDebounced.js';
import { useDbClient } from '../../state/DbProvider.js';
import { Skeleton } from '../Skeleton.js';
import { button, field, linkButton } from '../styles.js';
import { PANE_QUERY, WIDE_QUERY, useMedia } from '../useMedia.js';
import type { GridColumn, SortDir } from './DataGrid.js';
import { DataGrid } from './DataGrid.js';
import { ExportMenu } from './ExportMenu.js';
import { RowDetails } from './RowDetails.js';
import type { WriteMode } from './RowDetails.js';
import { VisibleText } from './VisibleText.js';

/** UI spec: 100 rows per page. */
export const PAGE_SIZE = 100;
const FILTER_DEBOUNCE_MS = 200;
/** A flash lasts 1.5 s, or a 2 s outline with reduced motion (UI spec, grid). */
const FLASH_MS = 2000;

export interface Match {
  column: string;
  value: Param;
}

export interface TableViewProps {
  db: string;
  table: TableInfo;
  /** Bumped when this table changed in the app (live refresh). */
  tick: number;
  connected: boolean;
  writes: WriteMode;
  match?: Match | undefined;
  onClearMatch: () => void;
  onFollowKey: (table: string, column: string, value: Param) => void;
  onToast: (text: string) => void;
  announce: (text: string) => void;
}

interface Page {
  columns: string[];
  rows: Cell[][];
}

type Load =
  | { status: 'loading'; last?: Page }
  | { status: 'ready'; page: Page }
  | { status: 'error'; error: DbApiError; last?: Page };

function nextSort(
  sort: { column: string; dir: SortDir } | undefined,
  column: string,
): { column: string; dir: SortDir } | undefined {
  if (sort?.column !== column) return { column, dir: 'asc' };
  return sort.dir === 'asc' ? { column, dir: 'desc' } : undefined;
}

export function TableView(p: TableViewProps) {
  const client = useDbClient();
  const { db, table } = p;
  // The schema is read again after every change (row counts): new objects with the same
  // content must not read the rows again or end a flash (review R4).
  const columnsSig = JSON.stringify(
    table.columns.map((c) => [c.name, c.type, c.pk, c.pkPosition ?? 0]),
  );
  const fkSig = JSON.stringify(table.foreignKeys);
  const tableRef = useRef(table);
  tableRef.current = table;
  const names = useMemo(() => tableRef.current.columns.map((c) => c.name), [columnsSig]);
  /** Tells rows apart: the primary key, or all cells without one (review R3). */
  const identityKey = useMemo(() => keyColumns(tableRef.current), [columnsSig]);
  const key = useMemo(() => {
    if (identityKey.length > 0) return identityKey;
    return table.kind === 'table' ? ['rowid'] : [];
  }, [identityKey, table.kind]);
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      tableRef.current.columns.map((c) => {
        const fk = tableRef.current.foreignKeys.find((f) => f.from === c.name);
        return {
          name: c.name,
          type: c.type,
          pk: c.pk,
          ...(fk === undefined ? {} : { fk: fk.table }),
        };
      }),
    [columnsSig, fkSig],
  );

  const [filter, setFilter] = useState('');
  const typed = useDebounced(filter, FILTER_DEBOUNCE_MS);
  const [sort, setSort] = useState<{ column: string; dir: SortDir } | undefined>();
  const [pageIndex, setPageIndex] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [countedTotal, setTotal] = useState<number | undefined>();
  /** Rows that flash, by identity, so a re-read that moves them keeps the flash. */
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const range = useRef<[number, number]>([0, -1]);
  /** New or changed rows out of view, by identity, for the chip (lead decision B4-6). */
  const [newRows, setNewRows] = useState<ReadonlySet<string>>(new Set());
  const [scrollTo, setScrollTo] = useState<{ index: number; seq: number }>();
  /** The open row: its identity, so a live re-read that moves rows keeps it, and its
   *  last cells, shown if the row has gone from this page. */
  const [details, setDetails] = useState<{ id: string; row: Cell[] } | undefined>();
  const [adding, setAdding] = useState(false);
  const [retry, setRetry] = useState(0);
  const narrow = !useMedia(PANE_QUERY, true);
  const lastPage = useRef<Page | undefined>(undefined);
  const lastTick = useRef(p.tick);
  const lastCountTick = useRef(p.tick);
  const lastTotal = useRef<number | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);

  const spec: PageSpec = useMemo(
    () => ({
      table: table.name,
      columns: names,
      filter: typed,
      ...(p.match === undefined ? {} : { match: p.match }),
      key,
      ...(sort === undefined ? {} : { sort }),
      offset: pageIndex * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [table.name, names, typed, p.match, key, sort, pageIndex],
  );

  // New filter, sort or match: back to the first page.
  useEffect(() => setPageIndex(0), [typed, sort, p.match]);

  const { tick, announce } = p;

  // The count follows the filter, the match and changes only, not paging or sorting.
  useEffect(() => {
    let cancelled = false;
    const live = tick !== lastCountTick.current;
    lastCountTick.current = tick;
    const count = countQuery({
      table: table.name,
      columns: names,
      filter: typed,
      ...(p.match === undefined ? {} : { match: p.match }),
    });
    client.query({ db, sql: count.sql, params: count.params, limit: 1 }).then(
      (counted) => {
        if (cancelled) return;
        const cell = counted.rows[0]?.[0];
        const next = typeof cell === 'number' ? cell : 0;
        const before = lastTotal.current;
        lastTotal.current = next;
        setTotal(next);
        const added = before === undefined ? 0 : next - before;
        if (live && added > 0) {
          announce(`${added} ${added === 1 ? 'row' : 'rows'} added to ${visibleText(table.name)}`);
        }
      },
      () => {
        // The rows' read says what went wrong.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, db, table.name, names, typed, p.match, tick, retry, announce]);

  useEffect(() => {
    let cancelled = false;
    const live = tick !== lastTick.current;
    lastTick.current = tick;
    const prev = lastPage.current;
    setLoad((old) => {
      const last = old.status === 'ready' ? old.page : old.last;
      return last === undefined ? { status: 'loading' } : { status: 'loading', last };
    });
    const page = pageQuery(spec);
    client.query({ db, sql: page.sql, params: page.params, limit: PAGE_SIZE }).then(
      (rows) => {
        if (cancelled) return;
        const next: Page = { columns: rows.columns, rows: rows.rows };
        lastPage.current = next;
        setLoad({ status: 'ready', page: next });
        // Only a change flashes; another read (a new page, the schema read again) keeps
        // the flash the last change started, on the same rows.
        if (!live || prev === undefined) {
          setNewRows(new Set());
          return;
        }
        const changed = [...changedRows(identityKey, prev, next)].map((i) =>
          rowIdentity(identityKey, next.columns, next.rows[i] ?? []),
        );
        setFlash(new Set(changed));
        const visible = inView(next);
        setNewRows((pending) => withNewRows(pending, changed, visible));
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoad({ status: 'error', error: asDbApiError(err), ...(prev ? { last: prev } : {}) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `range` is read when the answer comes (a ref): a scroll must not re-query.
  }, [client, db, spec, tick, retry, identityKey]);

  useEffect(() => {
    if (flash.size === 0) return;
    const timer = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const page = load.status === 'ready' ? load.page : load.last;
  /** Identities of the page's rows drawn now. */
  const inView = useCallback(
    (p: Page): Set<string> => {
      const [first, last] = range.current;
      return new Set(
        p.rows.slice(first, last + 1).map((r) => rowIdentity(identityKey, p.columns, r)),
      );
    },
    [identityKey],
  );
  const onRange = useCallback(
    (first: number, last: number) => {
      range.current = [first, last];
      const shown = lastPage.current;
      // Rows the user scrolls to no longer count as new (lead decision B4-6).
      if (shown !== undefined) setNewRows((pending) => seenNewRows(pending, inView(shown)));
    },
    [inView],
  );

  const openRow = (index: number) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const row = page?.rows[index];
    if (row === undefined || page === undefined) return;
    setDetails({ id: rowIdentity(identityKey, page.columns, row), row });
  };
  const focusBack = useRef(false);
  const closeDetails = () => {
    setDetails(undefined);
    setAdding(false);
    focusBack.current = true;
  };
  const wide = useMedia(WIDE_QUERY, false);
  const covered = (details !== undefined || adding) && !wide;
  // After the panel has gone and the table is no longer inert, focus goes back.
  const open = details !== undefined || adding;
  useEffect(() => {
    if (open || !focusBack.current) return;
    focusBack.current = false;
    returnFocus.current?.focus();
  }, [open]);
  // Lead decision, 17 Oct 2026: tables, empty ones too, get rows from the toolbar.
  const canAdd = p.writes.kind === 'on' && table.kind === 'table';

  const followKey = (rowIndex: number, colIndex: number) => {
    const column = gridColumns[colIndex];
    const fk = table.foreignKeys.find((f) => f.from === column?.name);
    const value = page?.rows[rowIndex]?.[colIndex];
    if (fk === undefined || value === undefined || value === null) return;
    if (typeof value === 'object' && value.type !== 'int') return;
    const param: Param = typeof value === 'object' ? { type: 'int', value: value.value } : value;
    p.onFollowKey(fk.table, fk.to ?? '', param);
  };

  const flashRows = useMemo(() => {
    const out = new Set<number>();
    if (page === undefined || flash.size === 0) return out;
    page.rows.forEach((row, i) => {
      if (flash.has(rowIdentity(identityKey, page.columns, row))) out.add(i);
    });
    return out;
  }, [page, flash, identityKey]);
  const total = countedTotal ?? 0;
  const from = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const to = Math.min(total, (pageIndex + 1) * PAGE_SIZE);
  const filtered = typed !== '' || p.match !== undefined;
  const selected =
    details === undefined
      ? undefined
      : (page?.rows.find((r) => rowIdentity(identityKey, page.columns, r) === details.id) ??
        details.row);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Below 900 px row details cover the table: what is under it can't take focus
          (QA B4-3, WCAG 2.4.11), as in a modal. From 900 px it sits beside the rows. */}
      <div className="flex min-h-0 flex-1 flex-col" inert={covered}>
        <div className="flex flex-wrap items-center gap-2 p-2">
          <label htmlFor="db-filter" className="sr-only">
            Filter rows
          </label>
          <input
            id="db-filter"
            type="search"
            className={`${field} min-w-0 flex-1 basis-40`}
            placeholder="Filter rows…"
            maxLength={500}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label htmlFor="db-sort" className="sr-only">
            Sort by
          </label>
          <select
            id="db-sort"
            className={`${field} max-w-40`}
            value={sort === undefined ? '' : `${sort.dir}:${sort.column}`}
            onChange={(e) => {
              const v = e.target.value;
              const at = v.indexOf(':');
              const dir = v.slice(0, at);
              setSort(
                at === -1 || (dir !== 'asc' && dir !== 'desc')
                  ? undefined
                  : { dir, column: v.slice(at + 1) },
              );
            }}
          >
            <option value="">⇅ Key order</option>
            {names.map((n) => (
              <optgroup key={n} label={visibleText(n)}>
                <option value={`asc:${n}`}>{visibleText(n)} ▲</option>
                <option value={`desc:${n}`}>{visibleText(n)} ▼</option>
              </optgroup>
            ))}
          </select>
          {canAdd && (
            <button
              type="button"
              className={button}
              aria-disabled={p.connected ? undefined : true}
              onClick={() => {
                if (!p.connected) return;
                returnFocus.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setDetails(undefined);
                setAdding(true);
              }}
            >
              Add row
            </button>
          )}
        </div>
        {p.match !== undefined && (
          <p className="flex flex-wrap items-center gap-1 px-2 text-sm">
            <span>
              Showing <VisibleText text={`${table.name}.${p.match.column}`} /> ={' '}
              <VisibleText text={paramLabel(p.match.value)} />
            </span>
            <button type="button" className={linkButton} onClick={p.onClearMatch}>
              Clear filter
            </button>
          </p>
        )}
        <TableBody
          load={load}
          page={page}
          filtered={filtered}
          onClearFilter={() => {
            setFilter('');
            p.onClearMatch();
          }}
          onRetry={() => setRetry((n) => n + 1)}
        >
          {page !== undefined && page.rows.length > 0 && (
            <DataGrid
              label={`${visibleText(table.name)} rows`}
              columns={gridColumns}
              rows={page.rows}
              total={total}
              offset={pageIndex * PAGE_SIZE}
              sort={sort}
              onSort={(c) => setSort(nextSort(sort, c))}
              onOpenRow={openRow}
              onFollowKey={followKey}
              flash={flashRows}
              narrow={narrow}
              onRange={onRange}
              scrollTo={scrollTo}
            />
          )}
        </TableBody>
        {newRows.size > 0 && (
          <button
            type="button"
            className={`${button} absolute bottom-12 left-1/2 -translate-x-1/2 bg-surface`}
            onClick={() => {
              const index =
                page?.rows.findIndex((r) =>
                  newRows.has(rowIdentity(identityKey, page.columns, r)),
                ) ?? -1;
              if (index >= 0) setScrollTo({ index, seq: Date.now() });
              setNewRows(new Set());
            }}
          >
            {newRows.size} new {newRows.size === 1 ? 'row' : 'rows'}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1 text-sm">
          <span aria-live="off">
            {from.toLocaleString('en')}–{to.toLocaleString('en')} of {total.toLocaleString('en')}
          </span>
          <button
            type="button"
            className={button}
            aria-label="Previous page"
            aria-disabled={pageIndex === 0 ? true : undefined}
            onClick={() => {
              if (pageIndex > 0) setPageIndex(pageIndex - 1);
            }}
          >
            ◀
          </button>
          <button
            type="button"
            className={button}
            aria-label="Next page"
            aria-disabled={to >= total ? true : undefined}
            onClick={() => {
              if (to < total) setPageIndex(pageIndex + 1);
            }}
          >
            ▶
          </button>
          <span className="flex-1" />
          <ExportMenu
            name={table.name}
            disabled={!p.connected || total === 0}
            rows={async (onProgress) => exportTable(client, db, table, spec, onProgress)}
          />
        </div>
      </div>
      {selected !== undefined && page !== undefined && (
        <RowDetails
          db={db}
          table={table}
          columns={page.columns}
          row={selected}
          writes={p.writes}
          connected={p.connected}
          modal={covered}
          onClose={closeDetails}
          onFollowKey={(t, c, v) => {
            setDetails(undefined);
            p.onFollowKey(t, c, v);
          }}
          onToast={p.onToast}
        />
      )}
      {adding && (
        <RowDetails
          db={db}
          table={table}
          columns={names}
          row={undefined}
          writes={p.writes}
          connected={p.connected}
          modal={covered}
          onClose={closeDetails}
          onFollowKey={p.onFollowKey}
          onToast={p.onToast}
        />
      )}
    </div>
  );
}

function TableBody(p: {
  load: Load;
  page: Page | undefined;
  filtered: boolean;
  onClearFilter: () => void;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (p.load.status === 'error' && p.page === undefined) {
    return (
      <p role="alert" className="p-2">
        Couldn't read rows: {p.load.error.message}{' '}
        <button type="button" className={linkButton} onClick={p.onRetry}>
          Retry
        </button>
      </p>
    );
  }
  if (p.page === undefined) return <Skeleton label="Loading rows" />;
  if (p.page.rows.length === 0) {
    return (
      <div className="p-2">
        <p>No rows yet</p>
        {p.filtered && (
          <button type="button" className={linkButton} onClick={p.onClearFilter}>
            Clear filter
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      {p.load.status === 'error' && (
        <p role="alert" className="px-2 text-sm text-error">
          Couldn't read rows: {p.load.error.message}{' '}
          <button type="button" className={linkButton} onClick={p.onRetry}>
            Retry
          </button>
        </p>
      )}
      {p.children}
    </>
  );
}

/** Design note D6: a table export takes at most 100,000 rows, 1,000 per call. */
export const EXPORT_MAX_ROWS = 100_000;
const EXPORT_PAGE = 1000;
const EXPORT_MAX_BYTES = 50 * 1024 * 1024;

const utf8 = new TextEncoder();

/**
 * Reads the rows to export, 1,000 per call, until a short page or a cap: the row count
 * shown may be stale (review R10), so it decides nothing here. A table with a primary key is read in key
 * order after the last key read (keyset), so rows the app adds or removes meanwhile
 * can't make the export repeat or skip one; past a key that can't be compared (null or
 * a blob) it goes on by offset. The 50 MB cap counts UTF-8 bytes.
 */
async function exportTable(
  client: ReturnType<typeof useDbClient>,
  db: string,
  table: TableInfo,
  spec: PageSpec,
  onProgress: (rows: number) => void,
): Promise<{ columns: string[]; rows: Cell[][]; capped: boolean }> {
  const rows: Cell[][] = [];
  let columns: string[] = [];
  let bytes = 0;
  const key = table.kind === 'table' ? keyColumns(table) : [];
  let after: Param[] | undefined;
  let keyset = key.length > 0;
  // Tables with a key export in key order, the keyset's order, also when it falls back.
  const offsetSpec: PageSpec = { ...spec };
  if (key.length > 0) delete offsetSpec.sort;
  for (;;) {
    // The row cap was hit with a full last page: there may be more, so it says so.
    if (rows.length >= EXPORT_MAX_ROWS) return { columns, rows, capped: true };
    const limit = Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS - rows.length);
    const q = keyset
      ? keysetQuery({ ...spec, key, limit, ...(after === undefined ? {} : { after }) })
      : pageQuery({ ...offsetSpec, offset: rows.length, limit });
    const res = await client.query({ db, sql: q.sql, params: q.params, limit: EXPORT_PAGE });
    columns = res.columns;
    for (const row of res.rows) {
      bytes += utf8.encode(JSON.stringify(row)).length;
      if (bytes > EXPORT_MAX_BYTES) return { columns, rows, capped: true };
      rows.push(row);
    }
    onProgress(rows.length);
    if (res.rows.length < limit) return { columns, rows, capped: false };
    const last = res.rows.at(-1);
    const next = last === undefined ? undefined : rowKeyOrReason(table, res.columns, last);
    if (next !== undefined && 'key' in next) after = next.key.values;
    else keyset = false;
  }
}
