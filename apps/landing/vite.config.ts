import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A static site: the build is plain files any web server can hand out.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
