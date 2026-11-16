// Ship only the theme's file associations and their SVG assets. Vite gives
// each SVG a local URL that also works from Electron's packaged file:// page.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const theme = require('material-icon-theme/dist/material-icons.json') as {
  file: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  light: { fileNames: Record<string, string>; fileExtensions: Record<string, string> };
  iconDefinitions: Record<string, { iconPath: string }>;
};

export function materialFileTheme(): Plugin {
  const moduleId = 'virtual:studio-file-icons';
  const iconDirectory = join(dirname(require.resolve('material-icon-theme/package.json')), 'icons');
  let development = false;
  return {
    name: 'studio-file-icons',
    configResolved(config) { development = config.command === 'serve'; },
    resolveId(id) { if (id === moduleId) return '\0' + id; },
    load(id) {
      if (id !== '\0' + moduleId) return;
      const assets = new Set([theme.file, 'github-actions-workflow']);
      const lightIcons: Record<string, string> = {};
      const source: string[] = [];
      for (const group of ['fileNames', 'fileExtensions'] as const) {
        const entries = Object.entries(theme[group]).map(([key, icon]) => {
          assets.add(icon);
          const light = theme.light[group][key];
          if (light) {
            assets.add(light);
            lightIcons[icon] = light;
          }
          return [key.toLowerCase(), icon];
        });
        source.push(`export const ${group} = new Map(${JSON.stringify(entries)});`);
      }
      source.push(`export const lightIcons = ${JSON.stringify(lightIcons)};`);
      const urls = [...assets].map((icon, index) => {
        const file = basename(theme.iconDefinitions[icon].iconPath);
        // The dev server can serve the installed SVG directly, without a JS request per icon.
        if (development) return `${JSON.stringify(icon)}:${JSON.stringify('/@fs/' + normalizePath(join(iconDirectory, file)))}`;
        source.push(`import url${index} from "material-icon-theme/icons/${file}?url&no-inline";`);
        return `${JSON.stringify(icon)}:url${index}`;
      });
      source.push(`export const urls = {${urls.join(',')}};`);
      return source.join('\n');
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/material-icon-theme-LICENSE.txt',
        source: readFileSync(require.resolve('material-icon-theme/LICENSE')) });
    },
  };
}
