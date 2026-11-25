import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';

const directory = fileURLToPath(new URL('../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url));
const assetPath = 'excalidraw-assets/fonts';
const excalidrawModule = /[/\\]@excalidraw[/\\]excalidraw[/\\]dist[/\\].+\.js$/;
const desktopCloseGuard = /\b\w+\s*&&\s*((?:\/\* @__PURE__ \*\/\s*)?\w+\(\s*"button",\s*\{\s*className:\s*"Dialog__close")/;

function adaptExcalidrawModule(code: string) {
  let adapted = code;
  if (adapted.includes('ASSETS_FALLBACK_URL')) {
    // Excalidraw 0.18 adds a CDN source even with a local asset path.
    const localOnly = adapted.replace(/\b\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/g, 'void 0');
    if (localOnly === adapted) throw new Error('Excalidraw changed its font fallback; review the local asset integration.');
    adapted = localOnly;
  }
  if (/className:\s*"Dialog__close"/.test(adapted)) {
    // Keep the native close action and focus return on desktop as well as mobile.
    const withClose = adapted.replace(desktopCloseGuard, '$1');
    if (withClose === adapted) throw new Error('Excalidraw changed its dialog close button; review the desktop dialog integration.');
    adapted = withClose;
  }
  return adapted;
}

export function excalidrawIntegration(): Plugin {
  const fonts = new Map<string, string>();
  for (const family of readdirSync(directory, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const name of readdirSync(path.join(directory, family.name))) {
      if (name.endsWith('.woff2')) fonts.set(`${family.name}/${name}`, path.join(directory, family.name, name));
    }
  }
  return {
    name: 'pi-studio-excalidraw',
    enforce: 'pre',
    config: () => ({
      optimizeDeps: {
        include: ['@excalidraw/excalidraw'],
        esbuildOptions: {
          plugins: [{
            name: 'pi-studio-excalidraw',
            setup(build) {
              // Prebundle Excalidraw with its CommonJS dependencies in dev.
              build.onLoad({ filter: excalidrawModule }, ({ path: filename }) => {
                const code = readFileSync(filename, 'utf8');
                return { contents: adaptExcalidrawModule(code), loader: 'js', resolveDir: path.dirname(filename) };
              });
            },
          }],
        },
      },
    }),
    transform(code, id) {
      if (!excalidrawModule.test(id)) return;
      const adapted = adaptExcalidrawModule(code);
      if (adapted !== code) return { code: adapted, map: null };
    },
    configureServer(server) {
      server.middlewares.use(`/${assetPath}`, (request, response, next) => {
        const file = fonts.get((request.url ?? '').slice(1));
        if (!file) return next();
        response.setHeader('Content-Type', 'font/woff2');
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [name, file] of fonts) {
        this.emitFile({ type: 'asset', fileName: `${assetPath}/${name}`, source: readFileSync(file) });
      }
    },
  };
}
