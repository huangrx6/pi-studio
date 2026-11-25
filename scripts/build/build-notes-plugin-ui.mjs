#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('./notes-plugin-ui', import.meta.url));
const outDir = fileURLToPath(new URL('../../assets/official-plugins/packages/notes-library/extension/ui', import.meta.url));

await build({
  configFile: false,
  base: './',
  root,
  plugins: [react()],
  build: { target: 'es2022', outDir, emptyOutDir: true, assetsInlineLimit: 0 },
});
