import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db-drift',
    include: ['src/**/*.test.ts'],
  },
});
