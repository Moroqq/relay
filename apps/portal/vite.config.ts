import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the portal service under /app/, on the same origin as its API.
// In development this server forwards API calls to the portal on 3200; start
// the portal with PORTAL_ORIGINS including http://127.0.0.1:5175.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/portal/api': 'http://127.0.0.1:3200' } },
});
