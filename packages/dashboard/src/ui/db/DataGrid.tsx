import type { Cell } from '@project-deck/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cellText, visibleText } from '../../db/cells.js';
import { VisibleText } from './VisibleText.js';

/** Characters of a cell drawn in the grid; the rest is in row details (one line, ellipsis). */
const SHOWN_CHARS = 300;
const ROW_HEIGHT = 28;
/** The sticky header's height, kept clear when a focused cell scrolls in (SC 2.4.11). */
const HEADER_HEIGHT = 32;

export interface GridColumn {
  name: string;
  type?: string;
  pk?: boolean;
  /** The referenced table, when this column is a foreign key. */
  fk?: string;
}

export type SortDir = 'asc' | 'desc';

export interface DataGridProps {
  label: string;
  columns: GridColumn[];
  rows: Cell[][];
  /** All rows the grid stands for (all pages), for `aria-rowcount`; -1 when unknown. */
  total: number;
  /** Rows before this page, for `aria-rowindex`. */
  offset?: number;
  sort?: { column: string; dir: SortDir } | undefined;
  onSort?: (column: string) => void;
  /** Enter on a cell, or a click on a row. */
  onOpenRow?: (index: number) => void;
  /** Enter or a click on a foreign-key value. */
  onFollowKey?: (row: number, column: number) => void;
  /** Row indexes that flash (new or changed). */
  flash?: ReadonlySet<number>;
  /** 320 px: the first two columns, then a "more" button per row (row details). */
  narrow?: boolean;
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** The rows currently drawn, so a caller can tell whether a row is in view. */
  onRange?: (first: number, last: number) => void;
  /** Asks the grid to scroll a row into view (e.g. "3 new rows"). */
  scrollTo?: { index: number; seq: number } | undefined;
}

