import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db-sqlite',
    include: ['src/**/*.test.ts'],
  },
});
