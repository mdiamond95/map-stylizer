import { defineConfig } from 'vite';

// GitHub Pages serves the app from /map-stylizer/.
export default defineConfig({
  base: process.env.BASE_PATH || '/map-stylizer/',
  worker: { format: 'es' },
  // Shown in the app header so it's easy to tell which version is loaded.
  define: { __BUILD__: JSON.stringify(`${(process.env.BUILD_ID || 'local').slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`) },
  build: { target: 'safari16', chunkSizeWarningLimit: 1500 }
});
