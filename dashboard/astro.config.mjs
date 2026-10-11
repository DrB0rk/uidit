import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  output: 'static',
  build: { assets: 'assets', outDir: './dist', emptyOutDir: true },
  devToolbar: { enabled: false },
  server: { port: 4322 },
});