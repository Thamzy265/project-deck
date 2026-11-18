import { describe, expect, it } from 'vitest';
import { IN_PITDECK_BUNDLE } from './bundle.js';

describe('IN_PITDECK_BUNDLE', () => {
  it('is false outside the pitdeck bundle (tsc output and tests)', () => {
    // Only packages/pitdeck/build.mjs defines __PITDECK_BUNDLE__; the bundle side is
    // checked by packages/pitdeck/src/bundle-no-fallback.test.ts.
    expect(IN_PITDECK_BUNDLE).toBe(false);
  });
});
