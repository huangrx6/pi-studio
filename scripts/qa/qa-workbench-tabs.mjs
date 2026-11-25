/** Exercise the production tab strip with ordinary tool launches and synthetic workspace files. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installPanelFilesFixture } from './fixtures/panel-files.mjs';
import { installSessionViewsFixture } from './fixtures/session-views.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/workbench-tabs');
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1540, height: 840 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await page.addInitScript({ content: `
    (${installPerformanceFixture})({sessionCount:2,turnCount:2});
    (${installSessionViewsFixture})();
    (${installPanelFilesFixture})();
    window.piApi.gitRepositories = async () => [];
    localStorage.setItem('pi-studio:panel-width','650');
  ` });
  await page.goto(server.origin);
  await page.locator('.session-row').filter({ hasText: '文件会话 A' }).click();
  await page.locator('.assistant-response').first().waitFor();
  const bar = page.locator('.panel-tabbar');
  const tab = name => bar.getByRole('tab', { name, exact: true });
  const button = name => bar.getByRole('button', { name, exact: true });
  const all = bar.getByRole('button', { name: /^查看全部 \d+ 个标签页$/ });
  const picker = page.getByRole('dialog', { name: '切换标签页' });
  const search = picker.getByRole('combobox', { name: '搜索标签页' });
  const active = bar.locator('[role="tab"][aria-selected="true"]');
  const rename = bar.getByRole('textbox', { name: /^重命名/ });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function fullyVisible(item) {
    await settle();
    assert.ok(await item.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const viewport = node.closest('.panel-tabs').getBoundingClientRect();
      return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
    }), await item.getAttribute('aria-label'));
  }
  async function launch(name) {
    await button('打开工具').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  async function openFile(name) {
    await tab('文件').click();
    await page.locator(`.file-row[title="${name}"]`).click();
    await page.locator('.panel-file-preview').waitFor();
  }
  const switchTheme = value => page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, value);

  await page.locator('.chat-header').getByRole('button', { name: '进展', exact: true }).click();
  for (const name of ['Git', '新建终端', '临时聊天', '浏览器']) await launch(name);
  await tab('新标签页').waitFor();
  assert.equal(await all.count(), 0);
  const width = item => item.evaluate(node => node.getBoundingClientRect().width);
  assert.ok(await width(tab('Git')) + 12 < await width(tab('临时聊天')));
  await page.mouse.move(0, 0);
  await bar.screenshot({ path: path.join(output, 'tools-dark.png') });

  const temporary = tab('临时聊天');
  const tabBounds = () => bar.getByRole('tab').evaluateAll(nodes => nodes.map(node => {
    const { left, width } = node.getBoundingClientRect();
    return [left, width];
  }));
  await temporary.click();
  const beforeRename = await tabBounds();
  const labelBox = await temporary.locator('.panel-tab-label').boundingBox();
  await temporary.locator('.panel-tab-label').dblclick();
  assert.ok(await rename.evaluate(input => input === document.activeElement &&
    input.selectionStart === 0 && input.selectionEnd === input.value.length));
  const fieldBox = await rename.boundingBox();
  assert.ok(Math.abs(fieldBox.x - labelBox.x) <= 1);
  assert.ok(Math.abs(fieldBox.y + fieldBox.height / 2 - labelBox.y - labelBox.height / 2) <= 1);
  assert.ok(await rename.evaluate(input => {
    const field = getComputedStyle(input);
    const label = getComputedStyle(input.parentElement.querySelector('.panel-tab-label'));
    return field.fontSize === label.fontSize && field.fontWeight === label.fontWeight &&
      field.borderLeftWidth === '0px' && field.borderBottomWidth === '1px' &&
      input.clientHeight < input.closest('[role="tab"]').clientHeight;
  }));
  assert.equal(await temporary.locator('.panel-tab-close').isVisible(), false);
  await rename.press('End');
  for (const theme of ['light', 'dark']) {
    await switchTheme(theme);
    await page.mouse.move(0, 0);
    await bar.screenshot({ path: path.join(output, `rename-${theme}.png`) });
  }
  await rename.fill('尚未保存的很长的临时聊天名称');
  assert.deepEqual(await tabBounds(), beforeRename);
  await rename.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await rename.press('Escape');
  assert.ok(await temporary.evaluate(node => node === document.activeElement));
  await tab('临时聊天').dragTo(tab('终端'));
  assert.deepEqual(await bar.locator('.panel-tab-label').allTextContents(), ['进展', 'Git', '临时聊天', '终端', '新标签页']);

  await tab('新标签页').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await rename.fill('草稿');
  await rename.press('Escape');
  await page.locator('.browser-frame.is-active').evaluate(view => {
    view.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: '项目文档' }));
  });
  await tab('项目文档').waitFor();

  const handle = page.getByRole('separator', { name: '调整右侧面板宽度' });
  for (let n = 0; n < 9; n++) await handle.press('ArrowRight');
  await all.waitFor();
  assert.equal(await handle.getAttribute('aria-valuenow'), '320');
  await fullyVisible(active);
  await active.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await fullyVisible(rename);
  const narrowBounds = await tabBounds();
  const longTitle = '客户访谈记录与下一轮产品讨论';
  await rename.fill(longTitle);
  assert.deepEqual(await tabBounds(), narrowBounds);
  await handle.focus();
  assert.equal(await active.getAttribute('aria-label'), longTitle);
  await button('全屏').click();
  await all.waitFor({ state: 'detached' });
  await button('退出全屏').click();
  await all.waitFor();
  await launch('工作区文件');
  await openFile('shared.txt');
  await page.evaluate(() => window.__panelFilesQa.open('b'));
  await page.locator('.chat-heading h1').filter({ hasText: '文件会话 B' }).waitFor();
  await openFile('shared.txt');
  for (let n = 0; n < 10; n++) await openFile(`cache-${n}.txt`);
  const total = await bar.getByRole('tab').count();
  assert.ok(total >= 15);
  assert.equal(await all.getAttribute('aria-label'), `查看全部 ${total} 个标签页`);
  await fullyVisible(active);
  await all.click();
  assert.equal(await picker.getByRole('option').count(), total);
  assert.ok(await search.evaluate(node => node === document.activeElement));
  await search.fill('SHARED.TXT');
  assert.equal(await picker.getByRole('option').count(), 2);
  for (const owner of ['a', 'b']) await picker.getByRole('option', { name: new RegExp(`workspace-${owner}/`) }).waitFor();
  await search.fill('WORKSPACE-A\\SHARED');
  await search.press('Enter');
  await page.locator('.panel-file-preview').getByText(/WORKSPACE A · shared.txt/).first().waitFor();
  assert.ok(await active.evaluate(node => node === document.activeElement));
  await fullyVisible(active);

  await all.press('ArrowDown');
  await search.fill('不存在的标签');
  await picker.getByRole('status').waitFor();
  assert.equal(await picker.getByRole('option').count(), 0);
  await search.press('Enter');
  await search.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  assert.equal(await picker.count(), 1);
  await search.fill('cache-');
  await search.press('ArrowDown');
  await search.press('Enter');
  assert.equal(await active.getAttribute('aria-label'), 'cache-1.txt');
  await fullyVisible(active);
  const rail = bar.locator('.panel-tabs');
  await rail.hover();
  await page.mouse.wheel(0, 3500);
  await page.waitForFunction(() => {
    const rail = document.querySelector('.panel-tabs');
    return rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 1;
  });
  await all.click();
  await picker.locator('[aria-current="page"]').click();
  await fullyVisible(active);
  await active.press('Home');
  await bar.getByRole('tab').first().press('Enter');
  await fullyVisible(active);
  await active.press('End');
  await bar.getByRole('tab').last().press('Enter');
  await fullyVisible(active);
  await all.click();
  await search.fill('workspace-b/shared');
  await search.press('Enter');
  for (const theme of ['light', 'dark']) {
    await switchTheme(theme);
    await all.click();
    const bounds = await bar.boundingBox();
    const popup = await picker.boundingBox();
    assert.ok(popup.x >= bounds.x && popup.x + popup.width <= bounds.x + bounds.width + 1);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, `many-${theme}.png`), clip: {
      x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.floor(bounds.width),
      height: Math.ceil(popup.y + popup.height - bounds.y + 8),
    } });
    await search.press('Escape');
    assert.ok(await all.evaluate(node => node === document.activeElement));
  }
  for (let n = 0; n < 5; n++) await handle.press('ArrowLeft');
  await all.click();
  const triggerBounds = await all.boundingBox();
  const menuBounds = await picker.boundingBox();
  assert.ok(Math.abs(triggerBounds.x + triggerBounds.width - menuBounds.x - menuBounds.width) <= 1);
  await search.press('Escape');
  await all.click();
  await search.press('Tab');
  assert.ok(await button('打开工具').evaluate(node => node === document.activeElement));
  await all.click();
  await button('打开工具').click();
  assert.equal(await picker.count(), 0);
  await page.getByRole('menu', { name: '打开工具' }).press('Escape');

  await active.dblclick();
  await rename.fill('工作台标签筛选与窄面板布局回归检查');
  await rename.press('Enter');
  await all.click();
  await search.fill('窄面板');
  await picker.getByRole('option').click();
  await fullyVisible(active);
  await active.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭其他标签页', exact: true }).click();
  await all.waitFor({ state: 'detached' });
  assert.equal(await bar.getByRole('tab').count(), 1);
  await fullyVisible(active);
  assert.deepEqual(errors, []);
  console.log(`Passed five fitted tools, 320px panel with ${total} tabs, path search, keyboard/IME, scroll, focus, rename and close. Captures in ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
