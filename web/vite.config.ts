import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = `http://127.0.0.1:${process.env.BE_PORT ?? 47821}`;

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: { outDir: path.resolve(here, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: collector, changeOrigin: true }, '/ws': { target: collector.replace('http', 'ws'), ws: true, changeOrigin: true } },
  },
});
