import type { DbList, TableInfo } from '@project-deck/core';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import type { Param } from '../../db/cells.js';
import { visibleText } from '../../db/cells.js';
import { quoteIdent } from '../../db/sql-build.js';
import { useDbClient } from '../../state/DbProvider.js';
import { useDeck } from '../../state/DeckProvider.js';
import { clock } from '../format.js';
import { Skeleton } from '../Skeleton.js';
import { Spinner } from '../Spinner.js';
import { button, field, linkButton } from '../styles.js';
import { PANE_QUERY, WIDE_QUERY, useMedia } from '../useMedia.js';
import { DevicePicker } from './DevicePicker.js';
import type { Snapshot } from './DiffView.js';
import { DiffView } from './DiffView.js';
import type { WriteMode } from './RowDetails.js';
import { SavedQueriesMenu, useSavedQueries, withQuery } from './SavedQueries.js';
import { SchemaDiagram } from './SchemaDiagram.js';
import { SqlView } from './SqlView.js';
import { SetupCard } from './SetupCard.js';
import { TablePicker, TableSidebar } from './TableList.js';
import type { Match } from './TableView.js';
import { TableView } from './TableView.js';
import { useAnnounce } from './useAnnounce.js';
import { VisibleText } from './VisibleText.js';

export type ViewId = 'table' | 'diagram' | 'sql' | 'diff';

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'diagram', label: 'Diagram' },
  { id: 'sql', label: 'SQL' },
  { id: 'diff', label: 'Diff' },
];

/** Changed tables are re-counted at most this often (row counts in the table list). */
const SCHEMA_REFRESH_MS = 500;
const TOAST_MS = 4000;

type Load<T> =
  | { status: 'idle' }
  | { status: 'loading'; last?: T }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string; last?: T };

function lastOf<T>(load: Load<T>): T | undefined {
  if (load.status === 'ready') return load.value;
  if (load.status === 'loading' || load.status === 'error') return load.last;
  return undefined;
}

function loading<T>(old: Load<T>): Load<T> {
  const last = lastOf(old);
  return last === undefined ? { status: 'loading' } : { status: 'loading', last };
}

/**
 * The Database tab (docs/ui/m3-database-tab.md): database picker, tables, and the
 * table, diagram and diff views. Live databases re-query when the app changes a table.
 */
