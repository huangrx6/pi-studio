/**
 * Focused browser QA for clickable local paths in chat markdown.
 *
 * Renders the real Markdown component with the host actions context and proves
 * that a deliverable path inside a table cell becomes a link, that clicking it
 * asks the host to open the resolved absolute path, and that right click offers
 * Finder / open-with actions.
 *
 *   pnpm run web
 *   node tools/qa/qa-markdown-path-links.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/markdown-paths/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors = [];
  const loadedModules = new Set();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/src/shared/markdown-highlighter.ts')) loadedModules.add('highlighter');
  });

  await page.route('**/markdown-paths', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:32px"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (t) => t;
      window.__vite_plugin_react_preamble_installed__ = true;
      document.documentElement.dataset.theme = 'dark';
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      const React = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { Markdown } = await import('/src/shared/Markdown.tsx');
      const { MarkdownActions } = await import('/src/shared/markdown-actions.ts');
      window.__opened = [];
      window.__links = [];
      const actions = {
        cwd: '/repo',
        openFile: (path) => window.__opened.push(path),
        openLink: (url) => window.__links.push(url),
      };
      const source = [
        '## 已交付（travel/ 目录）',
        '',
        '| 文件 | 内容 |',
        '| --- | --- |',
        '| \`一周旅游计划.md\` | 主交付 |',
        '| \`北京调研.md\` | 北京子 Agent 产出 |',
        '',
        '完整清单见 \`travel/北京调研.md\`，发布会话在 \`/tmp/report.pdf\`，',
        '外部参考 https://example.com/doc 。',
        '',
        '\`\`\`bash',
        'ls build/artifact.zip',
        '\`\`\`',
      ].join('\\n');
      createRoot(document.getElementById('root')).render(
        React.createElement(MarkdownActions.Provider, { value: actions },
          React.createElement(Markdown, null, source)));
      window.__ready = true;
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/markdown-paths');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  // The renderer is a deferred chunk. Wait for its real output instead of
  // relying on a machine-dependent fixed delay; rendering continues to show the
  // plain source while that local module is loading.
  await page.locator('a.md-path-link').first().waitFor({ timeout: 20000 });
  await page.locator('.markdown pre code').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.markdown pre code.hljs')), null, { timeout: 20000 }).catch(async (error) => {
    const debug = await page.evaluate(() => ({
      codeClasses: [...document.querySelectorAll('.markdown pre code')].map((node) => node.className),
      source: document.querySelector('.markdown')?.textContent?.slice(-80),
    }));
    throw new Error(`${error.message}; highlight debug: ${JSON.stringify(debug)}`);
  });
  assert.equal(loadedModules.has('highlighter'), true, 'fenced code loads the deferred highlighter');

  const links = await page.evaluate(() => [...document.querySelectorAll('a.md-path-link')].map((link) => ({
    text: link.textContent,
    title: link.getAttribute('title'),
  })));
  assert.deepEqual(
    links.map((link) => link.text),
    ['一周旅游计划.md', '北京调研.md', 'travel/北京调研.md', '/tmp/report.pdf'],
    `only deliverable paths link (${JSON.stringify(links)})`,
  );
  assert.equal(links[2].title, '/repo/travel/北京调研.md', 'relative paths resolve against cwd');
  assert.equal(await page.locator('pre a.md-path-link').count(), 0, 'code blocks stay verbatim');

  await page.locator('a.md-path-link', { hasText: 'travel/北京调研.md' }).click();
  assert.deepEqual(await page.evaluate(() => window.__opened), ['/repo/travel/北京调研.md'], 'click opens the preview');
  assert.deepEqual(await page.evaluate(() => window.__links), [], 'file links never reach the browser');

  await page.locator('a.md-path-link', { hasText: 'travel/北京调研.md' }).click({ button: 'right' });
  await page.waitForSelector('.action-menu', { timeout: 5000 });
  const items = await page.evaluate(() => [...document.querySelectorAll('.action-menu button span')].map((span) => span.textContent));
  assert.ok(items.includes('打开预览'), items.join('|'));
  assert.ok(items.includes('在 Finder 中显示'), items.join('|'));
  assert.ok(items.includes('复制路径'), items.join('|'));
  await page.keyboard.press('Escape');

  await page.screenshot({ path: `${output}links.png` });
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('markdown path links QA passed', JSON.stringify({ links, loadedModules: [...loadedModules] }, null, 1));
} finally {
  await browser.close();
}
