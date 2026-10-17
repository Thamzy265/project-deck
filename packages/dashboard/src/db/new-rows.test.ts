import { describe, expect, it } from 'vitest';
import { seenNewRows, withNewRows } from './new-rows.js';

describe('the "N new rows" chip (lead decision B4-6)', () => {
  it('adds up new rows out of view across changes, once each', () => {
    let pending = withNewRows(new Set(), ['a', 'b'], new Set(['b']));
    expect([...pending]).toEqual(['a']);
    pending = withNewRows(pending, ['c', 'a'], new Set());
    expect([...pending]).toEqual(['a', 'c']);
  });

  it('forgets the rows the user has scrolled to', () => {
    const pending = new Set(['a', 'c']);
    expect([...seenNewRows(pending, new Set(['c', 'x']))]).toEqual(['a']);
    // Nothing seen: the same set, so nothing redraws.
    expect(seenNewRows(pending, new Set(['x']))).toBe(pending);
  });
});
