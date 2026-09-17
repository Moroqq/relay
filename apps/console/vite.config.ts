import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console server serves the built files itself, so the browser talks to one
// origin and the session cookie and CSRF header just work. In development the
// Vite server proxies API calls to it for the same reason.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    // Start the console with CONSOLE_ORIGIN=http://localhost:5173 so it accepts
    // changes coming through this proxy.
    proxy: { '/admin/api': 'http://127.0.0.1:3100' },
  },
});
