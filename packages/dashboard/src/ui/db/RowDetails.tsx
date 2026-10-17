import type { Cell, ColumnInfo, DbEditRequest, TableInfo } from '@project-deck/core';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import type { Param } from '../../db/cells.js';
import { cellCopyText, cellText, paramLabel, visibleText } from '../../db/cells.js';
import { editErrorText } from '../../db/copy.js';
import { rowKeyOrReason } from '../../db/keys.js';
import type { Built, ColumnValue } from '../../db/sql-build.js';
import { deleteRow, inputParam, insertRow, quoteIdent, updateRow } from '../../db/sql-build.js';
import { useDbClient } from '../../state/DbProvider.js';
import { button, field, linkButton } from '../styles.js';
import { VisibleText } from './VisibleText.js';
import { WriteConfirmDialog } from './WriteConfirmDialog.js';

/** Editing (UI spec): hidden when writes are off; snapshots say they are read-only. */
export type WriteMode = { kind: 'off' } | { kind: 'snapshot' } | { kind: 'on' };

function copy(text: string): void {
  try {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  } catch {
    // No clipboard here; copying is best effort.
  }
}

type Fresh =
  | { status: 'loading' }
  | { status: 'ready'; columns: string[]; row: Cell[] }
  | { status: 'gone' }
  | { status: 'new' }
  | { status: 'error'; message: string };

interface FieldState {
  text: string;
  isNull: boolean;
}

type Mode = { kind: 'view' } | { kind: 'edit' } | { kind: 'add' };

export interface RowDetailsProps {
  db: string;
  table: TableInfo;
  columns: string[];
  /** Undefined: a new row, from the table's "Add row" button. */
  row: Cell[] | undefined;
  writes: WriteMode;
  connected: boolean;
  onClose: () => void;
  onFollowKey: (table: string, column: string, value: Param) => void;
  onToast: (text: string) => void;
}

function startFields(
  columns: ColumnInfo[],
  names: string[],
  row: Cell[] | undefined,
): FieldState[] {
  return columns.map((c) => {
    if (row === undefined) return { text: '', isNull: false };
    const cell = row[names.indexOf(c.name)] ?? null;
    return { text: cell === null ? '' : cellCopyText(cell), isNull: cell === null };
  });
}

/**
 * Every column of one row with its full value (UI spec, row details). The row is read
 * again by its key, so the values are current. With writes on, the user's own edits
 * start here: Edit, Delete row and Add row, each through the confirm dialog.
 */
