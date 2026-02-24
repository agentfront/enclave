import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 4200,
    open: true,
  },
  build: {
    outDir: '../../dist/apps/browser-demo',
    emptyOutDir: true,
  },
});
