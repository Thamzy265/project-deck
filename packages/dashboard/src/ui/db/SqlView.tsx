import type { QueryResult, TableInfo } from '@project-deck/core';
import { DASHBOARD_MAX_QUERY_LIMIT } from '@project-deck/core';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import { queryErrorText } from '../../db/copy.js';
import { useDbClient } from '../../state/DbProvider.js';
import { Spinner } from '../Spinner.js';
import { button } from '../styles.js';
import { DataGrid } from './DataGrid.js';
import { ExportMenu } from './ExportMenu.js';
import { VisibleText } from './VisibleText.js';

const SqlEditor = lazy(() => import('./SqlEditor.js'));

type Run =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: QueryResult }
  | { kind: 'failed'; text: string; line?: number };

/**
 * The SQL editor (UI spec): reading queries only. The daemon's gate decides; a refusal
 * says why in the spec's words, and nothing ran. Results cap at 1,000 rows.
 */
export function SqlView({
  db,
  tables,
  connected,
  sql,
  onSqlChange,
  runNow,
  onRan,
  onSave,
}: {
  db: string;
  tables: TableInfo[];
  connected: boolean;
  sql: string;
  onSqlChange: (sql: string) => void;
  /** Run `sql` as soon as the view is ready (a saved query's Run); then `onRan`. */
  runNow: boolean;
  onRan: () => void;
  onSave: () => void;
}) {
  const client = useDbClient();
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const abort = useRef<AbortController | undefined>(undefined);
  const runButton = useRef<HTMLButtonElement>(null);
  const schema = useMemo(
    () => Object.fromEntries(tables.map((t) => [t.name, t.columns.map((c) => c.name)])),
    [tables],
  );
  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const example = `SELECT * FROM ${tables.find((t) => t.kind === 'table')?.name ?? 'orders'} LIMIT 20`;

  const start = () => {
    const text = sqlRef.current;
    if (!connected || text.trim() === '' || run.kind === 'running') return;
    const controller = new AbortController();
    abort.current = controller;
    setRun({ kind: 'running' });
    client.query({ db, sql: text, limit: DASHBOARD_MAX_QUERY_LIMIT }, controller.signal).then(
      (result) => {
        if (abort.current === controller) setRun({ kind: 'done', result });
      },
      (err: unknown) => {
        if (abort.current !== controller) return;
        const e = asDbApiError(err);
        if (e.code === 'cancelled') {
          setRun({ kind: 'idle' });
          return;
        }
        setRun({
          kind: 'failed',
          ...queryErrorText({ code: e.code, error: e.message, detail: e.detail }, text),
        });
      },
    );
  };
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (!runNow) return;
    onRan();
    startRef.current();
  }, [runNow, onRan]);
  useEffect(() => () => abort.current?.abort(), []);

  const cancel = () => {
    abort.current?.abort();
    abort.current = undefined;
    setRun({ kind: 'idle' });
  };

  const result = run.kind === 'done' ? run.result : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex flex-col gap-1">
        <span id="sql-label" className="font-medium">
          SQL
        </span>
        <Suspense fallback={<p role="status">Loading the editor…</p>}>
          <SqlEditor
            value={sql}
            onChange={onSqlChange}
            schema={schema}
            onRun={() => startRef.current()}
            onSave={onSave}
            onLeave={() => runButton.current?.focus()}
            errorLine={run.kind === 'failed' ? run.line : undefined}
            placeholderText={example}
            label="SQL"
          />
        </Suspense>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={runButton}
          type="button"
          className={button}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-disabled={!connected || run.kind === 'running' ? true : undefined}
          title={connected ? undefined : 'Not connected'}
          onClick={start}
        >
          Run
        </button>
        {run.kind === 'running' && (
          <>
            <span role="status" className="flex items-center gap-1">
              <Spinner /> Running…
            </span>
            <button type="button" className={button} onClick={cancel}>
              Cancel
            </button>
          </>
        )}
        {!connected && <span className="text-sm text-muted">Not connected</span>}
        {result !== undefined && (
          <span role="status" className="text-sm">
            {result.rows.length.toLocaleString('en')} {result.rows.length === 1 ? 'row' : 'rows'} in{' '}
            {Math.round(result.durationMs)} ms
            {result.truncated
              ? ` · Showing the first ${DASHBOARD_MAX_QUERY_LIMIT.toLocaleString('en')} rows`
              : ''}
          </span>
        )}
        <span className="flex-1" />
        {result !== undefined && (
          <ExportMenu
            name="query"
            disabled={result.rows.length === 0}
            rows={() =>
              Promise.resolve({
                columns: result.columns,
                rows: result.rows,
                capped: result.truncated,
              })
            }
          />
        )}
      </div>
      {run.kind === 'failed' && (
        <p role="alert" className="text-error">
          <VisibleText
            text={run.line === undefined ? run.text : `${run.text} (line ${run.line})`}
          />
        </p>
      )}
      {result !== undefined && result.rows.length > 0 && (
        <DataGrid
          label="Query result"
          columns={result.columns.map((name) => ({ name }))}
          rows={result.rows}
          total={result.rows.length}
        />
      )}
    </div>
  );
}
