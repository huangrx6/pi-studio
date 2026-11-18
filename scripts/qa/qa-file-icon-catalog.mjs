import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Exercise the actual Vite asset pipeline and resolver, including the theme's
// compound extensions, scoped filenames and alternate light-theme artwork.
const require = createRequire(import.meta.url);
const theme = require('material-icon-theme/dist/material-icons.json');
const tracked = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error' });

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.route('**/__icon_audit', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' }));
  await page.goto(server.resolvedUrls.local[0] + '__icon_audit');
  const result = await page.evaluate(async ({ tracked, names, extensions }) => {
    const { fileIconId } = await import('/src/shared/file-icon.ts');
    const { urls, lightIcons } = await import('/@id/__x00__virtual:studio-file-icons');
    const missing = path => fileIconId(path) === 'file' || !urls[fileIconId(path)];
    const unknownFiles = tracked.filter(missing);
    const unknownRules = [...names.map(name => 'audit/' + name), ...extensions.map(ext => 'audit/probe.' + ext)].filter(missing);
    const entries = Object.entries(urls);
    for (let offset = 0; offset < entries.length; offset += 25) {
      await Promise.all(entries.slice(offset, offset + 25).map(async ([id, url]) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!image.naturalWidth) throw Error('Empty icon ' + id);
      }));
    }
    return { unknownFiles, unknownRules, assets: entries.length, lightVariants: Object.keys(lightIcons).length };
  }, { tracked, names: Object.keys(theme.fileNames), extensions: Object.keys(theme.fileExtensions) });
  assert.deepEqual(result.unknownRules, []);
  console.log(JSON.stringify({ tracked: tracked.length, ...result }));
} finally {
  await browser?.close();
  await server.close();
}
