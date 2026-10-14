import type { SearchReply, SearchRequest } from './run-search.js';
import { runSearch } from './run-search.js';

export type { SearchReply, SearchRequest };

/** Lead decision (BUG-M2-T1): one filter pass may run this long before it is stopped. */
export const SEARCH_BUDGET_MS = 200;

export type SearchResult =
  | { ok: true; keys: number[] }
  /** `cancelled`: a newer search replaced it. `timeout`: past the budget, stopped. */
  | { ok: false; reason: 'timeout' | 'cancelled' | 'error' };

/** Runs the log search regex off the page's thread. */
export interface RegexRunner {
  run(pattern: string, items: [number, string][]): Promise<SearchResult>;
  dispose(): void;
}

/** The part of a browser Worker the runner uses. */
export interface WorkerLike {
  onmessage: ((event: { data: SearchReply }) => void) | null;
  onerror: (() => void) | null;
  postMessage(request: SearchRequest): void;
  terminate(): void;
}

/**
 * One worker, one search at a time. A regex can't be interrupted inside a match, so a
 * search past the budget is stopped by terminating the worker; a new one replaces it.
 */
export function createWorkerRunner(
  make: () => WorkerLike,
  budgetMs: number = SEARCH_BUDGET_MS,
): RegexRunner {
  let worker = make();
  let nextId = 0;
  let pending: { id: number; finish: (r: SearchResult) => void } | undefined;

  const replaceWorker = (): void => {
    worker.terminate();
    worker = make();
  };

  return {
    run(pattern, items) {
      if (pending !== undefined) {
        // The worker may be stuck on it; a fresh one is cheaper than waiting.
        pending.finish({ ok: false, reason: 'cancelled' });
        replaceWorker();
      }
      const id = ++nextId;
      return new Promise<SearchResult>((resolve) => {
        const timer = setTimeout(() => {
          finish({ ok: false, reason: 'timeout' });
          replaceWorker();
        }, budgetMs);
        const finish = (result: SearchResult): void => {
          if (pending?.id !== id) return;
          pending = undefined;
          clearTimeout(timer);
          resolve(result);
        };
        pending = { id, finish };
        worker.onmessage = ({ data }) => {
          if (data.id !== id) return;
          finish('keys' in data ? { ok: true, keys: data.keys } : { ok: false, reason: 'error' });
        };
        worker.onerror = () => {
          finish({ ok: false, reason: 'error' });
          replaceWorker();
        };
        worker.postMessage({ id, pattern, items });
      });
    },
    dispose() {
      pending?.finish({ ok: false, reason: 'cancelled' });
      worker.terminate();
    },
  };
}

/** Runs on the calling thread. For tests, where jsdom has no Worker. */
export function createInlineRunner(): RegexRunner {
  return {
    run(pattern, items) {
      const reply = runSearch({ id: 0, pattern, items });
      return Promise.resolve(
        'keys' in reply ? { ok: true, keys: reply.keys } : { ok: false, reason: 'error' },
      );
    },
    dispose: () => undefined,
  };
}
