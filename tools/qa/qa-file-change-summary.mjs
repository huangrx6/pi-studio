/**
 * Focused browser QA for the turn file-change summary.
 *
 * The reported symptom: a brand-new file (`write` to a path git has never seen)
 * was labelled "已写入" with no line counts, while git would report the whole
 * file as additions. Two sources now feed the card:
 *   - the stored turn diff, which knows the file is added and counts +N −0;
 *   - the tool arguments, which only know how long the written file is.
 * This QA pins both presentations plus the git-style A/M/D marker.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-file-change-summary.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/file-change-summary/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 860, height: 620 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/file-change-probe', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:24px"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (t) => t;
      window.__vite_plugin_react_preamble_installed__ = true;
      document.documentElement.dataset.theme = 'dark';
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      const React = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { FileChangeSummary } = await import('/src/features/conversation/FileChangeSummary.tsx');
      const gitDiff = {
        at: 1, totalAdded: 161, totalRemoved: 6, files: [
          { path: '/repo/tools/qa/qa-agent-context.mjs', label: 'tools/qa/qa-agent-context.mjs', status: 'added', added: 161, removed: 0, patch: '+x\\n+y', completeCounts: true },
          { path: '/repo/web/src/app.css', label: 'web/src/app.css', status: 'modified', added: 83, removed: 6, patch: '+a\\n-b', completeCounts: true },
        ],
      };
      const toolFiles = [
        { path: '/repo/notes.md', label: 'notes.md', operations: [{ id: 'w1' }], added: 0, removed: 0, completeCounts: false, lines: 3 },
      ];
      createRoot(document.getElementById('root')).render(React.createElement(FileChangeSummary, {
        files: toolFiles, gitDiff, onOpenDiff: () => {}, onOpenFile: () => true,
      }));
      window.__ready = true;
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/file-change-probe');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(400);

  const rows = await page.evaluate(() => [...document.querySelectorAll('.file-change-item')].map((row) => ({
    path: row.querySelector('.file-change-path')?.textContent,
    mark: row.querySelector('.file-change-mark')?.textContent,
    markClass: row.querySelector('.file-change-mark')?.className,
    trailing: row.querySelector('.file-change-counts')?.textContent
      || row.querySelector('small')?.textContent
      || '',
  })));

  assert.equal(rows.length, 3, 'all three files render');

  const added = rows.find((row) => row.path?.endsWith('qa-agent-context.mjs'));
  assert.equal(added.mark, 'A', 'a new file carries the git-style added marker');
  assert.equal(added.trailing, '+161−0', 'a new file shows its additions instead of prose');

  const modified = rows.find((row) => row.path?.endsWith('app.css'));
  assert.equal(modified.mark, 'M');
  assert.equal(modified.trailing, '+83−6');

  const written = rows.find((row) => row.path === 'notes.md');
  assert.equal(written.mark, 'W', 'a tool-only write is marked separately');
  assert.equal(written.trailing, '/ 3 行', 'a tool-only write reports its length, not a fake delta');

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  await page.screenshot({ path: `${output}summary.png` });
  console.log('file change summary QA passed', JSON.stringify(rows, null, 1));
} finally {
  await browser.close();
}
