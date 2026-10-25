import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'plugin',
      { test: { name: 'scripts', include: ['scripts/**/*.test.mjs'] } },
    ],
  },
});
