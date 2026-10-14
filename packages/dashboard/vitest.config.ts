import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'dashboard',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // CSS is skipped in tests, except the tokens file the contrast check reads.
    css: { include: [/tokens\.css/] },
  },
});