export function RowDetails(p: RowDetailsProps) {
  const client = useDbClient();
  const { db, table } = p;
  const adding = p.row === undefined;
  const checked = p.row === undefined ? undefined : rowKeyOrReason(table, p.columns, p.row);
  const key = checked !== undefined && 'key' in checked ? checked.key : undefined;
  const noEdit = checked !== undefined && 'reason' in checked ? checked.reason : undefined;
  const [fresh, setFresh] = useState<Fresh>(
    p.row === undefined
      ? { status: 'new' }
      : key === undefined
        ? { status: 'ready', columns: p.columns, row: p.row }
        : { status: 'loading' },
  );
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<Mode>(adding ? { kind: 'add' } : { kind: 'view' });
  const [fields, setFields] = useState<FieldState[]>(() =>
    adding ? startFields(table.columns, p.columns, undefined) : [],
  );
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | undefined>();
  const [request, setRequest] = useState<DbEditRequest | undefined>();
  const [afterRun, setAfterRun] = useState<'close' | 'view'>('view');
  const heading = useRef<HTMLHeadingElement>(null);
  /** The button that opened the confirm dialog: focus goes back to it (UI spec). */
  const trigger = useRef<HTMLElement | null>(null);
  const keyText = JSON.stringify(key?.values);

  const form = useRef<HTMLFormElement>(null);
  /** Edit or Add row in the panel: Cancel gives focus back to it (QA B4-2). */
  const opener = useRef<'edit' | 'add'>('edit');
  const editButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const backToOpener = useRef(false);

  // The form takes focus where it opens: its first field (WCAG 2.4.3, QA B4-2).
  useEffect(() => {
    if (mode.kind !== 'view') {
      form.current?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
      return;
    }
    if (backToOpener.current) {
      backToOpener.current = false;
      // The buttons are drawn again in view mode: focus the new one.
      (opener.current === 'edit' ? editButton : addButton).current?.focus();
    }
  }, [mode.kind]);
  useEffect(() => {
    if (!adding) heading.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (key === undefined) return;
    let cancelled = false;
    setFresh({ status: 'loading' });
    const where = key.columns.map((c) => `${quoteIdent(c)} IS ?`).join(' AND ');
    client
      .query({
        db,
        sql: `SELECT * FROM ${quoteIdent(table.name)} WHERE ${where} LIMIT 1`,
        params: key.values,
        limit: 1,
      })
      .then(
        (res) => {
          if (cancelled) return;
          const row = res.rows[0];
          setFresh(
            row === undefined ? { status: 'gone' } : { status: 'ready', columns: res.columns, row },
          );
        },
        (err: unknown) => {
          if (!cancelled) setFresh({ status: 'error', message: asDbApiError(err).message });
        },
      );
    return () => {
      cancelled = true;
    };
    // keyText stands for the key's values.
  }, [client, db, table.name, keyText, retry]);

  const names = fresh.status === 'ready' ? fresh.columns : p.columns;
  const row = fresh.status === 'ready' ? fresh.row : undefined;
  const canWrite = p.writes.kind === 'on' && table.kind === 'table';

  const ask = async (built: Built, after: 'close' | 'view') => {
    setEditError(undefined);
    setSaving(true);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      setRequest(await client.requestEdit({ db, sql: built.sql, params: built.params }));
      setAfterRun(after);
    } catch (err) {
      const e = asDbApiError(err);
      setEditError(editErrorText({ code: e.code, error: e.message, detail: e.detail }));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    // Enter submits the form too: never a second request, and nothing offline (R8).
    if (saving || !p.connected) return;
    const values: ColumnValue[] = [];
    table.columns.forEach((c, i) => {
      const f = fields[i];
      if (f === undefined) return;
      const value: Param = f.isNull ? null : inputParam(f.text, c.type);
      if (mode.kind === 'add') {
        if (f.isNull || f.text !== '') values.push({ column: c.name, value });
        return;
      }
      const cell = row?.[names.indexOf(c.name)] ?? null;
      if (typeof cell === 'object' && cell !== null && cell.type === 'blob') return;
      const was = cell === null ? null : cellCopyText(cell);
      const now = f.isNull ? null : f.text;
      if (was !== now) values.push({ column: c.name, value });
    });
    if (mode.kind === 'add') {
      void ask(insertRow(table.name, values), adding ? 'close' : 'view');
      return;
    }
    if (key === undefined) return;
    if (values.length === 0) {
      setMode({ kind: 'view' });
      return;
    }
    void ask(updateRow(table.name, key, values), 'view');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && request === undefined) {
      e.preventDefault();
      p.onClose();
    }
  };

  const title = adding
    ? `${table.name}: new row`
    : key === undefined
      ? `${table.name} row`
      : `${table.name}: ${key.columns.map((c, i) => `${c} ${paramLabel(key.values[i] ?? null)}`).join(', ')}`;

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="row-details-title"
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-10 flex flex-col border-border bg-bg lg:left-auto lg:w-96 lg:border-l"
    >
      <div className="flex items-center gap-2 border-b border-border p-2">
        <h2
          id="row-details-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate font-medium"
          title={visibleText(title)}
        >
          <VisibleText text={title} />
        </h2>
        <button type="button" className={button} onClick={p.onClose}>
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {fresh.status === 'loading' && <p role="status">Loading row…</p>}
        {fresh.status === 'gone' && <p role="alert">Row not found</p>}
        {fresh.status === 'error' && (
          <p role="alert">
            Couldn't read this row: {fresh.message}{' '}
            <button type="button" className={linkButton} onClick={() => setRetry((n) => n + 1)}>
              Retry
            </button>
          </p>
        )}
        {mode.kind === 'view' && row !== undefined && (
          <dl className="flex flex-col gap-2">
            {names.map((name, i) => {
              const cell = row[i] ?? null;
              const info = table.columns.find((c) => c.name === name);
              const fk = table.foreignKeys.find((f) => f.from === name);
              const { text, muted } = cellText(cell);
              return (
                <div key={i} className="flex flex-col gap-1 border-b border-border/30 pb-2">
                  <dt className="flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span className="font-medium text-text">
                      <VisibleText text={name} />
                    </span>
                    {info?.type ? <span>{info.type}</span> : null}
                    <span className="flex-1" />
                    <button
                      type="button"
                      className={button}
                      aria-label={`Copy ${visibleText(name)}`}
                      onClick={() => copy(cellCopyText(cell))}
                    >
                      Copy
                    </button>
                  </dt>
                  <dd
                    className={`max-h-60 overflow-auto font-mono text-sm whitespace-pre-wrap wrap-anywhere ${muted ? 'text-muted' : ''}`}
                  >
                    <VisibleText text={text} multiline />
                  </dd>
                  {fk !== undefined &&
                    cell !== null &&
                    (typeof cell !== 'object' || cell.type === 'int') && (
                      <dd>
                        <button
                          type="button"
                          className={linkButton}
                          onClick={() =>
                            p.onFollowKey(
                              fk.table,
                              fk.to ?? '',
                              typeof cell === 'object' ? { type: 'int', value: cell.value } : cell,
                            )
                          }
                        >
                          Open <VisibleText text={fk.table} /> row
                        </button>
                      </dd>
                    )}
                </div>
              );
            })}
          </dl>
        )}
        {mode.kind !== 'view' && (
          <form
            ref={form}
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {table.columns.map((c, i) => {
              const f = fields[i] ?? { text: '', isNull: false };
              const cell = row?.[names.indexOf(c.name)];
              const blob = typeof cell === 'object' && cell !== null && cell.type === 'blob';
              const id = `edit-${i}`;
              return (
                <div key={c.name} className="flex flex-col gap-1">
                  <label htmlFor={id} className="text-sm">
                    <VisibleText text={c.name} /> <span className="text-muted">{c.type}</span>
                  </label>
                  {blob && mode.kind === 'edit' ? (
                    <p className="text-sm text-muted">{cellText(cell).text}</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        id={id}
                        className={`${field} min-w-0 flex-1 font-mono`}
                        value={f.text}
                        disabled={f.isNull}
                        placeholder={
                          mode.kind === 'add' && c.default !== null
                            ? `default ${c.default}`
                            : undefined
                        }
                        onChange={(e) =>
                          setFields(
                            fields.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                          )
                        }
                      />
                      <label className="flex min-h-6 items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-accent"
                          checked={f.isNull}
                          aria-label={`${visibleText(c.name)} is null`}
                          onChange={(e) =>
                            setFields(
                              fields.map((x, j) =>
                                j === i ? { ...x, isNull: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                        null
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex gap-2">
              <button
                type="submit"
                className={button}
                aria-disabled={saving || !p.connected ? true : undefined}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  if (adding) {
                    p.onClose();
                    return;
                  }
                  backToOpener.current = true;
                  setMode({ kind: 'view' });
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {editError !== undefined && (
          <p role="alert" className="mt-2 text-error">
            {editError}
          </p>
        )}
      </div>
      {p.writes.kind === 'snapshot' && (
        <p className="border-t border-border p-2 text-sm text-muted">Snapshots are read-only</p>
      )}
      {canWrite && mode.kind === 'view' && (
        <div className="flex flex-wrap gap-2 border-t border-border p-2">
          {saving && <span role="status">Saving…</span>}
          <button
            ref={editButton}
            type="button"
            className={button}
            aria-disabled={
              row === undefined || key === undefined || !p.connected ? true : undefined
            }
            title={noEdit}
            onClick={() => {
              if (row === undefined || key === undefined || !p.connected) return;
              setFields(startFields(table.columns, names, row));
              opener.current = 'edit';
              setMode({ kind: 'edit' });
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className={button}
            aria-disabled={key === undefined || saving || !p.connected ? true : undefined}
            title={noEdit}
            onClick={() => {
              if (key !== undefined && !saving && p.connected)
                void ask(deleteRow(table.name, key), 'close');
            }}
          >
            Delete row
          </button>
          <button
            ref={addButton}
            type="button"
            className={button}
            aria-disabled={!p.connected ? true : undefined}
            onClick={() => {
              if (!p.connected) return;
              setFields(startFields(table.columns, names, undefined));
              opener.current = 'add';
              setMode({ kind: 'add' });
            }}
          >
            Add row
          </button>
        </div>
      )}
      {request !== undefined && (
        <WriteConfirmDialog
          request={request}
          connected={p.connected}
          onDone={(changes) => {
            setRequest(undefined);
            if (changes === undefined) {
              const back = trigger.current;
              (back?.isConnected === true ? back : heading.current)?.focus();
              return;
            }
            p.onToast(`${changes} ${changes === 1 ? 'row' : 'rows'} changed`);
            setMode({ kind: 'view' });
            if (afterRun === 'close') p.onClose();
            else {
              setRetry((n) => n + 1);
              heading.current?.focus();
            }
          }}
        />
      )}
    </section>
  );
}
