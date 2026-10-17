import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMedia } from './useMedia.js';

function Probe({ n }: { n: number }) {
  return <span>{`${String(useMedia('(min-width: 1px)', false))} ${n}`}</span>;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('useMedia (review R11)', () => {
  it('listens once, not again on every render', () => {
    const add = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: add, removeEventListener: vi.fn() }),
    });
    const view = render(<Probe n={1} />);
    for (let n = 2; n < 6; n++) view.rerender(<Probe n={n} />);
    expect(view.container.textContent).toBe('true 5');
    expect(add).toHaveBeenCalledTimes(1);
  });
});
