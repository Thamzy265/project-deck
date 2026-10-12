import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'connector-dart',
    include: ['src/**/*.test.ts'],
  },
});
