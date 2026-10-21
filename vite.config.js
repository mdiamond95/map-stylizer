import { defineConfig } from 'vite';

// GitHub Pages serves the app from /map-stylizer/.
export default defineConfig({
  base: process.env.BASE_PATH || '/map-stylizer/',
  worker: { format: 'es' },
  build: { target: 'safari16', chunkSizeWarningLimit: 1500 }
});