interface Pos {
  row: number;
  col: number;
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

/**
 * The ARIA grid pattern (UI spec, accessibility): a header row, arrow-key cell
 * navigation with one tab stop, `aria-sort`, and only the rows in view in the DOM
 * (`aria-rowcount` says how many there are).
 */
export function DataGrid(p: DataGridProps) {
  const own = useRef<HTMLDivElement>(null);
  const ref = p.scrollRef ?? own;
  const [pos, setPos] = useState<Pos>({ row: 0, col: 0 });
  const [focusing, setFocusing] = useState(false);
  const shown = p.narrow === true ? p.columns.slice(0, 2) : p.columns;
  const more = p.narrow === true && p.columns.length > 2 && p.onOpenRow !== undefined;
  const colCount = shown.length + (more ? 1 : 0);
  const offset = p.offset ?? 0;

  const virtualizer = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    initialRect: { width: 420, height: 600 },
  });

  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;
  const onRange = p.onRange;
  useEffect(() => onRange?.(first, last), [onRange, first, last]);

  const scrollTo = p.scrollTo;
  useEffect(() => {
    if (scrollTo !== undefined) virtualizer.scrollToIndex(scrollTo.index, { align: 'center' });
  }, [scrollTo, virtualizer]);

  // Keep the tab stop on a cell that exists.
  const rowCount = p.rows.length;
  useEffect(() => {
    setPos((old) => ({
      row: Math.min(old.row, rowCount - 1 < 0 ? -1 : rowCount - 1),
      col: Math.min(old.col, colCount - 1),
    }));
  }, [rowCount, colCount]);

  useLayoutEffect(() => {
    if (!focusing) return;
    const cell = ref.current?.querySelector<HTMLElement>(`[data-cell="${pos.row}:${pos.col}"]`);
    cell?.focus({ preventScroll: pos.row < 0 });
    if (cell !== null && cell !== undefined) setFocusing(false);
  });

  const move = (row: number, col: number) => {
    const r = Math.max(-1, Math.min(rowCount - 1, row));
    const c = Math.max(0, Math.min(colCount - 1, col));
    if (r >= 0) virtualizer.scrollToIndex(r, { align: 'auto' });
    setPos({ row: r, col: c });
    setFocusing(true);
  };

  const activate = (row: number, col: number) => {
    if (row < 0) {
      const name = shown[col]?.name;
      if (name !== undefined) p.onSort?.(name);
      return;
    }
    if (more && col === shown.length) {
      p.onOpenRow?.(row);
      return;
    }
    const column = shown[col];
    if (column?.fk !== undefined && p.onFollowKey !== undefined && p.rows[row]?.[col] !== null) {
      p.onFollowKey(row, col);
      return;
    }
    p.onOpenRow?.(row);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor((ref.current?.clientHeight ?? 300) / ROW_HEIGHT) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(pos.row + 1, pos.col),
      ArrowUp: () => move(pos.row - 1, pos.col),
      ArrowRight: () => move(pos.row, pos.col + 1),
      ArrowLeft: () => move(pos.row, pos.col - 1),
      Home: () => (e.ctrlKey ? move(0, 0) : move(pos.row, 0)),
      End: () => (e.ctrlKey ? move(rowCount - 1, colCount - 1) : move(pos.row, colCount - 1)),
      PageDown: () => move(pos.row + page, pos.col),
      PageUp: () => move(Math.max(0, pos.row - page), pos.col),
      Enter: () => activate(pos.row, pos.col),
    };
    const run = keys[e.key];
    if (run === undefined || e.target === ref.current) return;
    e.preventDefault();
    run();
  };

  const template = `${shown.map(() => 'minmax(7rem, 1fr)').join(' ')}${more ? ' 4.5rem' : ''}`;
  const tab = (row: number, col: number) => (row === pos.row && col === pos.col ? 0 : -1);

  return (
    <div
      ref={ref}
      role="grid"
      aria-label={p.label}
      aria-rowcount={p.total < 0 ? -1 : p.total + 1}
      aria-colcount={colCount}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-auto"
      style={{ scrollPaddingTop: HEADER_HEIGHT }}
    >
      <div role="rowgroup" className="sticky top-0 z-[1] min-w-fit bg-bg">
        <div
          role="row"
          aria-rowindex={1}
          className="grid min-w-fit border-b border-border"
          style={{ gridTemplateColumns: template }}
        >
          {shown.map((c, i) => {
            const sorted = p.sort?.column === c.name ? p.sort.dir : undefined;
            const marks = [c.pk === true ? 'PK' : '', c.fk === undefined ? '' : 'FK']
              .filter(Boolean)
              .join(' ');
            const title = visibleText(
              `${c.name}${c.type ? ` ${c.type}` : ''}${marks ? ` (${marks})` : ''}${c.fk ? ` → ${c.fk}` : ''}`,
            );
            return (
              <div
                key={i}
                role="columnheader"
                aria-colindex={i + 1}
                aria-sort={
                  sorted === undefined ? (p.onSort ? 'none' : undefined) : ARIA_SORT[sorted]
                }
                data-cell={`-1:${i}`}
                tabIndex={tab(-1, i)}
                title={title}
                onClick={() => {
                  setPos({ row: -1, col: i });
                  p.onSort?.(c.name);
                }}
                className={`flex min-h-8 min-w-0 items-center gap-1 px-2 text-left font-medium ${p.onSort ? 'cursor-pointer hover:bg-surface' : ''}`}
              >
                <span className="truncate">
                  <VisibleText text={c.name} />
                </span>
                {c.type ? (
                  <span className="hidden truncate text-sm text-muted pane:inline">{c.type}</span>
                ) : null}
                {marks !== '' && <span className="text-sm text-muted">{marks}</span>}
                {sorted !== undefined && (
                  <span aria-hidden="true">{sorted === 'asc' ? '▲' : '▼'}</span>
                )}
              </div>
            );
          })}
          {more && (
            <div role="columnheader" aria-colindex={colCount} className="px-2">
              <span className="sr-only">More</span>
            </div>
          )}
        </div>
      </div>
      <div
        role="rowgroup"
        className="relative min-w-fit"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {items.map((item) => {
          const row = p.rows[item.index];
          if (row === undefined) return null;
          const flashing = p.flash?.has(item.index) === true;
          return (
            <div
              key={item.key}
              role="row"
              aria-rowindex={offset + item.index + 2}
              className={`absolute left-0 grid w-full min-w-fit border-b border-border/30 font-mono text-sm hover:bg-surface ${flashing ? 'deck-flash' : ''}`}
              style={{
                gridTemplateColumns: template,
                height: ROW_HEIGHT,
                transform: `translateY(${item.start}px)`,
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button') === null) p.onOpenRow?.(item.index);
              }}
            >
              {shown.map((c, ci) => {
                const cell = row[ci] ?? null;
                const { text, muted } = cellText(cell);
                const clipped = text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
                const fk = c.fk !== undefined && cell !== null;
                return (
                  <div
                    key={ci}
                    role="gridcell"
                    aria-colindex={ci + 1}
                    data-cell={`${item.index}:${ci}`}
                    tabIndex={tab(item.index, ci)}
                    title={visibleText(text.slice(0, 1000))}
                    onFocus={() => setPos({ row: item.index, col: ci })}
                    onClick={(e) => {
                      if (!fk) return;
                      e.stopPropagation();
                      p.onFollowKey?.(item.index, ci);
                    }}
                    className={`flex min-w-0 items-center px-2 ${muted ? 'text-muted' : ''}`}
                  >
                    <span
                      className={`truncate ${fk ? 'cursor-pointer text-accent underline' : ''}`}
                    >
                      <VisibleText text={clipped} />
                    </span>
                  </div>
                );
              })}
              {more && (
                <div role="gridcell" aria-colindex={colCount} className="flex items-center px-1">
                  <button
                    type="button"
                    data-cell={`${item.index}:${shown.length}`}
                    tabIndex={tab(item.index, shown.length)}
                    onFocus={() => setPos({ row: item.index, col: shown.length })}
                    className="min-h-6 rounded-sm border border-border px-1 font-sans hover:bg-surface"
                    aria-label={`More: row ${offset + item.index + 1}`}
                    onClick={() => p.onOpenRow?.(item.index)}
                  >
                    more
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
