import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  root: 'web',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  build: { outDir: '../web-dist', emptyOutDir: true },
});
