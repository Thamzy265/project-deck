import { isAtLeast } from '@project-deck/core';
import { useEffect, useState } from 'react';
import type { DeckState, LastResult } from '../../state/deck.js';
import { useDeck } from '../../state/DeckProvider.js';
import { isAfter } from '../../state/logs.js';
import { clock, resultText } from '../format.js';
import { button, linkButton } from '../styles.js';

/** A success stays green this long, then turns into a neutral "Last reload 12:01". */
export const FRESH_MS = 10_000;
const MAX_ERROR_LINES = 3;

/** The first error log lines since the reload started, or the failure message's lines. */
export function errorLines(state: DeckState, result: LastResult): string[] {
  const fromLogs = state.logs.entries
    .filter((e) => isAfter(e, result.mark) && isAtLeast(e.level, 'error'))
    .slice(0, MAX_ERROR_LINES)
    .map((e) => e.message.split('\n')[0] ?? '');
  if (fromLogs.length > 0) return fromLogs;
  return (result.message ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_ERROR_LINES);
}

function useFresh(result: LastResult | null): boolean {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (result === null || !result.ok) return;
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), FRESH_MS);
    return () => clearTimeout(timer);
  }, [result]);
  return fresh;
}

const chip = 'inline-flex min-h-6 items-center rounded-md border px-2 text-sm';

function Failed({ result, onShowInLogs }: { result: LastResult; onShowInLogs: () => void }) {
  const { state } = useDeck();
  const [open, setOpen] = useState(true);
  const lines = errorLines(state, result);
  const count = lines.length === 1 ? '1 error' : `${lines.length} errors`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className={`${button} self-start border-error text-error`}
        aria-expanded={open}
        aria-controls="reload-errors"
        aria-label={`Last ${result.kind}: failed, ${count}`}
        onClick={() => setOpen(!open)}
      >
        {resultText(result)}
      </button>
      {open && (
        <div id="reload-errors" className="min-w-0 text-sm">
          <p>
            {result.kind === 'reload' ? 'Reload' : 'Restart'} failed. Check the errors below or in
            Logs.
          </p>
          <ul className="font-mono text-error">
            {lines.map((line, i) => (
              <li key={i} className="truncate" title={line}>
                {line}
              </li>
            ))}
          </ul>
          <button type="button" className={linkButton} onClick={onShowInLogs}>
            Show in Logs
          </button>
        </div>
      )}
    </div>
  );
}

function Chip({ onShowInLogs }: { onShowInLogs: () => void }) {
  const { state } = useDeck();
  const result = state.lastResult;
  const fresh = useFresh(result);
  // Hidden while offline (UI spec, "Result chip").
  if (state.connection.kind !== 'connected') return null;
  if (result === null)
    return <span className={`${chip} border-border text-muted`}>No reload yet</span>;
  if (!result.ok)
    return <Failed key={result.startedAt} result={result} onShowInLogs={onShowInLogs} />;
  const text = fresh
    ? resultText(result)
    : `Last ${result.kind} ${clock(result.startedAt, 'minutes')}`;
  return (
    <span className={`${chip} ${fresh ? 'border-ok text-ok' : 'border-border text-muted'}`}>
      {text}
    </span>
  );
}

/** The live region stays mounted so screen readers announce each new result once. */
export function ResultChip({ onShowInLogs }: { onShowInLogs: () => void }) {
  return (
    <div role="status" className="min-w-0 basis-full pane:basis-auto">
      <Chip onShowInLogs={onShowInLogs} />
    </div>
  );
}
