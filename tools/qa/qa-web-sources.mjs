import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

function installWebFixture() {
  const api = window.piApi;
  const canvas = document.createElement('canvas');
  canvas.width = 540; canvas.height = 130;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eef2f4'; ctx.fillRect(0, 0, 540, 130);
  ctx.font = '16px system-ui'; ctx.fillStyle = '#283b45'; ctx.fillText('回复流程', 18, 28);
  for (const [index, text] of ['提交问题', '搜索来源', '整理回答'].entries()) {
    const x = 18 + index * 175;
    ctx.fillStyle = '#d1e2e7'; ctx.fillRect(x, 55, 132, 46);
    ctx.fillStyle = '#283b45'; ctx.fillText(text, x + 30, 84);
    if (index < 2) ctx.fillText('→', x + 143, 84);
  }
  const image = canvas.toDataURL();
  const withSources = async (...args) => {
    const result = await api.conversationPage(...args);
    const messages = [result.messages[0]];
    const push = (role, content, extra = {}) => messages.push({ role, content, ...extra, sourceIndex: messages.length, timestamp: messages[0].timestamp + messages.length });
    const say = text => ({ type: 'text', text });
    push('assistant', [say('先查阅三个网站的资料。'), { type: 'toolCall', name: 'mcp__brave__brave_web_search', id: 'search', arguments: { query: 'interaction feedback' } }]);
    push('toolResult', [say('搜索完成')], { toolCallId: 'search', details: { structuredContent: { results: [
      { url: 'https://www.nngroup.com/articles/response-times-3-important-limits/' },
      { url: 'https://developer.mozilla.org/docs/Web/Accessibility' }, { url: 'https://web.dev/learn/accessibility/' },
      { url: 'https://web.dev/articles/rendering-performance' },
    ] } } });
    push('assistant', [say('把处理过程画成图，便于对照每一步。'), { type: 'toolCall', name: 'generate_image', id: 'draw', arguments: {} }]);
    push('toolResult', [{ type: 'image', mimeType: 'image/png', data: image.split(',')[1] }], { toolCallId: 'draw' });
    push('assistant', [say('图表也可以从工作区引用。\n\n![本地流程图](artifacts/flow.png)')]);
    return { ...result, messages, messageCount: messages.length };
  };
  window.piApi = new Proxy({
    conversationPage: withSources,
    filePreview: async (cwd, path) => {
      if (path !== 'artifacts/flow.png' || cwd !== '/qa/synthetic/performance') throw Error('Wrong preview target');
      return { kind: 'image', name: 'flow.png', dataUrl: image };
    },
  }, { get: (target, key) => key in target ? target[key] : api[key] });
}

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/screenshots/web-sources/', root);
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:1});(${installWebFixture})();` });
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  const summary = page.getByRole('button', { name: '搜索到 3 个网站' });
  await summary.waitFor();
  assert.deepEqual(await page.locator('.web-source-chip > span:last-child').allTextContents(), ['nngroup.com', 'developer.mozilla.org', 'web.dev']);
  assert.match(await page.locator('.web-source-chip').last().getAttribute('href'), /web.dev\/learn\/accessibility/);
  await summary.focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.web-source-list').isVisible(), false);
  await page.keyboard.press('Space');
  const raw = page.getByRole('button', { name: '工具详情' });
  await raw.click();
  await page.getByText('mcp__brave__brave_web_search', { exact: true }).waitFor();
  await raw.click();
  await raw.blur();
  const toolImage = page.locator('.tool-result-images .conversation-image-tile');
  const localImage = page.getByRole('button', { name: '放大预览：本地流程图' });
  for (const button of [toolImage, localImage]) {
    await button.locator('img').evaluate(img => img.decode());
    await button.click();
    await page.locator('.yarl__slide_image').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.yarl__root').waitFor({ state: 'detached' });
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('.web-source-heading').locator('..').screenshot({ path: fileURLToPath(new URL(theme + '.png', output)), animations: 'disabled' });
  }
  await page.locator('.assistant-turn-main').first().screenshot({ path: fileURLToPath(new URL('conversation.png', output)), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Passed website grouping, disclosure, tool images and workspace Markdown image previews.');
} finally {
  await browser?.close();
  await server.close();
}
