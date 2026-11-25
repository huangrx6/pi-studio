/** Exercise the production extension library with an in-memory desktop bridge. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installExtensionListFixture } from './fixtures/extension-lists.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'extension-lists');
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
const result = { pageErrors: [], screenshots: [], checks: [] };
let browser;
let page;

async function openLibrary(mode = '') {
  await page.goto(server.origin + (mode ? '?library=' + mode : ''));
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tab', { name: '扩展', exact: true }).click();
  await page.locator('.installed-extension-section').waitFor();
}
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await page.locator('.extension-card-open:visible').evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1)));
  await page.locator('.plugin-workspace').screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:1});(${installExtensionListFixture})();` });
  await openLibrary();

  const library = page.locator('.installed-extension-section');
  const longName = await page.evaluate(() => window.__extensionQa.longName);
  const card = name => library.getByRole('article', { name, exact: true });
  const opener = name => page.getByRole('button', { name: `打开 ${name} 设置`, exact: true });
  const detail = page.locator('.extension-detail-dialog');
  const close = async () => {
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'detached' });
  };
  await card(longName).waitFor();
  assert.equal(await library.getByRole('article').count(), 3);
  assert.equal(await library.getByRole('switch').count(), 0);
  assert.equal(await card(longName).getByRole('button').count(), 1);
  assert.doesNotMatch(await card(longName).innerText(), /qa\.long-extension-id/);
  const title = card(longName).locator('strong');
  assert.equal(await title.getAttribute('title'), longName);
  assert.ok(await title.evaluate(node => node.clientHeight <= 2 * parseFloat(getComputedStyle(node).lineHeight) + 1));
  await capture('01-grid-light');

  await opener(longName).press('Enter');
  await detail.getByRole('heading', { name: longName, exact: true }).waitFor();
  await detail.getByRole('switch').click();
  await detail.getByRole('switch', { name: `启用 ${longName}`, checked: false }).waitFor();
  await detail.locator('details.extension-detail-technical > summary').click();
  await detail.getByText('qa.long-extension-id-that-belongs-in-details-only', { exact: true }).first().waitFor();
  await close();
  await card(longName).getByText('已停用', { exact: true }).waitFor();
  assert.equal(await opener(longName).evaluate(node => document.activeElement === node), true);
  await opener(longName).click();
  await detail.getByRole('switch').click();
  await detail.getByRole('switch', { name: `停用 ${longName}`, checked: true }).waitFor();
  await detail.getByRole('button', { name: `卸载 ${longName}` }).click();
  const confirm = page.getByRole('alertdialog', { name: '卸载扩展？' });
  await confirm.getByRole('button', { name: '取消' }).click();
  await confirm.waitFor({ state: 'detached' });
  await detail.waitFor();
  await close();
  result.checks.push('card status updates, keyboard focus returns, cancellation preserves the extension and its settings');

  await card('项目来源扩展').getByText('等待信任', { exact: true }).waitFor();
  await opener('项目来源扩展').click();
  await detail.getByText('项目扩展尚未信任，主进程代码不会加载。', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '信任扩展', exact: true }).click();
  await page.getByRole('dialog', { name: '信任扩展？' }).getByRole('button', { name: '取消' }).click();
  await detail.waitFor();
  await close();
  await opener('图表工作台').click();
  assert.equal(await detail.getByRole('button', { name: '卸载 图表工作台' }).count(), 0);
  const source = detail.locator('details.extension-detail-source');
  assert.equal(await source.getAttribute('open'), null);
  await source.locator('summary').click();
  await detail.getByText('由插件统一卸载。', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '前往插件页', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '插件', exact: true, selected: true }).waitFor();
  await page.getByRole('tab', { name: '扩展', exact: true }).click();

  const builtinSummary = page.locator('.builtin-extension-summary');
  await builtinSummary.press('Enter');
  await opener('内置依赖能力').click();
  assert.ok(await detail.getByRole('switch').isDisabled());
  await detail.getByText('其他已启用能力依赖此扩展。', { exact: true }).waitFor();
  assert.equal(await detail.getByRole('button', { name: /卸载/ }).count(), 0);
  await close();
  assert.equal(await library.getByRole('group', { name: '扩展排列方式' }).count(), 0);
  await page.setViewportSize({ width: 780, height: 720 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('02-grid-narrow-dark');
  await builtinSummary.press('Space');
  await opener('内置依赖能力').waitFor({ state: 'hidden' });
  result.checks.push('cards-only layout for built-ins and installed items, long titles and narrow layouts fit, project trust and plugin/dependency restrictions preserved');

  await library.getByRole('button', { name: '发布者公钥' }).click();
  const keys = page.getByRole('dialog', { name: '发布者公钥' });
  await keys.getByText('qa-fixture-key', { exact: true }).waitFor();
  await keys.getByRole('button', { name: '撤销', exact: true }).click();
  const revoke = page.getByRole('dialog', { name: '撤销发布者公钥？' });
  await revoke.getByRole('button', { name: '取消' }).click();
  await keys.waitFor();
  await keys.getByRole('button', { name: '关闭发布者公钥' }).click();
  await keys.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '安装扩展', exact: true }).click();
  const install = page.getByRole('dialog');
  await install.getByRole('button', { name: '选择扩展开发目录' }).click();
  await install.getByRole('button', { name: '校验并预览' }).click();
  await install.getByText('受信任的主进程 Node 代码', { exact: true }).waitFor();
  assert.ok(await install.getByRole('button', { name: '安装 v2.0.0' }).isDisabled());
  await install.getByRole('button', { name: '取消', exact: true }).click();
  result.checks.push('publisher keys/revocation and local install preview are reachable without changing real data');

  await openLibrary('builtins');
  await library.getByText('还没有安装扩展').waitFor();
  await builtinSummary.waitFor();
  await openLibrary('empty');
  await library.getByText('还没有安装扩展').waitFor();
  assert.equal(await page.locator('.builtin-extension-section').count(), 0);
  assert.equal(await library.getByRole('group', { name: '扩展排列方式' }).count(), 0);
  assert.deepEqual(result.pageErrors, []);
  result.checks.push('built-ins-only and completely empty libraries show appropriate entry points');
  console.log('Extension library layouts, settings, keyboard navigation and empty states passed.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  await server.close();
}
