import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith('/src/generated/catalog.json')) return 'catalog';
          if (/\/node_modules\/(?:react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
});
