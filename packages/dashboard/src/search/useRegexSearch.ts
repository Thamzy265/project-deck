import { useEffect, useRef, useState } from 'react';
import type { KeyedLog } from '../state/logs.js';
import { searchText } from '../state/logs.js';
import type { RegexRunner } from './runner.js';

export type SearchStatus = 'idle' | 'searching' | 'done' | 'too-slow' | 'error';

export interface RegexSearch {
  shown: KeyedLog[];
  status: SearchStatus;
}

/** The last answer, with the pattern that produced it. */
interface Answer {
  pattern: string;
  keys: ReadonlySet<number> | undefined;
  problem: 'too-slow' | 'error' | undefined;
}

/**
 * Filters `base` by `pattern` in the search worker. Results are only ever shown for the
 * pattern that produced them; until the current pattern answers, nothing is shown (never
 * the unfiltered list). A stopped pass keeps that pattern's last good result. New lines
 * arriving during a pass queue one more pass instead of cancelling it, so a chatty app
 * can't starve the search; a new pattern cancels at once.
 */
export function useRegexSearch(
  runner: RegexRunner,
  base: KeyedLog[],
  pattern: string,
): RegexSearch {
  const [answer, setAnswer] = useState<Answer | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const inFlight = useRef<{ id: number; pattern: string } | undefined>(undefined);
  const nextId = useRef(0);
  const dirty = useRef(false);
  const stoppedPattern = answer?.problem === 'too-slow' ? answer.pattern : undefined;

  useEffect(() => {
    // Don't run a pattern again just because new lines came: it was stopped once already.
    if (pattern === '' || pattern === stoppedPattern) return;
    if (inFlight.current?.pattern === pattern) {
      dirty.current = true;
      return;
    }
    const id = ++nextId.current;
    inFlight.current = { id, pattern };
    dirty.current = false;
    const items = base.map((e): [number, string] => [e.key, searchText(e)]);
    void runner.run(pattern, items).then((r) => {
      if (inFlight.current?.id !== id) return;
      inFlight.current = undefined;
      setAnswer((prev) => {
        const kept = prev?.pattern === pattern ? prev.keys : undefined;
        if (r.ok) return { pattern, keys: new Set(r.keys), problem: undefined };
        if (r.reason === 'timeout') return { pattern, keys: kept, problem: 'too-slow' };
        if (r.reason === 'error') return { pattern, keys: undefined, problem: 'error' };
        return prev;
      });
      if (dirty.current) {
        dirty.current = false;
        setTick((t) => t + 1);
      }
    });
  }, [runner, base, pattern, stoppedPattern, tick]);

  if (pattern === '') return { shown: base, status: 'idle' };
  if (answer?.pattern !== pattern) return { shown: [], status: 'searching' };
  const keys = answer.keys;
  const shown = keys === undefined ? [] : base.filter((e) => keys.has(e.key));
  return { shown, status: answer.problem ?? 'done' };
}
