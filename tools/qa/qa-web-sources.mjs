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
  const withSources = fn => async (...args) => {
    const result = await fn(...args);
    if (!result.messages) return result;
    const messages = [result.messages[0]];
    const push = (role, content, extra = {}) => messages.push({ role, content, ...extra, sourceIndex: messages.length, timestamp: messages[0].timestamp + messages.length });
    const say = text => ({ type: 'text', text });
    const report = new URLSearchParams(location.search).has('report');
    push('assistant', [{ type: 'thinking', thinking: '先确认每个来源的发布时间。' }, { type: 'toolCall', name: 'mcp__brave__brave_web_search', id: 'search', arguments: { query: 'interaction feedback' } }]);
    push('toolResult', [say('搜索完成')], { toolCallId: 'search', details: { structuredContent: { results: [
      { url: 'https://www.nngroup.com/articles/response-times-3-important-limits/', title: 'Response Times: The 3 Important Limits' },
      { url: 'https://developer.mozilla.org/docs/Web/Accessibility' }, { url: 'https://web.dev/learn/accessibility/' },
      { url: 'https://web.dev/articles/rendering-performance' },
      { url: 'https://www.w3.org/WAI/standards-guidelines/' }, { url: 'https://react.dev/reference/react' },
      ...Array.from({ length: 22 }, (_, i) => ({ url: `https://source-${i + 1}.example.org/` })),
    ] } } });
    push('assistant', [{ type: 'toolCall', name: 'web_fetch', id: 'read', arguments: { url: 'https://developer.mozilla.org/docs/Web/Accessibility' } },
      { type: 'toolCall', name: 'bash', id: 'command', arguments: { command: 'node tools/check-docs.mjs --files ' + 'chapter.md '.repeat(35) } }]);
    push('toolResult', [say('找不到 chapter.md')], { toolCallId: 'command', isError: true });
    push('toolResult', [say('读取完成')], { toolCallId: 'read' });
    if (report) {
      for (const [i, task] of ['检查键盘操作', '检查表格可读性', '汇总检查结果'].entries()) {
        const id = 'agent-' + i;
        push('assistant', [{ type: 'thinking', thinking: task }, { type: 'toolCall', id, name: i === 2 ? 'bg_wait' : 'subagent',
          arguments: { name: i === 0 ? 'keyboard' : 'layout', action: i === 2 ? 'wait' : 'spawn', task } }]);
        push('toolResult', [say('检查完成')], { toolCallId: id });
      }
      push('assistant', [say('## 会话界面检查结果\n\n两项检查均已完成。键盘可以打开执行详情，窄窗口里的表格也可以单独横向滚动。\n\n| 检查项目 | 检查方式 | 结果 |\n|---|---|---|\n| 键盘操作 | 聚焦执行记录，按 Enter 展开 | 已通过 |\n| 窄屏表格 | 缩小窗口，横向查看最后一列 | 已通过 |')]);
    } else {
      push('assistant', [say('把处理过程画成图，便于对照每一步。'), { type: 'toolCall', name: 'generate_image', id: 'draw', arguments: {} }]);
      push('toolResult', [{ type: 'image', mimeType: 'image/png', data: image.split(',')[1] }], { toolCallId: 'draw' });
      push('assistant', [say('图表也可以从工作区引用。\n\n![本地流程图](artifacts/flow.png)\n\n| 日期 | 星期 | 检查项目 | 测量结果 | 交互反馈 | 验收条件 | 备注 |\n|---|---|---|---|---|---|---|\n| 11-18 | 周三 | 消息内容 | 结果已返回 | 支持键盘操作 | 仅表格横向滚动 | 保留全文 |')]);
    }
    return { ...result, messages, messageCount: messages.length };
  };
  window.piApi = new Proxy({
    conversationPage: withSources(api.conversationPage), conversationSnapshot: withSources(api.conversationSnapshot),
    subscribeConversation: withSources(api.subscribeConversation),
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
  const turn = page.locator('.assistant-turn-main').first();
  const trigger = turn.locator('.message-actions').getByRole('button', { name: '网页来源（27 个网站）' });
  const dialog = page.getByRole('dialog', { name: '网页来源' });
  await trigger.waitFor();
  assert.equal(await dialog.count(), 0);
  assert.ok(await trigger.evaluate(button => button.previousElementSibling?.title === '复制回答' && button.nextElementSibling?.tagName === 'TIME'));
  await trigger.focus();
  await page.keyboard.press('Space');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('link').count(), 27);
  assert.equal(await dialog.getByRole('link', { name: /Response Times/ }).count(), 1);
  assert.equal(await dialog.getByRole('link').nth(2).getAttribute('href'), 'https://web.dev/learn/accessibility/');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await trigger.evaluate(button => button === document.activeElement));
  const activity = turn.getByRole('button', { name: /执行过程/ });
  assert.match(await activity.textContent(), /3 次工具调用 · 1 次思考.*失败/);
  await activity.click();
  const command = turn.locator('.activity-tool.is-error summary');
  await command.click();
  await turn.getByText('找不到 chapter.md', { exact: true }).waitFor();
  await activity.click();
  await activity.blur();
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
    await trigger.click();
    const panel = dialog.locator('.web-sources-dialog');
    await panel.screenshot({ path: fileURLToPath(new URL(theme + '.png', output)), animations: 'disabled' });
    await dialog.getByRole('button', { name: '关闭网页来源' }).click();
  }
  await turn.screenshot({ path: fileURLToPath(new URL('conversation.png', output)), animations: 'disabled' });
  await page.setViewportSize({ width: 480, height: 780 });
  await trigger.click();
  const list = dialog.getByRole('list');
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth === el.clientWidth));
  await dialog.getByRole('link').last().scrollIntoViewIfNeeded();
  assert.ok(await list.evaluate(el => el.scrollTop > 0));
  await page.mouse.click(3, 3);
  await dialog.waitFor({ state: 'detached' });
  const table = turn.getByRole('region', { name: '表格' });
  const layout = await table.evaluate(el => ({
    ownWidth: el.clientWidth, scrollWidth: el.scrollWidth, articleWidth: el.closest('.assistant-turn-main').clientWidth,
    bodyWidth: document.documentElement.scrollWidth, viewport: innerWidth, width: getComputedStyle(el.querySelector('th')).whiteSpace,
  }));
  assert.equal(layout.width, 'nowrap');
  assert.ok(layout.scrollWidth > layout.ownWidth && layout.ownWidth <= layout.articleWidth && layout.bodyWidth <= layout.viewport, JSON.stringify(layout));
  await table.focus();
  await page.keyboard.press('End');
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(server.origin + '/?report');
  await page.locator('.session-row').first().click();
  await turn.getByRole('heading', { name: '会话界面检查结果' }).waitFor();
  assert.equal(await turn.locator('.turn-trace').count(), 1);
  assert.equal(await turn.locator('.activity-disclosure').count(), 0);
  assert.match(await turn.locator('.turn-trace-toggle').innerText(), /6 次工具调用 · 4 次思考/);
  assert.ok(await turn.locator('.turn-trace-toggle').evaluate(node => node.getBoundingClientRect().height < 40));
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await turn.screenshot({ path: fileURLToPath(new URL('compact-report.png', output)), animations: 'disabled' });
  await trigger.click();
  const firstSource = dialog.getByRole('link').first();
  const url = await firstSource.getAttribute('href');
  await firstSource.click();
  await dialog.waitFor({ state: 'detached' });
  const address = page.getByRole('textbox', { name: '浏览器地址' });
  await address.waitFor();
  assert.equal(await address.inputValue(), url);
  assert.deepEqual(errors, []);
  console.log('Passed per-turn source deduplication, keyboard disclosures, failed commands, tool images, local previews and a seven-column table on a narrow screen.');
} finally {
  await browser?.close();
  await server.close();
}
