import type { DbEditRequest } from '@project-deck/core';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import { editErrorText } from '../../db/copy.js';
import { useDbClient } from '../../state/DbProvider.js';
import { Spinner } from '../Spinner.js';
import { button } from '../styles.js';
import { VisibleText } from './VisibleText.js';

/** UI spec: an unanswered confirm runs nothing after 60 s. */
export const CONFIRM_TTL_MS = 60_000;

function paramText(value: DbEditRequest['params'][number]): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return value.value;
  // As an SQL literal, inner quotes doubled, so a value reads one way only.
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return String(value);
}

type Phase =
  | { kind: 'asking' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string }
  | { kind: 'expired' };

/**
 * "Run this change?" (UI spec, write confirm). Shows the exact SQL and values with
 * control and bidi characters named, starts on Cancel, keeps focus inside, and Escape
 * cancels. Nothing runs until "Run change".
 */
export function WriteConfirmDialog({
  request,
  connected,
  onDone,
}: {
  request: DbEditRequest;
  connected: boolean;
  /** `changes` when the change ran; undefined when cancelled or not run. */
  onDone: (changes: number | undefined) => void;
}) {
  const client = useDbClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);

  useEffect(() => cancelRef.current?.focus(), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!answered.current) setPhase({ kind: 'expired' });
    }, CONFIRM_TTL_MS);
    return () => clearTimeout(timer);
  }, []);

  const lost = !connected && phase.kind !== 'running';
  const canRun = phase.kind === 'asking' && !lost;

  const cancel = () => {
    if (phase.kind === 'running') return;
    if (!answered.current) {
      answered.current = true;
      // Best effort: an unanswered request expires on its own anyway.
      client.cancelEdit(request.requestId).catch(() => undefined);
    }
    onDone(undefined);
  };

  const run = async () => {
    if (!canRun) return;
    answered.current = true;
    setPhase({ kind: 'running' });
    try {
      const { changes } = await client.confirmEdit({
        requestId: request.requestId,
        sql: request.sql,
        // Exactly what was shown: the daemon refuses anything else.
        params: request.params,
      });
      onDone(changes);
    } catch (err) {
      const e = asDbApiError(err);
      setPhase({
        kind: 'failed',
        message: editErrorText({ code: e.code, error: e.message, detail: e.detail }),
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(box.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const message =
    phase.kind === 'expired'
      ? 'Not run: no answer in 60 s'
      : lost
        ? 'Lost connection; the change did not run'
        : phase.kind === 'failed'
          ? phase.message
          : undefined;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-bg/80 p-2">
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="write-confirm-title"
        aria-describedby="write-confirm-sql"
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-lg flex-col gap-2 rounded-md border border-border bg-bg p-3"
      >
        <h2 id="write-confirm-title" className="text-lg font-medium">
          Run this change?
        </h2>
        <p className="text-sm">
          Database: <VisibleText text={request.db} />
        </p>
        <p className="text-sm">
          Table: <VisibleText text={request.tables.join(', ')} />
        </p>
        <pre
          id="write-confirm-sql"
          tabIndex={0}
          aria-label="The exact SQL"
          className="max-h-48 min-h-12 overflow-auto rounded-sm bg-surface p-2 font-mono text-sm whitespace-pre-wrap wrap-anywhere"
        >
          <VisibleText text={request.sql} multiline />
        </pre>
        {request.params.length > 0 && (
          <div className="text-sm">
            <p>Values</p>
            <ol
              tabIndex={0}
              aria-label="The values, in order"
              className="max-h-32 list-decimal overflow-auto pl-6 font-mono"
            >
              {request.params.map((v, i) => (
                <li key={i} className="wrap-anywhere">
                  <VisibleText text={paramText(v)} />
                </li>
              ))}
            </ol>
          </div>
        )}
        {phase.kind === 'running' && (
          <p role="status" className="flex items-center gap-2">
            <Spinner /> Running…
          </p>
        )}
        {message !== undefined && (
          <p role="alert" className="text-error">
            {message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={`${button} min-h-8 border-error text-error`}
            aria-disabled={canRun ? undefined : true}
            onClick={() => void run()}
          >
            Run change
          </button>
          <button
            ref={cancelRef}
            type="button"
            className={`${button} min-h-8`}
            aria-disabled={phase.kind === 'running' ? true : undefined}
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
