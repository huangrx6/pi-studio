/** Isolated production renderer QA; only synthetic in-memory APIs and private loopback assets. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsExecutionFixture } from './fixtures/settings-execution.mjs';
import { installSettingsCompletionFixture } from './fixtures/settings-completion.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/settings-completion'); await mkdir(output, { recursive: true });
const result = { checks: [], screenshots: [], pageErrors: [], blockedRequests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root); let browser; let page;
const nav = () => page.locator('.settings-navigation'); const content = () => page.locator('.settings-content');
const sub = () => page.locator('.subagent-settings'); const usage = () => page.locator('.usage-settings');
const subagentAdvanced = () => sub().locator('.subagent-advanced');
const numeric = (name) => sub().getByRole('spinbutton', { name: new RegExp(`^${name}`) });
async function settle() { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function command(method, value) { await page.evaluate(({ method, value }) => window.__settingsCompletionQa[method](value), { method, value }); await settle(); }
async function count(method) { return page.evaluate((method) => window.__settingsCompletionQa.calls.filter((call) => call.method === method).length, method); }
async function hold(method, key = true) { await page.evaluate(({ method, key }) => window.__settingsCompletionQa.hold(method, key), { method, key }); }
async function pending(method) { await page.waitForFunction((method) => window.__settingsCompletionQa.pending(method) > 0, method); }
async function calls(method, expected) { await page.waitForFunction(({ method, expected }) => window.__settingsCompletionQa.calls.filter((call) => call.method === method).length >= expected, { method, expected }); await settle(); }
async function select(label, option, scope = content()) { await scope.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('option').filter({ has: page.locator('.pi-select-option-label', { hasText: new RegExp(`^${option}$`) }) }).click(); await settle(); }
async function showSubagentAdvanced() {
  await subagentAdvanced().waitFor();
  if (!await subagentAdvanced().getAttribute('open')) await subagentAdvanced().locator('summary').click();
  await subagentAdvanced().locator('.subagent-field-grid').waitFor();
  await settle();
}
function dialog(title) { return page.getByRole('dialog', { name: title, exact: true }).or(page.getByRole('alertdialog', { name: title, exact: true })); }
async function confirm(title, action = '取消') { const modal = dialog(title); await modal.waitFor(); await modal.getByRole('button', { name: action, exact: true }).click(); await modal.waitFor({ state: 'detached' }); await settle(); }
async function openSettings(route) { if (!await nav().count()) await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: route, exact: true }).click(); }
async function openSession(id) { await command('open', id); await page.locator('.chat-heading h1').filter({ hasText: id === 'perf-0' ? '性能会话 0000' : '性能会话 0001' }).waitFor(); }
async function theme(value, route) { await nav().getByRole('button', { name: '通用', exact: true }).click(); await content().getByRole('button', { name: value, exact: true }).click(); await nav().getByRole('button', { name: route, exact: true }).click(); }
async function capture(name) { await settle(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} horizontal overflow`); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name); }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => { const url = route.request().url(); if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:8});(${installSettingsExecutionFixture.toString()})();(${installSettingsCompletionFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await page.locator('.assistant-response').first().waitFor();
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true }); const mainDraft = '子智能体配置、用量筛选与离页确认不能覆盖此会话草稿。'; await composer.fill(mainDraft);
  await command('fail', 'subagentSettings'); await openSettings('子智能体');
  await sub().getByRole('button', { name: '重新加载', exact: true }).click();
  await subagentAdvanced().waitFor();
  assert.equal(await numeric('最大并发').isVisible(), false, 'advanced runtime limits stay collapsed by default');
  assert.match(await subagentAdvanced().locator('summary').innerText(), /4 并发[\s\S]*工作树上限 8[\s\S]*预算不限/);
  await showSubagentAdvanced();
  await numeric('最大并发').waitFor();
  assert.equal(await numeric('最大并发').inputValue(), '4');
  await sub().locator('.subagent-label').filter({ hasText: /^最大并发/ }).click({ position: { x: 4, y: 8 } });
  assert.equal(await numeric('最大并发').evaluate((node) => node === document.activeElement), true, 'clicking the visible maximum-concurrency label focuses its input');
  assert.match(await sub().getByRole('button', { name: '子智能体默认模型', exact: true }).innerText(), /跟随父智能体/);
  assert.match(await sub().locator('.subagent-tool-summary').innerText(), /沿用父智能体当前工具/);
  await numeric('Token 预算').fill('123000'); await numeric('参考成本预算').fill('1.25');
  await select('子智能体预算超限策略', '阻止新任务', sub());
  await select('子智能体默认模型', 'QA 推理模型 A', sub()); await select('子智能体默认 thinking', '高', sub());
  const scope = () => sub().getByRole('group', { name: '子智能体配置范围', exact: true });
  const projectScope = () => scope().getByRole('button', { name: '指定工作区', exact: true });
  const userScope = () => scope().getByRole('button', { name: '所有工作区', exact: true });
  assert.equal(await userScope().getAttribute('aria-pressed'), 'true');
  await projectScope().click(); await confirm('放弃未保存更改？'); assert.equal(await numeric('Token 预算').inputValue(), '123000');
  await command('fail', 'saveSubagentSettings'); await sub().getByRole('button', { name: '保存配置', exact: true }).click();
  await sub().getByRole('alert').filter({ hasText: 'QA saveSubagentSettings' }).waitFor(); assert.equal(await numeric('Token 预算').inputValue(), '123000');
  await sub().getByRole('button', { name: '保存配置', exact: true }).click(); await calls('saveSubagentSettings', 2);
  const saved = await page.evaluate(() => window.__settingsCompletionQa.calls.filter((item) => item.method === 'saveSubagentSettings').at(-1));
  assert.equal(saved.scope, 'user'); assert.equal(saved.settings.budgetTokens, 123000); assert.equal(saved.settings.budgetCostUsd, 1.25); assert.equal(saved.settings.budgetAction, 'stop'); assert.equal(saved.settings.defaultModel, 'qa/model-a'); assert.equal(saved.settings.defaultThinking, 'high');
  const readTool = sub().locator('.subagent-tool-row').filter({ has: page.locator('strong', { hasText: /^read$/ }) }).getByRole('checkbox');
  await readTool.focus(); await readTool.press('Space'); assert.equal(await readTool.isChecked(), false);
  await sub().getByRole('checkbox', { name: '允许工具 write', exact: true }).uncheck();
  const lastTool = sub().getByRole('checkbox', { name: '允许工具 bash', exact: true });
  await lastTool.click(); assert.equal(await lastTool.isChecked(), true, 'removing last explicit tool cannot silently restore unrestricted parent inheritance');
  assert.equal(await count('saveSubagentSettings'), 2, 'tool draft changes never auto-save');
  await sub().getByRole('button', { name: '恢复继承', exact: true }).click(); assert.equal(await readTool.isChecked(), true);
  assert.match(await sub().locator('.subagent-tool-summary').innerText(), /沿用父智能体当前工具/);
  result.checks.push('subagent read retry, parent model/tool inheritance, budget payload, dirty scope cancel, failed save keeps draft and explicit retry, keyboard tool toggle restores inheritance');
  await projectScope().click(); await numeric('最大并发').fill('5');
  await select('子智能体目标工作区', '执行设置 B', sub()); await confirm('放弃未保存更改？'); assert.equal(await numeric('最大并发').inputValue(), '5');
  await select('子智能体目标工作区', '执行设置 B', sub()); await confirm('放弃未保存更改？', '放弃更改');
  await page.waitForFunction(() => [...document.querySelectorAll('.subagent-field input')].some((input) => input.value === '22222'));
  await showSubagentAdvanced();
  assert.equal(await numeric('最大并发').inputValue(), '7'); assert.match(await sub().innerText(), /missing_legacy_tool/);
  await select('子智能体目标工作区', '执行设置 A', sub()); await showSubagentAdvanced(); await numeric('最大并发').fill('6');
  const finished = sub().locator('[data-worktree-id="qa-finished"]'); const active = sub().locator('[data-worktree-id="qa-active"]');
  assert.equal(await active.getByRole('button', { name: '应用', exact: true }).isDisabled(), true);
  await finished.getByRole('button', { name: '应用', exact: true }).click(); await confirm('应用工作树改动？'); assert.equal(await count('applyManagedWorktree'), 0);
  await command('fail', 'managedWorktrees');
  await finished.getByRole('button', { name: '应用', exact: true }).click(); await confirm('应用工作树改动？', '应用改动'); await calls('applyManagedWorktree', 1);
  await sub().getByText(/操作已完成，但列表刷新失败/).waitFor();
  await sub().getByRole('button', { name: '重新读取工作树', exact: true }).click(); await calls('managedWorktrees', 2);
  assert.equal(await count('applyManagedWorktree'), 1, 'retrying worktree list does not apply mutation again');
  assert.equal(await numeric('最大并发').inputValue(), '6', 'settling worktree does not replace unsaved config');
  await finished.getByRole('button', { name: /^丢弃工作树 / }).click(); await confirm('丢弃这个工作树？'); assert.equal(await count('discardManagedWorktree'), 0);
  await sub().getByRole('button', { name: '清理已结束', exact: true }).click(); await confirm('清理已结束工作树？'); assert.equal(await count('cleanupManagedWorktrees'), 0);
  await sub().getByRole('button', { name: '撤销更改', exact: true }).click();
  result.checks.push('dirty workspace cancel/discard, B-specific values/missing tools, active worktree controls locked, apply/discard/cleanup confirmations, failed list refresh retries read only and preserves config draft');
  await subagentAdvanced().locator('summary').click();
  assert.equal(await numeric('最大并发').isVisible(), false, 'advanced runtime limits can be collapsed again without losing draft state');
  await capture('01-subagents-light'); await theme('深色', '子智能体'); await capture('02-subagents-dark');
  await showSubagentAdvanced();

  const leaveTitle = '丢弃未保存的设置更改？';
  await numeric('最大并发').fill('8');
  await nav().getByRole('button', { name: '子智能体', exact: true }).click();
  assert.equal(await dialog(leaveTitle).count(), 0, 'same-page navigation preserves draft without confirmation');
  await nav().getByRole('button', { name: '使用量', exact: true }).click(); await confirm(leaveTitle, '继续编辑');
  assert.equal(await numeric('最大并发').inputValue(), '8');
  await command('openMain'); await confirm(leaveTitle, '继续编辑'); assert.equal(await numeric('最大并发').inputValue(), '8');
  await command('open', 'perf-1'); await dialog(leaveTitle).waitFor();
  await command('openMain'); await confirm(leaveTitle, '丢弃并离开');
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 0001' }).waitFor();
  await command('openSettings'); await nav().waitFor(); await openSettings('子智能体');
  await showSubagentAdvanced();
  assert.equal(await numeric('最大并发').inputValue(), '4', 'discarded global draft does not persist');
  await nav().getByRole('button', { name: '使用量', exact: true }).click(); assert.equal(await dialog(leaveTitle).count(), 0);
  await openSession('perf-0'); await openSettings('子智能体');
  await showSubagentAdvanced();
  await numeric('最大并发').fill('9'); await hold('saveSubagentSettings', '/qa/synthetic/performance');
  await sub().getByRole('button', { name: '保存配置', exact: true }).click(); await pending('saveSubagentSettings');
  await command('openMain'); await confirm(leaveTitle, '继续编辑');
  assert.equal(await numeric('最大并发').inputValue(), '9');
  assert.equal(await numeric('最大并发').isDisabled(), true, 'canceling leave retains submitted pending draft and write lock');
  await command('openMain'); await confirm(leaveTitle, '丢弃并离开'); await nav().waitFor({ state: 'detached' });
  await openSession('perf-1'); await openSettings('子智能体');
  await page.getByText('正在读取子智能体运行配置…', { exact: true }).waitFor();
  await command('release', 'saveSubagentSettings');
  await showSubagentAdvanced();
  await page.waitForFunction(() => [...document.querySelectorAll('.subagent-field input')].some((input) => input.value === '9'));
  await projectScope().click(); assert.equal(await numeric('最大并发').inputValue(), '7', 'global settled write does not overwrite B project override');
  result.checks.push('shared leave guard same-page/no-dirty bypass, cancel keeps draft, native main/session/settings ingress, first pending navigation target wins, pending save leave requires explicit confirmation and remount waits for real global write');
  await openSession('perf-0'); await hold('subagentSettings', '/qa/synthetic/performance'); await openSettings('子智能体'); await pending('subagentSettings');
  await openSession('perf-1'); await openSettings('子智能体'); await showSubagentAdvanced(); await numeric('最大并发').waitFor(); await command('release', 'subagentSettings');
  await projectScope().click(); assert.equal(await numeric('最大并发').inputValue(), '7');
  result.checks.push('late A subagent read cannot replace B scope/config');
  await openSettings('权限策略');
  const secretForm = page.locator('.secret-vault-form');
  await secretForm.getByPlaceholder('TEST_TOKEN', { exact: true }).fill('QA_NOT_A_REAL_CREDENTIAL');
  await secretForm.getByPlaceholder('输入凭据值', { exact: true }).fill('synthetic-not-a-secret-value');
  await nav().getByRole('button', { name: '使用量', exact: true }).click(); await dialog(leaveTitle).waitFor();
  const guardCopy = await dialog(leaveTitle).innerText(); assert.match(guardCopy, /凭据输入/);
  assert.doesNotMatch(guardCopy, /QA_NOT_A_REAL_CREDENTIAL|synthetic-not-a-secret-value/);
  await confirm(leaveTitle, '继续编辑'); assert.equal(await secretForm.getByPlaceholder('输入凭据值', { exact: true }).inputValue(), 'synthetic-not-a-secret-value');
  await nav().getByRole('button', { name: '使用量', exact: true }).click(); await confirm(leaveTitle, '丢弃并离开');
  assert.equal(await count('setSecret'), 0);
  result.checks.push('credential-input leave guard uses generic label without reflecting values; cancel preserves input and discard never writes credentials');
  await usage().locator('.usage-token-bar i').first().waitFor();
  await settle();
  // 热力图按宽度自适应：365 天也不出现横向滚动，最后一列直接可见。
  result.heatmapInitial = await usage().locator('.usage-heatmap-scroll').evaluate((node) => {
    const viewport = node.getBoundingClientRect();
    const last = node.querySelector('.usage-heat-cell:last-child').getBoundingClientRect();
    return { scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, viewportLeft: viewport.left, viewportRight: viewport.right, lastLeft: last.left, lastRight: last.right };
  });
  assert.equal(result.heatmapInitial.scrollLeft, 0, '365-day heatmap does not scroll horizontally');
  assert.ok(result.heatmapInitial.scrollWidth <= result.heatmapInitial.clientWidth + 1, '365-day heatmap fits its column');
  assert(result.heatmapInitial.lastLeft >= result.heatmapInitial.viewportLeft - 1 && result.heatmapInitial.lastRight <= result.heatmapInitial.viewportRight + 1, 'latest day is visible without scrolling');
  const widths = await usage().locator('.usage-token-bar i').evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(node.style.width)));
  assert.deepEqual(widths, [99, 0.01, 0.99]);
  assert.match(await usage().locator('.usage-hero').innerText(), /1万|10,000/);
  const heatRange = usage().getByRole('group', { name: '热力图日期范围', exact: true });
  await heatRange.getByRole('button', { name: '90 天', exact: true }).click();
  await page.waitForFunction(() => window.__settingsCompletionQa.calls.filter((item) => item.method === 'usageSummary').at(-1)?.days === 90); await settle();
  // 模型筛选改为统一选择器：先展开触发按钮，再从 listbox 里选。
  await usage().getByRole('button', { name: '按模型筛选热力图', exact: true }).click();
  await page.getByRole('option', { name: /小占比模型 B/ }).click();
  const todayCell = usage().locator('.usage-heat-cell').last(); await todayCell.focus();
  assert.match(await todayCell.getAttribute('aria-label'), /1 tokens|1 Token/);
  const day = await todayCell.getAttribute('data-date'); await todayCell.press('ArrowUp');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-date')), day);
  assert.equal(await usage().locator('.usage-heat-cell[tabindex="0"]').count(), 1);
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-date')), day);
  const mixRange = usage().getByRole('group', { name: '模型分布时间范围', exact: true });
  await mixRange.getByRole('button', { name: '7 天', exact: true }).click(); await settle();
  await command('fail', 'usageModels'); await mixRange.getByRole('button', { name: '30 天', exact: true }).click();
  await usage().getByRole('alert').filter({ hasText: 'QA usageModels' }).waitFor(); assert.equal(await usage().locator('.usage-model-list').count(), 0, 'failed new model range cannot masquerade as previous results');
  assert((await usage().locator('.usage-token-bar').count()) > 0, 'model-mix failure does not hide independent summary');
  result.checks.push('accurate token proportions, model filter exact daily value, single-tab-stop heatmap keyboard, new range failure does not relabel old data');
  await usage().getByRole('button', { name: '重试模型分布', exact: true }).click(); await usage().locator('.usage-model-list').waitFor();
  const modelWidths = await usage().locator('.usage-model-track i').evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(node.style.width)));
  assert.deepEqual(modelWidths, [99.99, 0.01]);
  await heatRange.getByRole('button', { name: '1 年', exact: true }).click(); await settle();
  await usage().locator('.usage-heatmap-scroll').evaluate((node) => { node.scrollLeft = 0; }); await settle();
  await command('fail', 'usageSummary'); await usage().getByRole('button', { name: '刷新', exact: true }).click();
  const oldSummaryError = usage().getByRole('alert').filter({ hasText: 'QA usageSummary' }); await oldSummaryError.waitFor();
  assert.match(await oldSummaryError.innerText(), /以下显示上次读取结果/); assert.equal(await usage().locator('.usage-hero').count(), 1);
  assert.equal(await usage().locator('.usage-heatmap-scroll').evaluate((node) => node.scrollLeft), 0, 'failed same-range refresh preserves user horizontal position');
  await usage().getByRole('button', { name: '重试用量', exact: true }).click(); await oldSummaryError.waitFor({ state: 'detached' }); await settle();
  assert.equal(await usage().locator('.usage-heatmap-scroll').evaluate((node) => node.scrollLeft), 0, 'successful same-range retry preserves user horizontal position');
  await command('fail', 'usageSummary'); await heatRange.getByRole('button', { name: '180 天', exact: true }).click();
  await usage().getByRole('alert').filter({ hasText: 'QA usageSummary' }).waitFor();
  assert.equal(await usage().locator('.usage-hero').count(), 0, 'failed new summary range hides stale values');
  assert.equal(await usage().locator('.usage-model-list').count(), 1, 'summary failure leaves independent mix available');
  await usage().getByRole('button', { name: '重试用量', exact: true }).click(); await usage().locator('.usage-hero').waitFor();
  await hold('usageModels', 7); await mixRange.getByRole('button', { name: '7 天', exact: true }).click(); await pending('usageModels');
  await mixRange.getByRole('button', { name: '90 天', exact: true }).click(); await usage().locator('.usage-model-list').waitFor();
  const freshMixMeta = await usage().locator('.usage-models-meta').innerText(); await command('release', 'usageModels');
  assert.equal(await usage().locator('.usage-models-meta').innerText(), freshMixMeta, 'late seven-day result cannot overwrite ninety-day mix');
  await mixRange.getByRole('button', { name: '自定义', exact: true }).click();
  const fromDate = usage().getByRole('button', { name: /^模型分布起始日期/ }); await fromDate.click();
  await page.getByRole('dialog', { name: '选择模型分布起始日期', exact: true }).getByRole('button', { name: '今天', exact: true }).click(); await settle();
  const singleDay = await page.evaluate(() => window.__settingsCompletionQa.calls.filter((item) => item.method === 'usageModels').at(-1));
  assert.equal(singleDay.sinceDay, singleDay.untilDay, 'single-day custom range is passed unchanged');
  await fromDate.focus(); await fromDate.press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-date'));
  const beforeKeyboardDate = await page.evaluate(() => document.activeElement.getAttribute('data-date'));
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((previous) => document.activeElement?.getAttribute('data-date') && document.activeElement.getAttribute('data-date') !== previous, beforeKeyboardDate);
  await page.keyboard.press('Enter'); await settle();
  const keyboardDates = await page.evaluate(() => window.__settingsCompletionQa.calls.filter((item) => item.method === 'usageModels').at(-1));
  assert(keyboardDates.sinceDay < keyboardDates.untilDay, 'date-picker keyboard selection updates custom interval');
  result.checks.push('separate range retries, same-key stale-data disclosure and user-scroll preservation, initial latest-day visibility, summary/mix failure independence, late range response ignored, exact tiny-model share, single-day custom dates and keyboard calendar');
  await usage().locator('.usage-models-card').scrollIntoViewIfNeeded(); await capture('05-usage-models-custom-dark');
  await theme('浅色', '使用量'); await usage().locator('.usage-model-list').waitFor(); await capture('03-usage-light');
  await theme('深色', '使用量'); await usage().locator('.usage-model-list').waitFor(); await capture('04-usage-dark');
  await page.evaluate(() => { window.__settingsCompletionQa.zeroUsage = true; }); await usage().getByRole('button', { name: '刷新', exact: true }).click(); await settle();
  await usage().locator('.usage-empty-state').waitFor();
  assert.match(await usage().locator('.usage-empty-state').innerText(), /还没有使用记录/);
  assert.equal(await usage().locator('.usage-hero, .usage-heatmap-card, .usage-models-card').count(), 0, 'zero data replaces the whole analytics workbench with one empty state');
  assert.equal(await usage().getByRole('group', { name: '热力图日期范围', exact: true }).count(), 0, 'zero data hides the meaningless range switch');
  await capture('06-usage-empty-dark');
  await openSession('perf-0'); assert.equal(await composer.inputValue(), mainDraft);
  assert.equal(await page.evaluate(() => window.__performanceQa.submitCalls), 0); assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []);
  result.calls = await page.evaluate(() => window.__settingsCompletionQa.calls); await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots, pageErrors: result.pageErrors }, null, 2));
