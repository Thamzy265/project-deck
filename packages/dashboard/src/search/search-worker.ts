/**
 * Web Worker for the log search. Vite emits it as its own file under /assets, so the
 * daemon's CSP (`default-src 'self'`) allows it without blob: or inline code.
 */
import type { SearchReply, SearchRequest } from './run-search.js';
import { runSearch } from './run-search.js';

// The DOM lib types `self` as Window; inside a worker it is the worker's global scope.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(reply: SearchReply): void;
};

scope.onmessage = (event) => {
  scope.postMessage(runSearch(event.data));
};
