import { defineConfig } from 'vite';
import { materialFileTheme } from './scripts/icons/material-file-theme';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: './',
  root: 'web',
  plugins: [react(), materialFileTheme()],
  html: command === 'serve' ? { cspNonce: 'pi-studio-dev' } : undefined,
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  // Electron supports ES2022. Older targets corrupt xterm 6's DECRQM handler
  // when lowering ||= and minifying, freezing output on Vim's mode query.
  // https://github.com/xtermjs/xterm.js/issues/5800
  build: { target: 'es2022', outDir: '../dist/renderer', emptyOutDir: true },
}));
