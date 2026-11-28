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
  const quotaProvider = { id: 'qa', name: '测试模型' };
  const quotaChip = {
    id: 'user:pi-quota-status/chip', extensionId: 'user:pi-quota-status', contributionId: 'chip',
    extensionName: '额度状态', scope: 'user', slot: 'status.chip', details: 'detail',
    title: '额度状态', size: 'compact', icon: 'gauge', content: [],
  };
  const toolOnly = new URLSearchParams(location.search).has('tool-only');
  const withDiff = fn => async (...args) => {
    const snapshot = await fn(...args);
    const result = { ...snapshot, model: { ...snapshot.model, quotaProvider } };
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
    settings: async () => ({ ...await api.settings(), providers: [{ ...quotaProvider, enabled: true, quotaEnabled: true }] }),
    extensionsUi: async () => ({ items: [quotaChip, { ...quotaChip, id: 'user:pi-quota-status/detail', contributionId: 'detail', slot: 'status.detail' }], syncedAt: at, errors: [], apiVersion: 1 }),
    providerQuota: async () => ({ status: 'ready', metrics: [
      { label: '5 小时已用', value: '12%', summary: true }, { label: '本周已用', value: '20%', summary: true },
    ] }),
    gitRepositories: async root => [{ id: '.', name: 'workspace', root }],
    gitRead: async () => ({
      branch: 'main', head: 'before', root: turn.snapshot.root, remotes: [],
      files: files.map(({ label }) => ({ path: label, index: ' ', worktree: 'M', conflict: false })),
    }),
    files: async () => ({ entries: files.map(({ path, label }) => ({ path, name: label, type: 'file' })) }),
    runtimeServices: async () => ({ scannedAt: Date.now(), supported: true, services: [], summary: { total: 0, related: 0 } }),
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
  const page = await browser.newPage({ viewport: { width: 1320, height: 920 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
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
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: 'Git', exact: true }).click();
  const gitViews = page.getByRole('navigation', { name: 'Git 视图' });
  const footer = page.getByRole('contentinfo', { name: '状态栏' });
  const quotaTrigger = footer.getByRole('button', { name: '打开 额度状态 详情' });
  const runtimeTrigger = footer.getByRole('button', { name: /^运行服务/ });
  const fill = locator => locator.evaluate(async node => {
    await Promise.allSettled(node.getAnimations().map(animation => animation.finished));
    return getComputedStyle(node).backgroundColor;
  });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(0, 0);
    const cardFill = await fill(card);
    assert.match(cardFill, /^rgb\(/, 'card fill is opaque');
    assert.equal(cardFill, await fill(page.locator('.app')), 'cards use the sidebar frame fill');
    assert.equal(await fill(gitViews), cardFill, `${theme} Git view switcher shares the file card fill`);
    for (const selector of ['.git-index', '.git-commit-form textarea', '.composer:visible']) {
      assert.equal(await fill(page.locator(selector)), cardFill, `${theme} ${selector} shares the file card fill`);
    }
    assert.equal(await fill(card.locator('header')), 'rgba(0, 0, 0, 0)', 'the header lets the card fill show through');
    assert.notEqual(await fill(gitViews.getByRole('button', { pressed: true })), await fill(gitViews.getByRole('button', { pressed: false }).first()));
    const icons = await rows.locator('img[data-file-icon]').evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => image.dataset.fileIcon);
    });
    assert.deepEqual(icons, ['javascript', 'html', 'css']);
    await card.screenshot({ path: fileURLToPath(new URL(`summary-${theme}.png`, output)), animations: 'disabled' });
    await page.screenshot({ path: fileURLToPath(new URL(`workbench-${theme}.png`, output)), animations: 'disabled' });
    await quotaTrigger.hover();
    const hoverFill = await fill(quotaTrigger);
    assert.notEqual(hoverFill, 'rgba(0, 0, 0, 0)', 'status buttons give visible hover feedback');
    await runtimeTrigger.hover();
    assert.equal(await fill(runtimeTrigger), hoverFill);
    await runtimeTrigger.click();
    assert.equal(await fill(page.getByRole('dialog', { name: '运行服务' })), cardFill);
    const expandedFill = await fill(runtimeTrigger);
    assert.notEqual(expandedFill, hoverFill);
    await page.getByRole('button', { name: '关闭运行服务' }).click();
    await quotaTrigger.click();
    const quotaPopover = footer.getByRole('dialog', { name: '额度状态' });
    assert.equal(await fill(quotaPopover), cardFill);
    assert.equal(await fill(quotaTrigger), expandedFill);
    await page.screenshot({ path: fileURLToPath(new URL(`popover-${theme}.png`, output)), animations: 'disabled' });
    await quotaPopover.getByRole('button', { name: '关闭', exact: true }).click();
    await card.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await fill(page.locator('.confirm-card')), cardFill);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  console.log('Passed light and dark card, editor, Git panel, status popover and confirmation surfaces.');
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
  const writeRow = rows.filter({ hasText: 'notes.md' });
  assert.match(await writeRow.innerText(), /\/ 3 行/, 'a tool-only write shows the written length');
  assert.equal(await card.locator('.file-change-counts, .file-change-undo').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed file icons, per-file totals, diff navigation, confirmation, and undo state.');
} finally {
  await browser?.close();
  await server.close();
}
