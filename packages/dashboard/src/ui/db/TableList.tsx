import type { TableInfo } from '@project-deck/core';
import type { KeyboardEvent } from 'react';
import { useRef } from 'react';
import { visibleText } from '../../db/cells.js';
import { field } from '../styles.js';
import { VisibleText } from './VisibleText.js';

function label(t: TableInfo): string {
  return t.rowCount === undefined ? t.name : `${t.name} (${t.rowCount.toLocaleString('en')})`;
}

/** Below 900 px: a select with row counts (UI spec, table picker). */
export function TablePicker({
  tables,
  selected,
  onSelect,
  disabled,
}: {
  tables: TableInfo[];
  selected: string | undefined;
  onSelect: (name: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label htmlFor="db-table" className="sr-only">
        Table
      </label>
      <select
        id="db-table"
        className={`${field} min-w-0 flex-1 basis-full pane:basis-32`}
        value={selected ?? ''}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
      >
        {tables.map((t) => (
          <option key={t.name} value={t.name}>
            {visibleText(label(t))}
          </option>
        ))}
      </select>
    </>
  );
}

/** From 900 px: a 240 px sidebar of tables; arrow keys move, Enter or a click opens. */
export function TableSidebar({
  tables,
  selected,
  onSelect,
  disabled,
}: {
  tables: TableInfo[];
  selected: string | undefined;
  onSelect: (name: string) => void;
  disabled: boolean;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tables.length - 1 }[
      e.key
    ];
    const t = next === undefined ? undefined : tables[next];
    if (t === undefined) return;
    e.preventDefault();
    refs.current.get(t.name)?.focus();
  };
  const current = tables.some((t) => t.name === selected) ? selected : tables[0]?.name;
  return (
    <nav
      aria-label="Tables"
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border"
    >
      <ul className="flex flex-col">
        {tables.map((t, i) => {
          const active = t.name === selected;
          return (
            <li key={t.name}>
              <button
                ref={(el) => {
                  if (el === null) refs.current.delete(t.name);
                  else refs.current.set(t.name, el);
                }}
                type="button"
                aria-current={active ? 'true' : undefined}
                aria-disabled={disabled ? true : undefined}
                tabIndex={t.name === current ? 0 : -1}
                title={visibleText(t.name)}
                onKeyDown={(e) => onKeyDown(e, i)}
                onClick={() => {
                  if (!disabled) onSelect(t.name);
                }}
                className={`flex min-h-8 w-full items-center gap-2 px-2 text-left hover:bg-surface ${active ? 'bg-surface font-medium' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  <VisibleText text={t.name} />
                </span>
                {t.kind === 'view' && <span className="text-sm text-muted">view</span>}
                {t.rowCount !== undefined && (
                  <span className="text-sm text-muted">{t.rowCount.toLocaleString('en')}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
