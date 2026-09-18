import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// A static site: the build is plain files any web server can hand out. The
// application form posts to the merchant portal and "Log in" opens it; both
// live on the same origin in production (/portal/api/ and /app/), and in
// development this server forwards them to the portal on 3200.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { main: page('./index.html'), access: page('./access/index.html') } },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/portal/api': 'http://127.0.0.1:3200', '/app': 'http://127.0.0.1:3200' },
  },
});
