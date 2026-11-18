import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

function installActivityFixture() {
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark', showCodeView: false }));
  const api = window.piApi;
  const withActivity = fn => async (...args) => {
    const result = await fn(...args);
    if (!result.messages) return result;
    const messages = [result.messages[0]];
    function push(message) {
      messages.push({ ...message, sourceIndex: messages.length, timestamp: messages[0].timestamp + messages.length });
    }
    function step(text, tools = []) {
      const calls = tools.map(([name, args], i) => ({ type: 'toolCall', name, arguments: args, id: messages.length + '-' + i }));
      push({ role: 'assistant', content: [{ type: 'text', text }, ...calls] });
      for (const [i, call] of calls.entries()) {
        const [, , error, details] = tools[i];
        push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: Boolean(error), details,
          content: [{ type: 'text', text: error || '完成' }] });
      }
    }
    step('先看项目结构，确认棋盘和胜负判定写在哪里。', [
      ['grep', { pattern: 'board' }], ['read', { path: 'README.md' }, 'README.md 不存在'],
    ]);
    step('目录里没有找到说明文件。我再检查一下工作区状态。', [
      ['bash', { command: 'git status --short' }, '当前目录不是 Git 仓库'],
    ]);
    step('先补上页面、棋盘逻辑和样式。', ['index.html', 'app.js', 'styles.css'].map(path => ['write', { path, content: 'a\nb\n' }]));
    step('三个文件已写入。接下来检查脚本语法。', [['bash', { command: 'node --check app.js' }]]);
    step('最后把字体改为本地字体，使页面可以离线打开。', [
      ['edit', { path: 'styles.css' }, null, { patch: '@@ -1,2 +1 @@\n-remote\n-old\n+local' }],
      ['edit', { path: 'index.html' }, null, { patch: '@@ -1 +0,0 @@\n-link' }],
    ]);
    step('棋盘和胜负判定已完成。打开 `index.html` 即可试玩。');
    return { ...result, messages, messageCount: messages.length, turnDiffs: [] };
  };
  window.piApi = new Proxy({
    conversationPage: withActivity(api.conversationPage), conversationSnapshot: withActivity(api.conversationSnapshot),
    subscribeConversation: withActivity(api.subscribeConversation),
  }, { get: (target, key) => key in target ? target[key] : api[key] });
}

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/screenshots/inline-activity/', root);
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:1});(${installActivityFixture})();` });
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  const turn = page.locator('.assistant-turn-main').first();
  const toggles = turn.locator('.turn-trace > .turn-trace-toggle, .turn-trace.is-single > .activity-sequence > details > summary');
  await turn.getByText('即可试玩。', { exact: false }).waitFor();
  assert.deepEqual(await turn.locator(':scope > .assistant-response, :scope > .turn-trace').evaluateAll(elements =>
    elements.map(element => element.classList.contains('assistant-response') ? '正文' : element.querySelector('strong').textContent)),
    ['正文', '探索', '正文', '运行命令', '正文', '写入', '正文', '运行命令', '正文', '更新', '正文']);
  assert.equal(await turn.locator('.turn-trace-toggle[aria-expanded="true"]').count(), 0);
  assert.match(await toggles.nth(0).textContent(), /1 次搜索，1 个文件1 步失败/);
  assert.match(await toggles.nth(2).textContent(), /6 行/);
  assert.equal(await toggles.nth(4).locator('.inline-activity-delta').textContent(), '+1−3');
  await toggles.nth(1).focus();
  assert.equal(await toggles.nth(1).getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Enter');
  await turn.getByText('当前目录不是 Git 仓库', { exact: true }).waitFor();
  assert.equal(await turn.getByText('git status --short', { exact: true }).count(), 1);
  await page.keyboard.press('Enter');
  await toggles.nth(1).blur();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const icons = await toggles.nth(2).locator('img[data-file-icon]').evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => image.dataset.fileIcon);
    });
    assert.deepEqual(icons, ['html', 'javascript', 'css']);
    await turn.screenshot({ path: fileURLToPath(new URL(theme + '.png', output)), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 760, height: 780 });
  assert.ok(await toggles.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
  assert.deepEqual(errors, []);
  console.log('Passed chronological prose, grouped actions, file icons, counts, failure disclosure and narrow layout.');
} finally {
  await browser?.close();
  await server.close();
}
