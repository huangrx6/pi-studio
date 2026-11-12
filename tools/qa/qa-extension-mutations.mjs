import { composerValue } from './fixtures/composer-editor.mjs';
/** Production renderer; synthetic extension mutations only, never installs or executes extension code. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installResourceDetailsFixture } from './fixtures/resource-details.mjs';
import { installExtensionMutationFixture } from './fixtures/extension-mutations.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/extension-mutations'); await mkdir(output, { recursive: true });
const result = { startedAt: new Date().toISOString(), assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g), checks: [], screenshots: [], pageErrors: [], blockedRequests: [] };
const server = await serveProductionRenderer(root); let browser, page;
const draft = '扩展操作与恢复期间保留的主会话草稿';
const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
const refresh = () => page.getByRole('button', { name: '刷新扩展状态', exact: true });
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__extensionMutationQa[method](...args), { method, args }); await settle(); }
async function count(method) { return page.evaluate(method => window.__extensionMutationQa.calls.filter(call => call.method === method).length, method); }
async function twice(locator) { await locator.evaluate(node => { node.click(); node.click(); }); }
async function openSettings() {
  if (!(await page.locator('.settings-navigation').isVisible())) await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.installed-extension-row').first().waitFor();
}
async function fresh() {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(server.origin) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:2});(${installResourceDetailsFixture.toString()})();(${installExtensionMutationFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await composer().fill(draft); await openSettings();
}
async function start(method) {
  const project = method === 'setExtensionTrusted';
  const row = page.getByRole('article', { name: project ? '项目扩展与依赖状态' : /零声明权限的可执行扩展/ });
  if (method === 'setExtensionEnabled') { await twice(row.getByRole('switch')); return; }
  if (method === 'removeExtension') await row.getByRole('button', { name: /^卸载 / }).click();
  else {
    await row.getByRole('button', { name: /^查看 .* 详情$/ }).click();
    await page.locator('.extension-detail-dialog').getByRole('button', { name: project ? '信任扩展' : '回滚版本', exact: true }).click();
  }
  await twice(page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: method === 'removeExtension' ? '卸载扩展？' : project ? '信任扩展？' : '回滚扩展版本？', exact: true }) })).getByRole('button', { name: method === 'removeExtension' ? '卸载扩展' : project ? '信任并启用' : '回滚版本', exact: true }));
}
async function closeDetail() { const close = page.getByRole('button', { name: '关闭扩展详情', exact: true }); if (await close.isVisible()) await close.click(); }
async function capture(name, dark = false) {
  await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
  if (dark) await page.setViewportSize({ width: 600, height: 640 });
  await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const rows = await page.locator('.installed-extension-row').evaluateAll(rows => rows.map(row => row.scrollWidth <= row.clientWidth + 1)); assert.ok(rows.every(Boolean));
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [index, method] of ['setExtensionEnabled', 'setExtensionTrusted', 'removeExtension', 'rollbackExtension'].entries()) {
    await fresh(); await qa('hold', method); await start(method);
    await page.waitForFunction(method => window.__extensionMutationQa.pending(method) === 1, method);
    assert.equal(await count(method), 1, 'same-tick actions submit one mutation');
    await qa('release', method); await closeDetail(); await refresh().waitFor();
    assert.equal(await page.locator('.installed-extension-row').getByRole('switch').first().isDisabled(), true, 'pending receipt prevents a second mutation');
    await capture(`${index + 1}-committed-${method}`, index % 2 === 1);
    await qa('hold', 'refreshExtensionMutation'); await qa('fail', 'refreshExtensionMutation'); await twice(refresh());
    await page.waitForFunction(() => window.__extensionMutationQa.pending('refreshExtensionMutation') === 1);
    assert.equal(await count('refreshExtensionMutation'), 1); await qa('release', 'refreshExtensionMutation');
    await page.getByText(/QA refreshExtensionMutation 读取失败/).waitFor(); assert.equal(await count(method), 1);
    // Receipt reaches ready, but current-workspace settings fails: next retry must only reread settings.
    await qa('fail', 'settings'); await refresh().click(); await page.getByText(/QA settings 读取失败/).waitFor();
    assert.equal(await count('refreshExtensionMutation'), 2); await refresh().click(); await refresh().waitFor({ state: 'detached' });
    assert.equal(await count('refreshExtensionMutation'), 2, 'ready receipt does not repeat recovery side effects');
    assert.equal(await count(method), 1); assert.equal(await count('disposeExtensionMutationRecovery'), 1);
    await page.getByRole('button', { name: '返回对话', exact: true }).click(); assert.equal(await composerValue(composer()), draft);
    result.checks.push(`${method}: committed error, synchronous lock, failed recovery then ready, failed current snapshot read retries without mutation/recovery repeat, draft retained`);
  }
  await fresh(); await qa('hold', 'rollbackExtension'); await start('rollbackExtension');
  await page.waitForFunction(() => window.__extensionMutationQa.pending('rollbackExtension') === 1);
  await closeDetail(); await qa('open', 'perf-1'); await page.locator('[data-session-id="perf-1"] .session-row.is-active').waitFor(); await composer().fill('B 工作区草稿不被 A 操作污染');
  await qa('release', 'rollbackExtension'); await openSettings(); await refresh().waitFor();
  await refresh().click(); await refresh().waitFor({ state: 'detached' });
  const calls = await page.evaluate(() => window.__extensionMutationQa.calls);
  assert.equal(calls.filter(call => call.method === 'rollbackExtension').length, 1);
  assert.equal(calls.find(call => call.method === 'refreshExtensionMutation').input.cwd, '/qa/synthetic/performance', 'receipt recovery remains bound to source A');
  assert.equal(calls.filter(call => call.method === 'settings').at(-1).input.cwd, '/qa/synthetic/resource-details-b', 'current snapshot reads B');
  await page.getByRole('button', { name: '返回对话', exact: true }).click(); assert.equal(await composerValue(composer()), 'B 工作区草稿不被 A 操作污染');
  await qa('open', 'perf-0'); await page.waitForFunction(expected => document.querySelector('.composer-editor')?.textContent === expected, draft);
  result.checks.push('held rollback after detail close/native navigation retains receipt; recovers source A then reads B, preserves both drafts');
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []);
  await rm(path.join(output, 'failure.png'), { force: true }); console.log(`Extension mutation QA passed (${result.checks.length} groups)`);
} catch (error) { result.error = String(error.stack || error); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { result.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); if (browser) await browser.close(); await server.close(); }
