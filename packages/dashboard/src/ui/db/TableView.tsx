import type { Cell, TableInfo } from '@project-deck/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbApiError } from '../../api/db-client.js';
import { asDbApiError } from '../../api/db-client.js';
import type { Param } from '../../db/cells.js';
import { paramLabel, visibleText } from '../../db/cells.js';
import { changedRows, keyColumns } from '../../db/keys.js';
import type { PageSpec } from '../../db/sql-build.js';
import { countQuery, pageQuery } from '../../db/sql-build.js';
import { useDebounced } from '../../search/useDebounced.js';
import { useDbClient } from '../../state/DbProvider.js';
import { Skeleton } from '../Skeleton.js';
import { button, field, linkButton } from '../styles.js';
import { PANE_QUERY, useMedia } from '../useMedia.js';
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
  total: number;
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
  const columnsInfo = table.columns;
  const names = useMemo(() => columnsInfo.map((c) => c.name), [columnsInfo]);
  const key = useMemo(() => {
    const pk = keyColumns(table);
    if (pk.length > 0) return pk;
    return table.kind === 'table' ? ['rowid'] : [];
  }, [table]);
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columnsInfo.map((c) => {
        const fk = table.foreignKeys.find((f) => f.from === c.name);
        return {
          name: c.name,
          type: c.type,
          pk: c.pk,
          ...(fk === undefined ? {} : { fk: fk.table }),
        };
      }),
    [columnsInfo, table.foreignKeys],
  );

  const [filter, setFilter] = useState('');
  const typed = useDebounced(filter, FILTER_DEBOUNCE_MS);
  const [sort, setSort] = useState<{ column: string; dir: SortDir } | undefined>();
  const [pageIndex, setPageIndex] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [flash, setFlash] = useState<ReadonlySet<number>>(new Set());
  const range = useRef<[number, number]>([0, -1]);
  const [newRows, setNewRows] = useState<number[]>([]);
  const [scrollTo, setScrollTo] = useState<{ index: number; seq: number }>();
  const [details, setDetails] = useState<number | undefined>();
  const [retry, setRetry] = useState(0);
  const narrow = !useMedia(PANE_QUERY, true);
  const lastPage = useRef<Page | undefined>(undefined);
  const lastTick = useRef(p.tick);
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
    const count = countQuery(spec);
    Promise.all([
      client.query({ db, sql: page.sql, params: page.params, limit: PAGE_SIZE }),
      client.query({ db, sql: count.sql, params: count.params, limit: 1 }),
    ]).then(
      ([rows, counted]) => {
        if (cancelled) return;
        const totalCell = counted.rows[0]?.[0];
        const total = typeof totalCell === 'number' ? totalCell : rows.rows.length;
        const next: Page = { columns: rows.columns, rows: rows.rows, total };
        lastPage.current = next;
        setLoad({ status: 'ready', page: next });
        if (!live || prev === undefined) {
          setFlash(new Set());
          setNewRows([]);
          return;
        }
        const changed = changedRows(key, prev, next);
        setFlash(changed);
        const added = total - prev.total;
        if (added > 0)
          announce(`${added} ${added === 1 ? 'row' : 'rows'} added to ${visibleText(table.name)}`);
        const [first, last] = range.current;
        const away = [...changed].filter((i) => i < first || i > last);
        setNewRows(away);
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
  }, [client, db, spec, tick, retry, key, table.name, announce]);

  useEffect(() => {
    if (flash.size === 0) return;
    const timer = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const page = load.status === 'ready' ? load.page : load.last;
  const onRange = useCallback((first: number, last: number) => {
    range.current = [first, last];
  }, []);

  const openRow = (index: number) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetails(index);
  };
  const closeDetails = () => {
    setDetails(undefined);
    returnFocus.current?.focus();
  };

  const followKey = (rowIndex: number, colIndex: number) => {
    const column = gridColumns[colIndex];
    const fk = table.foreignKeys.find((f) => f.from === column?.name);
    const value = page?.rows[rowIndex]?.[colIndex];
    if (fk === undefined || value === undefined || value === null) return;
    if (typeof value === 'object' && value.type !== 'int') return;
    const param: Param = typeof value === 'object' ? { type: 'int', value: value.value } : value;
    p.onFollowKey(fk.table, fk.to ?? '', param);
  };

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const to = Math.min(total, (pageIndex + 1) * PAGE_SIZE);
  const filtered = typed !== '' || p.match !== undefined;
  const selected = details === undefined ? undefined : page?.rows[details];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
            flash={flash}
            narrow={narrow}
            onRange={onRange}
            scrollTo={scrollTo}
          />
        )}
      </TableBody>
      {newRows.length > 0 && (
        <button
          type="button"
          className={`${button} absolute bottom-12 left-1/2 -translate-x-1/2 bg-surface`}
          onClick={() => {
            setScrollTo({ index: newRows[0] ?? 0, seq: Date.now() });
            setNewRows([]);
          }}
        >
          {newRows.length} new {newRows.length === 1 ? 'row' : 'rows'}
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
          rows={async (onProgress) => exportTable(client, db, spec, total, onProgress)}
        />
      </div>
      {selected !== undefined && page !== undefined && (
        <RowDetails
          db={db}
          table={table}
          columns={page.columns}
          row={selected}
          writes={p.writes}
          connected={p.connected}
          onClose={closeDetails}
          onFollowKey={(t, c, v) => {
            setDetails(undefined);
            p.onFollowKey(t, c, v);
          }}
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

async function exportTable(
  client: ReturnType<typeof useDbClient>,
  db: string,
  spec: PageSpec,
  total: number,
  onProgress: (rows: number) => void,
): Promise<{ columns: string[]; rows: Cell[][]; capped: boolean }> {
  const rows: Cell[][] = [];
  let columns: string[] = [];
  let bytes = 0;
  const wanted = Math.min(total, EXPORT_MAX_ROWS);
  for (let offset = 0; offset < wanted; offset += EXPORT_PAGE) {
    const q = pageQuery({ ...spec, offset, limit: Math.min(EXPORT_PAGE, wanted - offset) });
    const res = await client.query({ db, sql: q.sql, params: q.params, limit: EXPORT_PAGE });
    columns = res.columns;
    for (const row of res.rows) {
      bytes += JSON.stringify(row).length;
      if (bytes > EXPORT_MAX_BYTES) return { columns, rows, capped: true };
      rows.push(row);
    }
    onProgress(rows.length);
    if (res.rows.length === 0) break;
  }
  return { columns, rows, capped: total > rows.length };
}
