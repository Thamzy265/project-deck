import { useEffect, useRef, useState } from 'react';
import type { KeyedLog } from '../state/logs.js';
import { searchText } from '../state/logs.js';
import type { RegexRunner } from './runner.js';

export interface RegexSearch {
  shown: KeyedLog[];
  /** The last pass for this pattern ran past its budget and was stopped. */
  tooSlow: boolean;
}

/**
 * Filters `base` by `pattern` in the search worker. Until a pass answers, and after one
 * is stopped, the last good result stays on screen. New lines arriving during a pass
 * queue one more pass instead of cancelling it, so a chatty app can't starve the search;
 * a new pattern cancels at once.
 */
export function useRegexSearch(
  runner: RegexRunner,
  base: KeyedLog[],
  pattern: string,
): RegexSearch {
  const [result, setResult] = useState<ReadonlySet<number> | undefined>(undefined);
  const [slowPattern, setSlowPattern] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const inFlight = useRef<{ id: number; pattern: string } | undefined>(undefined);
  const nextId = useRef(0);
  const dirty = useRef(false);

  useEffect(() => {
    if (slowPattern !== undefined && pattern !== slowPattern) setSlowPattern(undefined);
  }, [pattern, slowPattern]);

  useEffect(() => {
    if (pattern === '' || pattern === slowPattern) return;
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
      if (r.ok) setResult(new Set(r.keys));
      else if (r.reason === 'timeout') setSlowPattern(pattern);
      if (dirty.current) {
        dirty.current = false;
        setTick((t) => t + 1);
      }
    });
  }, [runner, base, pattern, slowPattern, tick]);

  if (pattern === '') return { shown: base, tooSlow: false };
  const shown = result === undefined ? base : base.filter((e) => result.has(e.key));
  return { shown, tooSlow: slowPattern === pattern };
}
