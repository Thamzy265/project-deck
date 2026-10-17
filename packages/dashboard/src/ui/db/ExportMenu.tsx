import type { Cell } from '@project-deck/core';
import { useState } from 'react';
import { exportName, toCsv, toJson } from '../../db/export.js';
import { button } from '../styles.js';

export interface ExportRows {
  columns: string[];
  rows: Cell[][];
  /** True when the export stopped at its cap. */
  capped: boolean;
}

/** Saves through the browser: a blob URL on a temporary link, freed at once. */
function save(text: string, file: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type State =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'error' }
  | { kind: 'done'; capped: number | undefined };

/** "Export ▾": CSV or JSON of the table (current filter) or of a query result. */
export function ExportMenu({
  name,
  disabled,
  rows,
}: {
  name: string;
  disabled: boolean;
  rows: (onProgress: (n: number) => void) => Promise<ExportRows>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const busy = state.kind === 'preparing';
  const id = `export-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  const run = async (format: 'csv' | 'json') => {
    setOpen(false);
    setState({ kind: 'preparing' });
    try {
      const out = await rows(() => undefined);
      const text = format === 'csv' ? toCsv(out.columns, out.rows) : toJson(out.columns, out.rows);
      save(text, exportName(name, format), format === 'csv' ? 'text/csv' : 'application/json');
      setState({ kind: 'done', capped: out.capped ? out.rows.length : undefined });
    } catch {
      setState({ kind: 'error' });
    }
  };

  return (
    <div className="relative flex items-center gap-2">
      {state.kind === 'preparing' && <span role="status">Preparing…</span>}
      {state.kind === 'error' && (
        <span role="alert" className="text-error">
          Export failed
        </span>
      )}
      {state.kind === 'done' && state.capped !== undefined && (
        <span role="status">Exported the first {state.capped.toLocaleString('en')} rows</span>
      )}
      <button
        type="button"
        className={button}
        aria-expanded={open}
        aria-controls={id}
        aria-disabled={disabled || busy ? true : undefined}
        title={disabled ? 'No rows' : undefined}
        onClick={() => {
          if (!disabled && !busy) setOpen(!open);
        }}
      >
        Export <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id={id}
          className="absolute right-0 bottom-full z-10 mb-1 flex flex-col gap-1 rounded-md border border-border bg-bg p-1"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <button type="button" className={button} onClick={() => void run('csv')}>
            CSV
          </button>
          <button type="button" className={button} onClick={() => void run('json')}>
            JSON
          </button>
        </div>
      )}
    </div>
  );
}
