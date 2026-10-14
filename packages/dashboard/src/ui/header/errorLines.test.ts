import type { LogEntry } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import type { DeckAction, DeckState } from '../../state/deck.js';
import { deckReducer, initialState } from '../../state/deck.js';
import { errorLines } from './ResultChip.js';

const run = (...actions: DeckAction[]): DeckState => actions.reduce(deckReducer, initialState);
const line = (seq: number, ts: number, message: string, level: LogEntry['level'] = 'error') => ({
  seq,
  ts,
  level,
  source: 'app' as const,
  message,
});

/** Review C2: the device clock is far behind the computer's in these tests. */
describe('lines since the last reload', () => {
  it('takes error lines logged after our reload started, by daemon order', () => {
    const s = run(
      { type: 'logs-append', entries: [line(5, 9_999_999, 'error before')] },
      { type: 'action-start', kind: 'reload', at: 1_000 },
      { type: 'logs-append', entries: [line(6, 3, 'error after')] },
      {
        type: 'action-done',
        result: { ok: false, reason: 'compile-error', message: 'see logs' },
        at: 1_100,
      },
    );
    const result = s.lastResult;
    if (result === null) throw new Error('no result');
    expect(errorLines(s, result)).toEqual(['error after']);
  });

  it('marks a reload by others where the page saw it', () => {
    const s = run(
      { type: 'logs-append', entries: [line(1, 50, 'old', 'info')] },
      {
        type: 'reloaded',
        result: { ok: false, reason: 'compile-error', message: 'x', source: 'external' },
        at: 9_000_000,
      },
      { type: 'logs-append', entries: [line(2, 1, 'new error')] },
    );
    const result = s.lastResult;
    if (result === null) throw new Error('no result');
    expect(result.mark).toEqual({ seq: 2, key: 1 });
    expect(errorLines(s, result)).toEqual(['new error']);
  });
});
