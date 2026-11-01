import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The product site. Served from GitHub Pages under the repository name unless SITE_BASE says otherwise. */
export default defineConfig({
  root: here,
  base: process.env.SITE_BASE ?? '/Behind_Everything-/',
  plugins: [react()],
  build: { outDir: path.resolve(here, '../dist-site'), emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
});
