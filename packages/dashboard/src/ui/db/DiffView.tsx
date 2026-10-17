import type { DbDiff } from '@project-deck/core';
import { useCallback, useEffect, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import type { DiffRowModel, DiffTableModel } from '../../db/diff-model.js';
import { visibleText } from '../../db/cells.js';
import { diffModel } from '../../db/diff-model.js';
import { useDbClient } from '../../state/DbProvider.js';
import { clock } from '../format.js';
import { button, linkButton } from '../styles.js';
import { VisibleText } from './VisibleText.js';

export interface Snapshot {
  id: string;
  takenAt: number;
}

const KIND_STYLE = {
  added: 'text-diff-added bg-diff-added-tint',
  changed: 'text-diff-changed bg-diff-changed-tint',
  removed: 'text-diff-removed bg-diff-removed-tint',
} as const;

type Load =
  { status: 'loading' } | { status: 'ready'; diff: DbDiff } | { status: 'error'; message: string };

/** What changed since the snapshot (UI spec, diff view). Each open compares again. */
export function DiffView({
  db,
  snapshot,
  connected,
}: {
  db: string;
  snapshot: Snapshot | undefined;
  connected: boolean;
}) {
  const client = useDbClient();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [run, setRun] = useState(0);

  const compare = useCallback(() => setRun((n) => n + 1), []);
  useEffect(() => {
    if (snapshot === undefined || !connected) return;
    let cancelled = false;
    setLoad({ status: 'loading' });
    client.diff(db, snapshot.id).then(
      (diff) => {
        if (!cancelled) setLoad({ status: 'ready', diff });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: asDbApiError(err).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, db, snapshot, run, connected]);

  if (snapshot === undefined) {
    return <p className="p-2">Take a snapshot first, then use the app</p>;
  }
  const at = clock(snapshot.takenAt, 'minutes');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span>Since the snapshot at {at}</span>
        <button
          type="button"
          className={button}
          aria-disabled={!connected || load.status === 'loading' ? true : undefined}
          onClick={() => {
            if (connected && load.status !== 'loading') compare();
          }}
        >
          Compare again
        </button>
      </div>
      <DiffBody load={load} at={at} onRetry={compare} />
    </div>
  );
}

function DiffBody({ load, at, onRetry }: { load: Load; at: string; onRetry: () => void }) {
  if (load.status === 'loading')
    return (
      <p role="status" className="p-2">
        Comparing…
      </p>
    );
  if (load.status === 'error') {
    return (
      <p role="alert" className="p-2">
        Couldn't compare: {load.message}{' '}
        <button type="button" className={linkButton} onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  const model = diffModel(load.diff);
  if (model.empty) return <p className="p-2">No changes since {at}.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
      {model.tables.map((t) => (
        <DiffTable key={t.table} table={t} />
      ))}
    </div>
  );
}

function DiffTable({ table }: { table: DiffTableModel }) {
  const id = `diff-${table.table.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <section aria-labelledby={id} className="mb-3">
      <h3 id={id} className="flex flex-wrap items-baseline gap-2 border-b border-border py-1">
        <span className="font-medium">
          <VisibleText text={table.table} />
        </span>
        <span className="text-sm">{table.summary}</span>
        {table.note !== undefined && <span className="text-sm text-muted">{table.note}</span>}
      </h3>
      {table.error !== undefined && (
        <p role="alert" className="py-1">
          <VisibleText text={table.error} />
        </p>
      )}
      <ul aria-label={`Changes in ${visibleText(table.table)}`}>
        {table.rows.map((r, i) => (
          <DiffRow key={i} row={r} />
        ))}
      </ul>
      {table.more > 0 && (
        <p className="py-1 text-sm text-muted">and {table.more.toLocaleString('en')} more</p>
      )}
    </section>
  );
}

function DiffRow({ row }: { row: DiffRowModel }) {
  return (
    <li
      tabIndex={0}
      className="flex flex-col gap-0.5 border-b border-border/30 py-1 hover:bg-surface"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className={`rounded-sm px-1 font-mono ${KIND_STYLE[row.kind]}`}>
          <span aria-hidden="true">{row.symbol} </span>
          {row.word}
        </span>
        <span className="font-mono text-sm">
          <VisibleText text={row.key} />
        </span>
        {row.gone && <span className="text-sm text-muted">gone since</span>}
      </span>
      {row.cells.length > 0 && (
        <span className="flex flex-wrap gap-x-3 font-mono text-sm">
          {row.cells.map((c) => (
            <span key={c.column} className={c.changed ? 'font-bold' : ''}>
              <span className="text-muted">
                <VisibleText text={c.column} />
                {c.changed && <span className="sr-only"> (changed)</span>}:
              </span>{' '}
              <VisibleText text={c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text} />
            </span>
          ))}
        </span>
      )}
    </li>
  );
}
