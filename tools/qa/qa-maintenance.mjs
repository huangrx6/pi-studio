import { composerValue } from './fixtures/composer-editor.mjs';
/** Isolated production About/update/MCP QA. All updater and connection operations are mocked. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installMaintenanceFixture } from './fixtures/maintenance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/maintenance'); await mkdir(output, { recursive: true });
const result = { startedAt: new Date().toISOString(), scope: 'Built renderer in isolated Chromium with synthetic About/update/MCP DTOs. No real updates, downloads, restarts, network calls, OAuth or MCP connections. IME guards use composing/229 synthetic keys on read-only details; ordinary keyboard actions are real.', assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g), checks: [], screenshots: [], geometry: [], pageErrors: [], blockedRequests: [] };
const server = await serveProductionRenderer(root); let browser, page;
const update = () => page.locator('.update-dialog');
const mcp = () => page.locator('.mcp-detail-dialog');
const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__maintenanceQa[method](...args), { method, args }); await settle(); }
async function pending(method, scope = '') { await page.waitForFunction(({ method, scope }) => window.__maintenanceQa.pending(method, scope) > 0, { method, scope }); }
async function count(method, scope) { return page.evaluate(({ method, scope }) => window.__maintenanceQa.calls.filter(call => call.method === method && (scope === undefined || call.scope === scope)).length, { method, scope }); }
async function twice(locator) { await locator.evaluate(node => { node.click(); node.click(); }); }
async function openMcp(scope) { const name = await page.evaluate(scope => window.__maintenanceQa.names[scope], scope); await page.getByRole('button', { name: `查看 MCP ${name} 详情`, exact: true }).click(); await mcp().waitFor(); }
async function closeMcp() { await mcp().getByRole('button', { name: '关闭 MCP 详情', exact: true }).click(); await mcp().waitFor({ state: 'detached' }); }
async function capture(name, theme, viewport, selector) {
  await page.setViewportSize(viewport); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle();
  if (selector === '.mcp-detail-dialog') { await mcp().locator('.mcp-detail-body').evaluate(node => { node.scrollTop = 0; }); await settle(); }
  const geometry = await page.locator(selector).evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, left: box.left, right: box.right, viewport: innerWidth, overflow: node.scrollWidth > node.clientWidth + 1, rootOverflow: document.documentElement.scrollWidth > innerWidth + 1 }; });
  assert.equal(geometry.overflow, false, `${name} horizontal overflow`); assert.equal(geometry.rootOverflow, false); assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1);
  result.geometry.push({ name, ...geometry }); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(server.origin) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:4});(${installMaintenanceFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await page.locator('.assistant-response').first().waitFor();
  const draft = '维护页面与更新检查期间保留的会话草稿'; await composer().fill(draft);
  await pending('updateState'); const available = await page.evaluate(() => window.__maintenanceQa.available); await qa('emit', available); await qa('release', 'updateState');
  await page.locator('.sidebar-bottom button[title="设置"]').click(); await page.locator('.settings-navigation').getByRole('button', { name: '关于', exact: true }).click();
  await page.locator('.about-page').waitFor(); await page.locator('.about-page').getByText(/2\.5\.6/).first().waitFor();
  const aboutDetails = page.locator('.about-page details'); await aboutDetails.locator('summary').focus(); await page.keyboard.press('Enter'); assert.notEqual(await aboutDetails.getAttribute('open'), null);
  await aboutDetails.getByText('/qa/隔离数据/很长的数据库目录用于验证关于页面诊断信息换行/studio.sqlite', { exact: true }).waitFor();
  await capture('01-about-light', 'light', { width: 1440, height: 900 }, '.about-page'); await capture('02-about-dark', 'dark', { width: 980, height: 760 }, '.about-page');
  await page.locator('.about-page').getByRole('button', { name: '查看新构建', exact: true }).click(); await update().getByRole('heading', { name: '发现同版本新构建', exact: true }).waitFor();
  assert.equal(await count('checkForUpdates'), 0, 'late idle updateState response cannot erase newer available event or cause an unnecessary check');
  await update().getByText('11111111111111111111111111111111', { exact: true }).waitFor(); await update().getByText('22222222222222222222222222222222', { exact: true }).waitFor();
  await capture('03-update-build-light', 'light', { width: 1440, height: 900 }, '.update-dialog');
  await qa('emit', { state: 'error', error: 'QA 更新读取失败' }); await update().getByRole('alert').waitFor();
  await qa('fail', 'checkForUpdates'); await update().getByRole('button', { name: '重新检查', exact: true }).click(); await update().getByText(/QA checkForUpdates.*失败/).waitFor();
  await qa('hold', 'checkForUpdates'); await qa('reply', 'checkForUpdates', { ...available, state: 'up-to-date' });
  const checkBefore = await count('checkForUpdates'); await twice(update().getByRole('button', { name: '重新检查', exact: true })); await pending('checkForUpdates'); assert.equal(await count('checkForUpdates'), checkBefore + 1);
  await qa('emit', { state: 'checking' }); await update().getByRole('heading', { name: '正在检查更新', exact: true }).waitFor();
  await qa('emit', available);
  await update().getByRole('button', { name: '关闭更新窗口', exact: true }).click(); await qa('openUpdate'); await update().waitFor();
  await update().getByRole('button', { name: '下载更新', exact: true }).click(); await update().getByRole('alert').filter({ hasText: '另一项更新操作仍在进行，请稍后重试。' }).waitFor(); assert.equal(await count('downloadUpdate'), 0, 'a different pending action is rejected explicitly rather than silently substituting the older promise');
  await qa('release', 'checkForUpdates'); await update().getByRole('heading', { name: '发现同版本新构建', exact: true }).waitFor();
  await qa('emit', { state: 'error', error: 'QA 用于验证迟到失败归属' }); await qa('hold', 'checkForUpdates'); await qa('fail', 'checkForUpdates');
  await update().getByRole('button', { name: '重新检查', exact: true }).click(); await pending('checkForUpdates'); await qa('emit', available); await qa('release', 'checkForUpdates'); await update().getByRole('heading', { name: '发现同版本新构建', exact: true }).waitFor(); assert.equal(await update().getByRole('alert').count(), 0, 'late check rejection cannot replace newer available event');
  result.checks.push('About routes and local paths, same-version complete build IDs, late startup/read and check RPC cannot overwrite newer updater events, failed check retry and synchronous double-action lock');
  await qa('hold', 'downloadUpdate'); const downloadBefore = await count('downloadUpdate'); await twice(update().getByRole('button', { name: '下载更新', exact: true })); await pending('downloadUpdate'); assert.equal(await count('downloadUpdate'), downloadBefore + 1);
  for (const [progress, expected] of [[-20, '0'], [140, '100'], [NaN, null], [Infinity, null], [37, '37']]) {
    await qa('emit', { state: 'downloading', progress, transferred: -1, total: Infinity, bytesPerSecond: NaN });
    const bar = update().getByRole('progressbar', { name: '更新下载进度', exact: true }); await bar.waitFor(); assert.equal(await bar.getAttribute('aria-valuenow'), expected); assert.doesNotMatch(await update().innerText(), /NaN|Infinity|-[0-9]+%/);
  }
  await qa('emit', { state: 'downloaded', progress: 100 }); await qa('release', 'downloadUpdate'); await update().getByRole('heading', { name: '更新已下载', exact: true }).waitFor();
  await capture('04-update-ready-dark', 'dark', { width: 600, height: 760 }, '.update-dialog');
  await qa('hold', 'installUpdate'); await qa('fail', 'installUpdate'); const installBefore = await count('installUpdate'); await twice(update().getByRole('button', { name: '立即重启并更新', exact: true })); await pending('installUpdate'); assert.equal(await count('installUpdate'), installBefore + 1);
  await update().getByRole('button', { name: '关闭更新窗口', exact: true }).click(); await qa('openUpdate'); await update().waitFor();
  await twice(update().getByRole('button', { name: '立即重启并更新', exact: true })); await settle(); assert.equal(await count('installUpdate'), installBefore + 1, 'closing and reopening cannot reset the global pending install lock');
  await qa('release', 'installUpdate'); await update().getByRole('alert').filter({ hasText: /QA installUpdate.*失败/ }).waitFor(); await update().getByRole('heading', { name: '更新已下载', exact: true }).waitFor();
  await qa('hold', 'installUpdate'); await twice(update().getByRole('button', { name: '立即重启并更新', exact: true })); await pending('installUpdate'); assert.equal(await count('installUpdate'), installBefore + 2, 'explicit retry creates exactly one new install call');
  await qa('release', 'installUpdate'); await update().getByRole('button', { name: '关闭更新窗口', exact: true }).click(); await update().waitFor({ state: 'detached' });
  await qa('emit', { state: 'downloaded', progress: 100 }); assert.equal(await update().count(), 0, 'repeated downloaded state for the same target respects the closed dialog');
  result.checks.push('finite download progress clamps, nonfinite progress remains indeterminate, downloaded event survives old download RPC, mock install is deduplicated across dialog remount, failed install retains downloaded retry, repeated downloaded target stays closed');

  await page.setViewportSize({ width: 980, height: 760 }); await page.locator('.settings-navigation').getByRole('button', { name: 'MCP 服务器', exact: true }).click();
  for (const rejected of [false, true]) {
    await qa('hold', 'testSavedMcp', 'A'); if (rejected) await qa('fail', 'testSavedMcp', 'A'); await openMcp('A');
    const testsBefore = await count('testSavedMcp', 'A'); await twice(mcp().getByRole('button', { name: '测试连接', exact: true })); await pending('testSavedMcp', 'A'); assert.equal(await count('testSavedMcp', 'A'), testsBefore + 1);
    await closeMcp(); await openMcp('B'); await qa('release', 'testSavedMcp', 'A'); assert.doesNotMatch(await mcp().innerText(), /A_ONLY_TEST_RESULT|A_ONLY_TEST_DIAGNOSTIC|QA testSavedMcp A/); await closeMcp();
  }
  await qa('hold', 'startMcpOAuth', 'A'); await openMcp('A'); await twice(mcp().getByRole('button', { name: 'OAuth 登录', exact: true })); await pending('startMcpOAuth', 'A'); assert.equal(await count('startMcpOAuth', 'A'), 1);
  await closeMcp(); await openMcp('B'); const readsBeforeOldWrite = await count('settings'); await qa('release', 'startMcpOAuth', 'A'); assert.equal(await count('settings'), readsBeforeOldWrite, 'disposed A completion cannot invoke a B-bound refresh'); assert.doesNotMatch(await mcp().innerText(), /OAuth 授权完成/); await page.locator('.model-refresh-notice').getByText(/MCP 授权状态已更新/).waitFor();
  const badTest = await page.evaluate(() => ({ ...window.__maintenanceQa.testResult('B'), ok: false, instructions: 'QA_B_TEST_NOT_OK', stderr: 'QA_B_TEST_FAILURE_DIAGNOSTIC' })); await qa('reply', 'testSavedMcp', badTest, 'B'); await mcp().getByRole('button', { name: '测试连接', exact: true }).click(); await mcp().getByText('连接测试未成功', { exact: true }).waitFor(); assert.equal(await mcp().getByText('连接成功', { exact: true }).count(), 0);
  await qa('fail', 'settings'); await mcp().getByRole('button', { name: 'OAuth 登录', exact: true }).click(); await mcp().getByRole('button', { name: '重试刷新', exact: true }).waitFor();
  const oauthWrites = await count('startMcpOAuth', 'B'), failedReads = await count('settings'); assert.equal(oauthWrites, 1); assert.match(await mcp().innerText(), /授权.*完成/);
  await mcp().getByRole('button', { name: '重试刷新', exact: true }).click(); await mcp().getByRole('button', { name: '退出 OAuth', exact: true }).waitFor(); assert.equal(await count('startMcpOAuth', 'B'), oauthWrites); assert.equal(await count('settings'), failedReads + 1);
  await qa('fail', 'settings'); await mcp().getByRole('button', { name: '退出 OAuth', exact: true }).click(); await mcp().getByRole('button', { name: '重试刷新', exact: true }).waitFor(); const logoutWrites = await count('logoutMcpOAuth', 'B');
  await mcp().getByRole('button', { name: '重试刷新', exact: true }).click(); await mcp().getByRole('button', { name: 'OAuth 登录', exact: true }).waitFor(); assert.equal(await count('logoutMcpOAuth', 'B'), logoutWrites);
  result.checks.push('MCP A test success/rejection and OAuth completion after close cannot populate B; same-tick duplicate actions lock; ok:false is failure; OAuth/logout success plus failed projection retries settings only');
  // A committed credential mutation can fail inside its own runtime projection,
  // before the renderer's detail read. Recovery must never repeat that mutation.
  for (const [method, button, completedButton] of [
    ['startMcpOAuth', 'OAuth 登录', '退出 OAuth'],
    ['logoutMcpOAuth', '退出 OAuth', 'OAuth 登录'],
  ]) {
    const writesBefore = await count(method, 'B'), readsBefore = await count('settings');
    await qa('reply', method, { committed: true, projection: { status: 'error', message: 'QA 凭据已更新，但 MCP 运行时刷新未完成。' } }, 'B');
    await twice(mcp().getByRole('button', { name: button, exact: true }));
    await mcp().getByText(/QA 凭据已更新，但 MCP 运行时刷新未完成/).waitFor();
    assert.equal(await count(method, 'B'), writesBefore + 1);
    assert.equal(await count('settings'), readsBefore, 'internal projection failure waits for explicit recovery');
    await qa('hold', 'refreshMcp'); await qa('fail', 'refreshMcp');
    const refreshBefore = await count('refreshMcp');
    await twice(mcp().getByRole('button', { name: '重试刷新', exact: true })); await pending('refreshMcp');
    assert.equal(await count('refreshMcp'), refreshBefore + 1);
    await qa('release', 'refreshMcp'); await mcp().getByText(/QA refreshMcp.*失败/).waitFor();
    assert.equal(await count(method, 'B'), writesBefore + 1);
    await mcp().getByRole('button', { name: '重试刷新', exact: true }).click();
    await page.waitForFunction(label => [...document.querySelectorAll('.mcp-detail-dialog button')].some(node => node.textContent.trim() === label && !node.disabled), completedButton);
    assert.equal(await count('refreshMcp'), refreshBefore + 2);
    assert.equal(await count(method, 'B'), writesBefore + 1, 'read retry never repeats OAuth');
    assert.equal(await count('settings'), readsBefore + 1, 'recovered runtime then reads fresh detail once');
    assert.equal(await page.locator('.model-refresh-notice').count(), 0, 'current ready recovery clears the page notice');
  }
  result.checks.push('OAuth and logout internal committed projection failures retain success facts; duplicate recovery clicks share one refreshMcp; failed read retries only refreshMcp then settings and clear current pending state without repeating credentials mutation');

  await mcp().getByRole('button', { name: '测试连接', exact: true }).click(); await mcp().getByText('B_ONLY_TEST_RESULT', { exact: true }).waitFor();
  for (const text of ['连接参数', '诊断信息']) { const summary = mcp().locator('summary').filter({ hasText: text }); assert.equal(await summary.count(), 1, `${text} remains available`); await summary.focus(); await page.keyboard.press('Enter'); assert.notEqual(await summary.locator('..').getAttribute('open'), null); }
  const toolSummary = mcp().locator('summary').filter({ hasText: /^工具/ }); await toolSummary.focus(); await page.keyboard.press('Enter'); await mcp().getByText('B_tool', { exact: true }).waitFor();
  await capture('05-mcp-wide-light', 'light', { width: 1440, height: 900 }, '.mcp-detail-dialog'); await capture('06-mcp-narrow-dark', 'dark', { width: 600, height: 760 }, '.mcp-detail-dialog');
  const close = mcp().getByRole('button', { name: '关闭 MCP 详情', exact: true }); await close.focus();
  for (const props of [{ isComposing: true }, { keyCode: 229 }]) { await close.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...props }); assert.equal(await mcp().count(), 1); }
  for (let index = 0; index < 18; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]'))), true); }
  await page.keyboard.press('Escape'); await mcp().waitFor({ state: 'detached' }); await settle(); const bName = await page.evaluate(() => window.__maintenanceQa.names.B); assert.equal(await page.getByRole('button', { name: `查看 MCP ${bName} 详情`, exact: true }).evaluate(node => node === document.activeElement), true);
  await page.setViewportSize({ width: 980, height: 760 }); await openMcp('C'); await mcp().getByText('已停用', { exact: true }).waitFor(); await mcp().locator('summary').filter({ hasText: '连接参数' }).click(); await mcp().getByText(/所有工作区/).first().waitFor(); await capture('07-mcp-disabled-light', 'light', { width: 980, height: 760 }, '.mcp-detail-dialog'); await closeMcp();
  result.checks.push('MCP tools/diagnostics/connection parameters remain keyboard-accessible, long names/targets fit light and dark widths, disabled state and global scope accurate, Escape/Tab and opener focus preserved');
  await page.getByRole('button', { name: '返回对话', exact: true }).click(); assert.equal(await composerValue(composer()), draft);
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []); result.calls = await page.evaluate(() => window.__maintenanceQa.calls); assert.equal(result.calls.some(call => call.method === 'conversationSubmit'), false);
  result.passed = true; await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.failure = String(error.stack || error); if (page) { result.calls = await page.evaluate(() => window.__maintenanceQa?.calls).catch(() => []); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); } throw error; }
finally { result.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots }, null, 2));
