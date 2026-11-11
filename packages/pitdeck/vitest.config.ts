import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'pitdeck',
    include: ['src/**/*.test.ts'],
    // npm pack and the bundle's own start-up take a few seconds on CI runners.
    testTimeout: 60_000,
  },
});
