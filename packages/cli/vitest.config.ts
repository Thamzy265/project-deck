import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
