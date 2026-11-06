/** Full built renderer, isolated browser fixture, no real install/configuration. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installExtensionListFixture } from './fixtures/extension-lists.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'extension-lists');
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
const result = { pageErrors: [], screenshots: [], checks: [] };
let browser;
let page;
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const geometry = await page.locator('.extension-list-row').evaluateAll((rows) => rows.map((row) => ({
    overflow: row.scrollWidth > row.clientWidth + 1,
    border: getComputedStyle(row).borderTopWidth,
    actionsFit: [...row.querySelectorAll('button')].every((button) => { const box = button.getBoundingClientRect(); const parent = row.getBoundingClientRect(); return box.left >= parent.left - 1 && box.right <= parent.right + 1; }),
  })));
  assert.ok(geometry.length >= 7);
  assert.ok(geometry.every((row) => !row.overflow && row.actionsFit && row.border === '0px'), 'rows and actions fit without enclosing cards');
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(server.origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.addInitScript(installExtensionListFixture);
  await page.goto(server.origin);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.official-extension-row').first().waitFor();
  const official = page.getByRole('article', { name: '官方项目检查扩展', exact: true });
  assert.match(await official.innerText(), /主进程 Node 代码/);
  assert.match(await official.innerText(), /网络访问/);
  assert.match(await official.innerText(), /只读模型凭证/);
  const update = page.getByRole('article', { name: '可更新的官方扩展', exact: true });
  assert.match(await update.innerText(), /1 项新权限.*将启用主进程代码/);
  assert.equal(await page.getByRole('article', { name: '存在来源冲突的扩展', exact: true }).getByRole('button', { name: '安装', exact: true }).isDisabled(), true);
  await capture('01-official-light');
  await official.getByRole('button', { name: '安装', exact: true }).click();
  const installDialog = page.getByRole('dialog').filter({ has: page.locator('.extension-preview') });
  await installDialog.waitFor();
  await installDialog.getByText('受信任的主进程 Node 代码', { exact: true }).waitFor();
  assert.equal(await installDialog.getByRole('button', { name: '安装 v2.0.0', exact: true }).isDisabled(), true, 'executable preview requires existing consent before install');
  await installDialog.getByRole('button', { name: '取消', exact: true }).click();
  await installDialog.waitFor({ state: 'detached' });
  await update.getByRole('switch').click();
  await page.waitForFunction(() => window.__extensionQa.calls.some((call) => call.method === 'setOfficialExtensionAutoUpdate' && call.enabled === false));
  const longName = await page.evaluate(() => window.__extensionQa.longName);
  const installed = page.getByRole('article', { name: longName, exact: true });
  await installed.scrollIntoViewIfNeeded();
  assert.equal(await installed.locator('h3').evaluate((element) => element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) + 1), true, 'long extension names wrap into multiple readable lines');
  assert.doesNotMatch(await installed.innerText(), /qa\.long-extension-id/);
  assert.match(await installed.innerText(), /已信任/);
  await installed.getByRole('switch').click();
  await page.waitForFunction(() => document.querySelector('.installed-extension-row [role="switch"]')?.getAttribute('aria-checked') === 'false');
  await installed.getByRole('switch').click();
  await page.waitForFunction(() => document.querySelector('.installed-extension-row [role="switch"]')?.getAttribute('aria-checked') === 'true');
  assert.match(await page.getByRole('article', { name: '项目来源扩展', exact: true }).innerText(), /未信任/);
  assert.match(await page.getByRole('article', { name: '项目来源扩展', exact: true }).innerText(), /主进程代码不会加载/);
  const builtinSummary = page.locator('.builtin-extension-summary');
  assert.equal(await builtinSummary.getAttribute('aria-expanded'), null);
  assert.match(await builtinSummary.innerText(), /内置能力\s+1/);
  assert.equal(await page.getByRole('article', { name: '内置依赖能力', exact: true }).isVisible(), false, 'built-in capability stays behind one quiet disclosure');
  await builtinSummary.focus();
  assert.equal(await builtinSummary.evaluate((element) => document.activeElement === element), true, 'built-in disclosure receives keyboard focus');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.builtin-extension-section').evaluate((element) => element.open), true, 'Enter opens the native disclosure');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.builtin-extension-section').evaluate((element) => element.open), false, 'Space closes the native disclosure');
  assert.equal(await builtinSummary.evaluate((element) => document.activeElement === element), true, 'focus stays on the disclosure after closing');
  await capture('02-installed-light');
  await builtinSummary.press('Enter');
  const builtin = page.getByRole('article', { name: '内置依赖能力', exact: true });
  await builtin.waitFor();
  assert.equal(await builtin.getByRole('switch').isDisabled(), true);
  assert.match(await builtin.innerText(), /Pi Studio 内置/);
  await builtinSummary.press('Enter');
  assert.equal(await builtinSummary.evaluate((element) => document.activeElement === element), true, 'closing keeps keyboard context on the disclosure');
  await installed.getByRole('button', { name: `查看 ${longName} 详情`, exact: true }).click();
  await page.locator('.extension-detail-dialog').waitFor();
  await page.locator('.extension-detail-dialog').locator('summary').click();
  await page.locator('.extension-detail-dialog').getByText('qa.long-extension-id-that-belongs-in-details-only', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '关闭扩展详情', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('03-installed-dark');
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  await capture('04-official-dark');
  assert.deepEqual(result.pageErrors, []);
  result.checks = ['all official permissions remain visible, update consent and source conflict retained', 'install preview requires consent, no install executed', 'fixture enable/disable and auto-update callbacks', 'long names wrap, IDs retained in details, trust/dependency restrictions retained', 'built-ins stay behind a closed native disclosure and open on demand'];
  console.log(`Extension list QA passed; screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  await server.close();
}
