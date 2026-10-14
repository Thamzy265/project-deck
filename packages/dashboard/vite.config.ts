import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The daemon's CSP is `default-src 'self'`: no inline scripts, styles or data: URLs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
