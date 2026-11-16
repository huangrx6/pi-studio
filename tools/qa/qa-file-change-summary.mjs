import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/screenshots/file-change-summary/', root);
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(root));

function installDiffFixture() {
  const api = window.piApi;
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark', showCodeView: true }));
  const at = 1_780_000_000_500;
  const files = [['app.js', 471, 0], ['index.html', 62, 6], ['styles.css', 201, 1]].map(([label, added, removed]) => ({
    label, path: '/qa/synthetic/performance/' + label, added, removed, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new',
  }));
  const turn = { at, snapshot: { root: '/qa/synthetic/performance', before: 'before', after: 'after' }, files, totalAdded: 734, totalRemoved: 7 };
  const toolOnly = new URLSearchParams(location.search).has('tool-only');
  const withDiff = fn => async (...args) => {
    const result = await fn(...args);
    if (!toolOnly) return { ...result, turnDiffs: [turn] };
    if (!result.messages) return result;
    const messages = [
      result.messages[0],
      { role: 'assistant', sourceIndex: 1, timestamp: at, content: [
        { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: '/tmp/notes.md', content: 'a\nb\nc' } },
      ] },
      { role: 'toolResult', sourceIndex: 2, timestamp: at + 1, toolCallId: 'write-1', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', sourceIndex: 3, timestamp: at + 2, content: [{ type: 'text', text: '已写入文件。' }] },
    ];
    return { ...result, messages, messageCount: messages.length, turnDiffs: [] };
  };
  window.piApi = new Proxy({
    conversationPage: withDiff(api.conversationPage),
    conversationSnapshot: withDiff(api.conversationSnapshot),
    subscribeConversation: withDiff(api.subscribeConversation),
    undoTurnDiff: async ({ sessionId, at: requested }) => {
      if (sessionId !== 'perf-0' || requested !== at) throw new Error('Wrong turn');
      window.undoCalls = (window.undoCalls || 0) + 1;
      turn.undone = true;
    },
  }, { get: (target, key) => key in target ? target[key] : api[key] });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1320, height: 920 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:1});(${installDiffFixture})();` });
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  const card = page.getByRole('region', { name: '本轮文件变更' });
  const rows = card.locator('.file-change-item');
  await card.waitFor();
  assert.deepEqual(await rows.locator('.file-change-path').allTextContents(), ['app.js', 'index.html', 'styles.css']);
  assert.deepEqual(await rows.locator('.file-change-counts').allTextContents(), ['+471−0', '+62−6', '+201−1']);
  assert.equal(await card.locator('header .file-change-counts').innerText().then(s => s.replace(/\s/g, '')), '+734−7');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const icons = await rows.locator('img[data-file-icon]').evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => image.dataset.fileIcon);
    });
    assert.deepEqual(icons, ['javascript', 'html', 'css']);
    await card.screenshot({ path: fileURLToPath(new URL(`summary-${theme}.png`, output)), animations: 'disabled' });
  }
  await card.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.undoCalls || 0), 0);
  await card.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '撤销变更', exact: true }).click();
  await card.getByRole('button', { name: '已撤销' }).waitFor();
  assert.equal(await page.evaluate(() => window.undoCalls), 1);
  await rows.first().click();
  const changes = page.locator('.changes-view');
  await changes.waitFor();
  const expectedIcons = ['javascript', 'html', 'css'];
  const iconIds = selector => changes.locator(selector + ' [data-file-icon]').evaluateAll(images => images.map(image => image.dataset.fileIcon));
  assert.deepEqual(await iconIds('.changes-file-toggle'), expectedIcons);
  await changes.getByRole('button', { name: '跳转到文件' }).click();
  assert.deepEqual(await iconIds('.changes-jump button'), expectedIcons);
  await page.goto(server.origin + '/?tool-only');
  await page.locator('.session-row').first().click();
  await rows.filter({ hasText: 'notes.md' }).getByText('/ 3 行').waitFor();
  assert.equal(await card.locator('.file-change-counts, .file-change-undo').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed file icons, per-file totals, diff navigation, confirmation, and undo state.');
} finally {
  await browser?.close();
  await server.close();
}
