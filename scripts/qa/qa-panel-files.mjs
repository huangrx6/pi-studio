import { copyPreviewText, replaceSourceText, visibleSourceText } from './fixtures/source-editor.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installPanelFilesFixture } from './fixtures/panel-files.mjs';
import { installResourceDetailsFixture } from './fixtures/resource-details.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript({
    content:
      '(' +
      installPerformanceFixture.toString() +
      ')({sessionCount:2,turnCount:2});(' +
      installPanelFilesFixture.toString() +
      ')();',
  });
  await page.goto(server.origin);
  const button = (name) => page.getByRole('button', { name, exact: true });
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  const doc = page.locator('.session-document');
  const file = (name) => page.locator('.file-row[title="' + name + '"]');
  const bridge = (method, ...args) =>
    page.evaluate(({ method, args }) => window.__panelFilesQa[method](...args), { method, args });
  const expectFile = (owner, name, version = 1) =>
    doc
      .getByText('WORKSPACE ' + owner + ' · ' + name + ' · version ' + version, { exact: false })
      .first()
      .waitFor();
  async function visit(owner) {
    await bridge('open', owner);
    await tab('文件会话 ' + owner.toUpperCase()).waitFor();
  }
  await page.locator('.session-row').filter({ hasText: '文件会话 A' }).click();
  await tab('文件会话 A').waitFor();
  await button('打开右侧面板').click();
  await file('live.txt').dblclick();
  await expectFile('A', 'live.txt');
  await bridge('change', 'a', 'live.txt', 2);
  await expectFile('A', 'live.txt', 2);
  await button('编辑文件').click();
  const editor = doc.getByRole('textbox', { name: 'live.txt 源码编辑器' });
  await replaceSourceText(editor, '保留 A 的编辑草稿');
  await visit('b');
  assert.equal(await tab('live.txt').count(), 0);
  await button('打开右侧面板').click();
  await file('live.txt').dblclick();
  await expectFile('B', 'live.txt');
  await visit('a');
  await tab('live.txt').click();
  await editor.waitFor();
  assert.equal(await visibleSourceText(doc), '保留 A 的编辑草稿');
  assert.equal(await copyPreviewText(doc), '保留 A 的编辑草稿');
  await button('取消编辑').click();
  await bridge('hold', 'filePreview', 'a', 'late.txt');
  await file('late.txt').click();
  await page.waitForFunction(() => window.__panelFilesQa.pending().some((row) => row.path === 'late.txt'));
  const [pending] = await bridge('pending');
  await visit('b');
  await tab('live.txt').click();
  await bridge('release', pending.id);
  await expectFile('B', 'live.txt');
  assert.equal(await tab('late.txt').count(), 0);
  const more = button('文件操作');
  const item = name => page.getByRole('menuitem', { name, exact: true });
  const appCalls = () => page.evaluate(() => window.__panelFilesQa.calls.filter(item => item.method === 'fileActions').length);
  await more.click();
  assert.equal(await appCalls(), 0);
  assert.equal(await item('Synthetic Editor').count(), 0);
  assert.equal(await item('在右侧打开').count(), 0);
  await page.getByRole('menuitemcheckbox', { name: '显示行号', checked: true }).click();
  const firstLineNumber = doc.locator('.line-numbers').filter({ hasText: /^1$/ });
  await firstLineNumber.waitFor({ state: 'hidden' });
  await more.click();
  await page.getByRole('menuitemcheckbox', { name: '显示行号', checked: false }).click();
  await firstLineNumber.waitFor();
  await more.click();
  await bridge('hold', 'fileActions', 'b', 'live.txt');
  await item('打开方式').press('ArrowRight');
  await item('正在读取应用…').waitFor();
  assert.equal(await item('用默认应用打开').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await item('打开方式').evaluate(node => node === document.activeElement), true);
  const [appRequest] = await bridge('pending');
  await bridge('unhold', 'fileActions', 'b', 'live.txt');
  await bridge('release', appRequest.id);
  await page.keyboard.press('Escape');
  assert.equal(await more.evaluate(node => node === document.activeElement), true);
  await more.click();
  await bridge('fail', 'fileActions', 'b', 'live.txt');
  await item('打开方式').click();
  await item('无法读取其他应用').waitFor();
  await item('用默认应用打开').click();
  await more.click();
  await item('打开方式').click();
  await item('Synthetic Editor').press('ArrowLeft');
  await item('打开方式').press('Enter');
  await item('Synthetic Editor').click();
  const action = await page.evaluate(() =>
    window.__panelFilesQa.calls.findLast((item) => item.method === 'openWith'),
  );
  assert.equal(action.cwd, '/qa/synthetic/workspace-b');
  assert.equal(action.appPath, '/qa/apps/editor');
  await bridge('fail', 'filePreview', 'b', 'live.txt');
  await bridge('change', 'b', 'live.txt', 3);
  await button('重试读取文件').click();
  await expectFile('B', 'live.txt', 3);

  const settings = await browser.newPage({ reducedMotion: 'reduce' });
  settings.on('pageerror', error => errors.push(error.message));
  await settings.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:4});(${installResourceDetailsFixture.toString()})();` });
  await settings.goto(server.origin);
  await settings.getByRole('button', { name: '设置', exact: true }).first().click();
  await settings.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
  await settings.getByRole('tab', { name: '技能', exact: true }).click();
  await settings.getByRole('button', { name: '查看技能 资源技能 A' }).click();
  const detail = settings.locator('.skill-detail-dialog');
  const previewMenu = detail.getByRole('button', { name: '文件操作' });
  await previewMenu.click();
  const popup = settings.getByRole('menu', { name: '文件操作' });
  await popup.getByRole('menuitem', { name: '复制文件内容' }).waitFor();
  assert.ok(await popup.evaluate(menu => menu.closest('dialog:modal')?.contains(document.activeElement)));
  await settings.keyboard.press('Escape');
  assert.ok(await previewMenu.evaluate(trigger => trigger === document.activeElement));
  await detail.getByRole('button', { name: /artifact\.bin/ }).click();
  await detail.getByRole('button', { name: '用系统应用打开文件' }).click();
  await settings.waitForFunction(() => window.__resourceDetailsQa.calls.some(call => call.method === 'openWith' && call.target === 'artifact.bin'));

  assert.deepEqual(errors, []);
  console.log('Passed document reads, drafts, file menu navigation, scoped application actions and native-dialog preview controls.');
} finally {
  await browser?.close();
  await server.close();
}
