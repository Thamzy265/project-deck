import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'android-adb',
    include: ['src/**/*.test.ts'],
  },
});
