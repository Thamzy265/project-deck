import type { SearchReply, SearchRequest, WorkerLike } from './runner.js';

/**
 * Starts the search worker. Vite turns this `new URL(…, import.meta.url)` into a separate
 * same-origin file under /assets (no blob: or data: URL), so the CSP allows it.
 */
export function openSearchWorker(): WorkerLike {
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
  const adapter: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (request: SearchRequest) => worker.postMessage(request),
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (event: MessageEvent<SearchReply>) =>
    adapter.onmessage?.({ data: event.data });
  worker.onerror = (event) => {
    // Handled by the runner (failed search, new worker); keep it out of the console.
    event.preventDefault();
    adapter.onerror?.();
  };
  return adapter;
}
