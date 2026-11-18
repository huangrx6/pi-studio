/** Production UI with synthetic conversation data; no model requests or user data. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
const output = new URL('../../.qa/shell-reflow/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(process.cwd());
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [], checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('pi-media://background/qa.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#536b66"/><circle cx="1100" cy="320" r="500" fill="#81927b"/></svg>' }));
  await page.addInitScript(installPerformanceFixture, { sessionCount: 2, turnCount: 1 });
  await page.addInitScript(() => {
    const base = window.piApi;
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...prefs, theme: 'dark', showCodeView: true, backgroundMedia: { kind: 'image', url: 'pi-media://background/qa.svg', name: 'qa.svg', mime: 'image/svg+xml', bytes: 200 } }));
    const pageData = async input => {
      const data = await base.conversationPage(input);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6bkAAAAASUVORK5CYII=';
      data.messages[0].content = [{ type: 'text', text: Array.from({ length: 35 }, (_, i) => `第 ${i + 1} 项：展开与收起内容时，外围背景应保持固定间距。`).join('\n') }, ...Array.from({ length: 2 }, () => ({ type: 'image', mimeType: 'image/png', data: png }))];
      data.turnDiffs = [{ at: data.messages[1].timestamp + 1, totalAdded: 83, totalRemoved: 0, files: Array.from({ length: 83 }, (_, i) => ({ path: `/qa/file-${i}.ts`, label: `file-${i}.ts`, added: 1, removed: 0, status: 'modified', patch: '+ update' })) }];
      return data;
    };
    window.piApi = new Proxy(base, { get: (target, key) => key === 'conversationPage' ? pageData : target[key] });
  });
  await page.goto(server.origin);
  await page.locator('[data-session-id="perf-0"] .session-row').click();
  await page.locator('.file-change-more').waitFor();
  async function frame(label) {
    const value = await page.locator('.app').evaluate(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { top: rect.top, bottom: innerHeight - rect.bottom, left: rect.left, right: innerWidth - rect.right, expectedTop: parseFloat(style.getPropertyValue('--shell-top')), gutter: parseFloat(style.getPropertyValue('--shell-gutter')), scroll: node.scrollTop, rootScroll: document.scrollingElement.scrollTop };
    });
    assert.equal(value.top, value.expectedTop, label);
    for (const side of ['bottom', 'left', 'right']) assert.equal(value[side], value.gutter, label + side);
    assert.equal(value.scroll, 0, label); assert.equal(value.rootScroll, 0, label);
    checks.push({ label, ...value });
  }
  await frame('initial');
  const files = page.locator('.file-change-more');
  assert.equal(await files.evaluate(node => node.parentElement.tagName), 'HEADER');
  await files.click(); assert.equal(await page.locator('.file-change-item').count(), 83);
  await page.locator('.file-change-item').last().evaluate(node => node.scrollIntoView({ block: 'end' }));
  await frame('expanded files and scrollIntoView');
  await files.click(); assert.equal(await page.locator('.file-change-item').count(), 4);
  await frame('collapsed files');
  await page.getByRole('button', { name: '展开更多', exact: true }).click();
  await frame('expanded message');
  await page.locator('.user-text-toggle').click();
  await frame('collapsed message');
  await page.locator('.composer-editor').fill('输入框增长后保持间距。\n'.repeat(12));
  await frame('growing composer');
  await page.locator('.composer-editor').fill('');
  await page.locator('.conversation-image-tile').first().click();
  await page.locator('.studio-lightbox .yarl__toolbar').waitFor();
  async function checkIcons(label) {
    for (const button of await page.locator('.studio-lightbox .yarl__toolbar .yarl__button').all()) {
      await button.hover({ force: true });
      const offset = await button.evaluate(node => {
        const a = node.getBoundingClientRect(), b = node.querySelector('svg').getBoundingClientRect();
        return { label: node.getAttribute('aria-label'), dx: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) };
      });
      assert.ok(offset.dx < 1 && offset.dy < 1, JSON.stringify(offset)); checks.push({ label, ...offset });
    }
  }
  await checkIcons('desktop hover');
  await page.screenshot({ path: output + 'image-toolbar.png' });
  await page.setViewportSize({ width: 560, height: 850 });
  await checkIcons('narrow hover');
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  await frame('narrow resize and image close');
  await page.evaluate(() => document.documentElement.dataset.windowFullscreen = 'true');
  await frame('fullscreen');
  await page.evaluate(() => delete document.documentElement.dataset.windowFullscreen);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.screenshot({ path: output + 'background-frame.png' });
  assert.deepEqual(errors, []);
  await writeFile(output + 'result.json', JSON.stringify({ checks, errors }, null, 2));
  console.log('Shell reflow and image toolbar QA passed');
} finally { await browser.close(); await server.close(); }
