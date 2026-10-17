import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout. Give the virtual log list a 420 × 600 viewport and 20 px rows so
// it renders rows in component tests; real sizes are covered by the Playwright tests.
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 20 },
  offsetWidth: { configurable: true, get: () => 420 },
});
HTMLElement.prototype.getBoundingClientRect = () => DOMRect.fromRect({ width: 420, height: 600 });

// CodeMirror measures text ranges, which jsdom doesn't lay out either.
Range.prototype.getClientRects = () => {
  const list: DOMRect[] = [];
  return Object.assign(list, { item: () => null });
};
Range.prototype.getBoundingClientRect = () => DOMRect.fromRect({ width: 0, height: 0 });

afterEach(() => {
  cleanup();
});