export function DatabasePanel() {
  const { state, onDbEvent } = useDeck();
  const client = useDbClient();
  const attached = state.attached;
  const connected = state.connection.kind === 'connected';
  const wide = useMedia(WIDE_QUERY, false);
  const pane = useMedia(PANE_QUERY, true);
  const { message, announce } = useAnnounce();

  const [list, setList] = useState<Load<DbList>>({ status: 'idle' });
  const [listRun, setListRun] = useState(0);
  const [dbName, setDbName] = useState<string | undefined>();
  const [schema, setSchema] = useState<Load<TableInfo[]>>({ status: 'idle' });
  const [schemaRun, setSchemaRun] = useState(0);
  const [nav, setNav] = useState<{ table: string | undefined; match?: Match }>({
    table: undefined,
  });
  const [view, setView] = useState<ViewId>('table');
  const [ticks, setTicks] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const [snapping, setSnapping] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [choosing, setChoosing] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const schemaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sql, setSql] = useState('');
  const [runNow, setRunNow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const ran = useCallback(() => setRunNow(false), []);

  const appId = attached?.id;
  const saved = useSavedQueries(appId);
  useEffect(() => {
    if (appId === undefined) return;
    let cancelled = false;
    setList(loading);
    client.list().then(
      (value) => {
        if (!cancelled) setList({ status: 'ready', value });
      },
      (err: unknown) => {
        if (cancelled) return;
        setList((old) => {
          const last = lastOf(old);
          const message = asDbApiError(err).message;
          return last === undefined
            ? { status: 'error', message }
            : { status: 'error', message, last };
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, appId, listRun]);

  // A new app starts afresh: its databases and snapshots are other ones.
  useEffect(() => {
    setDbName(undefined);
    setSnapshots({});
    setNav({ table: undefined });
  }, [appId]);

  const databases = lastOf(list)?.databases ?? [];
  const current = databases.find((d) => d.name === dbName) ?? databases[0];
  const currentName = current?.name;

  useEffect(() => {
    if (currentName === undefined || appId === undefined) return;
    let cancelled = false;
    setSchema(loading);
    client.schema(currentName).then(
      (s) => {
        if (!cancelled) setSchema({ status: 'ready', value: s.tables });
      },
      (err: unknown) => {
        if (cancelled) return;
        setSchema((old) => {
          const last = lastOf(old);
          const message = asDbApiError(err).message;
          return last === undefined
            ? { status: 'error', message }
            : { status: 'error', message, last };
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, currentName, appId, schemaRun]);

  useEffect(
    () =>
      onDbEvent((event) => {
        if (event.kind === 'reconnected') {
          setListRun((n) => n + 1);
          setSchemaRun((n) => n + 1);
          setTicks((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + 1])));
          return;
        }
        if (event.db !== currentName) return;
        setTicks((t) => ({ ...t, [event.table]: (t[event.table] ?? 0) + 1 }));
        clearTimeout(schemaTimer.current);
        schemaTimer.current = setTimeout(() => setSchemaRun((n) => n + 1), SCHEMA_REFRESH_MS);
      }),
    [onDbEvent, currentName],
  );
  useEffect(() => () => clearTimeout(schemaTimer.current), []);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const tables = lastOf(schema) ?? [];
  const table = tables.find((t) => t.name === nav.table) ?? tables[0];

  const openTable = useCallback((name: string, match?: Match) => {
    setNav(match === undefined ? { table: name } : { table: name, match });
    setView('table');
  }, []);

  const followKey = useCallback(
    (target: string, column: string, value: Param) => {
      const t = tables.find((x) => x.name === target);
      if (t === undefined) {
        setToast('Row not found');
        return;
      }
      // A key that names no column points at the referenced table's primary key.
      const col = column !== '' ? column : t.columns.find((c) => c.pk)?.name;
      if (col === undefined) {
        setToast('Row not found');
        return;
      }
      if (currentName === undefined) return;
      client
        .query({
          db: currentName,
          sql: `SELECT 1 FROM ${quoteIdent(target)} WHERE ${quoteIdent(col)} IS ? LIMIT 1`,
          params: [value],
          limit: 1,
        })
        .then(
          (res) => {
            if (res.rows.length === 0) setToast('Row not found');
            else openTable(target, { column: col, value });
          },
          () => setToast('Row not found'),
        );
    },
    [tables, openTable, client, currentName],
  );

  if (attached === null) {
    return (
      <Shell>
        <select aria-label="Database" className={field} disabled>
          <option>No app attached</option>
        </select>
      </Shell>
    );
  }

  if (list.status === 'idle' || (list.status === 'loading' && list.last === undefined)) {
    return (
      <Shell>
        <p role="status" className="flex items-center gap-2 p-2">
          <Spinner /> Finding databases…
        </p>
      </Shell>
    );
  }
  if (list.status === 'error' && list.last === undefined) {
    return (
      <Shell>
        <p role="alert" className="p-2">
          Couldn't read databases: {list.message}.{' '}
          <button type="button" className={linkButton} onClick={() => setListRun((n) => n + 1)}>
            Retry
          </button>
        </p>
      </Shell>
    );
  }

  const listed = lastOf(list);
  const sources = listed?.sources ?? [];
  const choices = sources.filter(
    (s) => s.error?.code === 'choose-device' && (s.error.devices?.length ?? 0) > 0,
  );
  const chooseDevice = (source: string, device: string) => {
    setChoosing({ busy: true });
    client.chooseDevice(source, device).then(
      (value) => {
        setChoosing({ busy: false });
        setList({ status: 'ready', value });
      },
      (err: unknown) => setChoosing({ busy: false, error: asDbApiError(err).message }),
    );
  };
  const pickers = choices.map((s) => (
    <DevicePicker
      key={s.id}
      source={s.id}
      message={s.error?.message ?? ''}
      devices={s.error?.devices ?? []}
      onChoose={chooseDevice}
      busy={choosing.busy}
      error={choosing.error}
    />
  ));

  if (current === undefined) {
    return (
      <Shell>
        {pickers}
        {choices.length === 0 && (
          <SetupCard
            app={attached}
            sources={sources}
            busy={list.status === 'loading'}
            onSnapshot={() => setListRun((n) => n + 1)}
          />
        )}
      </Shell>
    );
  }

  const live = current.backend === 'live';
  const source = sources.find((s) => s.id === current.source);
  const writes: WriteMode = !(listed?.writesAllowed ?? false)
    ? { kind: 'off' }
    : live && source?.writable === true
      ? { kind: 'on' }
      : { kind: 'snapshot' };
  const snapshot = snapshots[current.name];
  const takenAt = current.takenAt === undefined ? undefined : clock(current.takenAt, 'minutes');

  const takeSnapshot = () => {
    if (snapping.busy || !connected) return;
    setSnapping({ busy: true });
    client.snapshot(current.name).then(
      (s) => {
        setSnapping({ busy: false });
        setSnapshots((all) => ({ ...all, [current.name]: { id: s.id, takenAt: s.takenAt } }));
      },
      (err: unknown) =>
        setSnapping({
          busy: false,
          error: `Couldn't take a snapshot: ${asDbApiError(err).message}`,
        }),
    );
  };

  const refreshCopy = () => {
    if (refreshing || !connected) return;
    setRefreshing(true);
    client.refresh(current.name).then(
      () => {
        setRefreshing(false);
        setListRun((n) => n + 1);
        setSchemaRun((n) => n + 1);
        setTicks((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + 1])));
      },
      (err: unknown) => {
        setRefreshing(false);
        setToast(asDbApiError(err).message);
      },
    );
  };

  const viewSwitcher = pane ? (
    <div role="group" aria-label="View" className="flex rounded-sm border border-border">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={view === v.id}
          className={`min-h-6 px-2 ${view === v.id ? 'bg-surface font-medium' : 'hover:bg-surface'}`}
          onClick={() => setView(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  ) : (
    <>
      <label htmlFor="db-view" className="sr-only">
        View
      </label>
      <select
        id="db-view"
        className={`${field} basis-full`}
        value={view}
        onChange={(e) => {
          const v = VIEWS.find((x) => x.id === e.target.value);
          if (v !== undefined) setView(v.id);
        }}
      >
        {VIEWS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </>
  );

  const schemaProblem =
    schema.status === 'error' && schema.last === undefined ? (
      <p role="alert" className="p-2">
        Couldn't read the schema.{' '}
        <button type="button" className={linkButton} onClick={() => setSchemaRun((n) => n + 1)}>
          Retry
        </button>
      </p>
    ) : undefined;
  const schemaLoading =
    schema.status === 'idle' || (schema.status === 'loading' && schema.last === undefined);

  let body: ReactNode;
  if (schemaProblem !== undefined) body = schemaProblem;
  else if (schemaLoading)
    body =
      view === 'diagram' ? (
        <p role="status" className="p-2">
          Drawing…
        </p>
      ) : (
        <Skeleton label="Loading tables" />
      );
  else if (view === 'diagram') {
    body = <SchemaDiagram tables={tables} onOpen={(n) => openTable(n)} listByDefault={!pane} />;
  } else if (view === 'sql') {
    body = (
      <SqlView
        db={current.name}
        tables={tables}
        connected={connected}
        sql={sql}
        onSqlChange={setSql}
        runNow={runNow}
        onRan={ran}
        onSave={() => {
          const text = sql.trim();
          if (text === '') return;
          const next = withQuery(saved.queries, text);
          if (next === undefined) setToast("Couldn't save queries");
          else if (next === saved.queries) setToast('Saved');
          else void saved.save(next).then((ok) => setToast(ok ? 'Saved' : "Couldn't save queries"));
        }}
      />
    );
  } else if (view === 'diff') {
    body = <DiffView db={current.name} snapshot={snapshot} connected={connected} />;
  } else if (table === undefined) {
    body = <p className="p-2">No tables in this database</p>;
  } else {
    body = (
      <TableView
        key={JSON.stringify([current.name, table.name])}
        db={current.name}
        table={table}
        tick={ticks[table.name] ?? 0}
        connected={connected}
        writes={writes}
        match={nav.match}
        onClearMatch={() => setNav({ table: table.name })}
        onFollowKey={followKey}
        onToast={setToast}
        announce={announce}
      />
    );
  }

  return (
    <Shell>
      {pickers}
      <div className="flex flex-wrap items-center gap-2 p-2">
        <label htmlFor="db-picker" className="sr-only">
          Database
        </label>
        <select
          id="db-picker"
          className={`${field} min-w-0 flex-1 basis-full pane:basis-40 ${connected ? '' : 'text-muted'}`}
          value={current.name}
          disabled={!connected}
          title={visibleText(current.name)}
          onChange={(e) => {
            setDbName(e.target.value);
            setNav({ table: undefined });
          }}
        >
          {databases.map((d) => (
            <option key={d.name} value={d.name}>
              {visibleText(d.name)}
              {d.backend === 'live' ? ' · Live' : ' · Snapshot'}
            </option>
          ))}
        </select>
        <span className="text-sm" aria-label={live ? 'Live' : `Snapshot ${takenAt ?? ''}`}>
          {live ? (
            <>
              Live{' '}
              <span aria-hidden="true" className="text-ok">
                ●
              </span>
            </>
          ) : (
            `Snapshot ${takenAt ?? ''}`
          )}
        </span>
        {listed?.writesAllowed === true && (
          <span
            className="rounded-sm border border-warn px-1 text-sm text-warn"
            title="Every change still asks you first"
          >
            Writes on
          </span>
        )}
        <button
          type="button"
          className={button}
          aria-disabled={!connected || snapping.busy ? true : undefined}
          onClick={takeSnapshot}
        >
          {snapping.busy ? 'Taking snapshot…' : 'Snapshot'}
        </button>
        <button
          ref={menuButton}
          type="button"
          className={button}
          aria-label="More database options"
          aria-expanded={menuOpen}
          aria-controls="db-menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
      {menuOpen && (
        <SavedQueriesMenu
          saved={saved}
          onClose={() => {
            setMenuOpen(false);
            menuButton.current?.focus();
          }}
          onRun={(q) => {
            setMenuOpen(false);
            setSql(q.sql);
            setView('sql');
            setRunNow(true);
          }}
        />
      )}
      {snapshot !== undefined && !snapping.busy && snapping.error === undefined && (
        <p role="status" className="px-2 text-sm">
          Snapshot {clock(snapshot.takenAt, 'minutes')} taken
        </p>
      )}
      {snapping.error !== undefined && (
        <p role="alert" className="px-2 text-sm text-error">
          <VisibleText text={snapping.error} />
        </p>
      )}
      {!live && (
        <p className="flex flex-wrap items-center gap-1 px-2 text-sm">
          <span>Snapshot from {takenAt ?? '—'} — this is a copy, not live.</span>
          <button
            type="button"
            className={linkButton}
            aria-disabled={refreshing || !connected ? true : undefined}
            onClick={refreshCopy}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        {!wide && (
          <TablePicker
            tables={tables}
            selected={table?.name}
            disabled={!connected || tables.length === 0}
            onSelect={(n) => openTable(n)}
          />
        )}
        {viewSwitcher}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-border">
        {wide && tables.length > 0 && (
          <TableSidebar
            tables={tables}
            selected={view === 'table' ? table?.name : undefined}
            disabled={!connected}
            onSelect={(n) => openTable(n)}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
      </div>
      <div className="sr-only" aria-live="polite">
        <span key={message.id}>{message.text}</span>
      </div>
      {toast !== undefined && (
        <p
          role="status"
          className="absolute right-2 bottom-2 left-2 z-30 rounded-md border border-border bg-surface p-2 shadow"
        >
          <VisibleText text={toast} />
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>;
}
