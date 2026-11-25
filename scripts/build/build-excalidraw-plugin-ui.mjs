#!/usr/bin/env node
/**
 * Builds the standalone Excalidraw plugin UI bundle directly into
 * `assets/official-plugins/packages/excalidraw/extension/ui/`.
 *
 * Keeping this build separate ensures Pi Studio's main renderer has zero
 * Excalidraw code or asset dependencies.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('./excalidraw-plugin-ui', import.meta.url));
const outDir = fileURLToPath(new URL('../../assets/official-plugins/packages/excalidraw/extension/ui', import.meta.url));
const fontsDir = fileURLToPath(new URL('../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url));
const excalidrawModule = /[/\\]@excalidraw[/\\]excalidraw[/\\]dist[/\\].+\.js$/;
const desktopCloseGuard = /\b\w+\s*&&\s*((?:\/\* @__PURE__ \*\/\s*)?\w+\(\s*"button",\s*\{\s*className:\s*"Dialog__close")/;

function adaptExcalidrawModule(code) {
  let adapted = code;
  if (adapted.includes('ASSETS_FALLBACK_URL')) {
    const localOnly = adapted.replace(/\b\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/g, 'void 0');
    if (localOnly === adapted) throw new Error('Excalidraw changed its font fallback; review local asset bundling.');
    adapted = localOnly;
  }
  if (/className:\s*"Dialog__close"/.test(adapted)) {
    const withClose = adapted.replace(desktopCloseGuard, '$1');
    if (withClose === adapted) throw new Error('Excalidraw changed its dialog close button.');
    adapted = withClose;
  }
  return adapted;
}

function excalidrawBundlePlugin() {
  const fonts = new Map();
  for (const family of readdirSync(fontsDir, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const name of readdirSync(path.join(fontsDir, family.name))) {
      if (name.endsWith('.woff2')) {
        fonts.set(`excalidraw-assets/fonts/${family.name}/${name}`, path.join(fontsDir, family.name, name));
      }
    }
  }
  return {
    name: 'pi-studio-excalidraw-plugin-bundle',
    enforce: 'pre',
    transform(code, id) {
      if (!excalidrawModule.test(id)) return;
      const adapted = adaptExcalidrawModule(code);
      if (adapted !== code) return { code: adapted, map: null };
    },
    generateBundle() {
      for (const [fileName, file] of fonts) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
  };
}

await build({
  configFile: false,
  base: './',
  root: rootDir,
  plugins: [react(), excalidrawBundlePlugin()],
  build: {
    target: 'es2022',
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});

console.log('Built standalone Excalidraw plugin UI ->', outDir);
