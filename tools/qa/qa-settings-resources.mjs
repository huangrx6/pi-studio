/** Built renderer resource-settings QA. Synthetic APIs only; no user data/process/provider/install. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsResourcesFixture } from './fixtures/settings-resources.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/settings-resources');
await mkdir(output, { recursive: true });
const result = { startedAt: new Date().toISOString(), scope: 'Production renderer with in-memory resources. No actual model/provider/MCP/process/skill writes or external requests. Native keyboard confirmation and UI are real.', checks: [], pageErrors: [], blockedRequests: [], screenshots: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root);
let browser;
let page;
const nav = () => page.locator('.settings-navigation');
const content = () => page.locator('.settings-content');
const callCount = (method) => page.evaluate((key) => window.__settingsResourcesQa.calls.filter((call) => call.method === key).length, method);
async function calls(method, count) { await page.waitForFunction(({ method, count }) => window.__settingsResourcesQa.calls.filter((call) => call.method === method).length === count, { method, count }); }
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function control(method, ...args) { await page.evaluate(({ method, args }) => window.__settingsResourcesQa[method](...args), { method, args }); await settle(); }
async function pending(method) { await page.waitForFunction(method => window.__settingsResourcesQa.pending(method) > 0, method); }
async function twice(locator) { await locator.evaluate(node => { node.click(); node.click(); }); }
async function recover(domain, writeMethod) {
  const [readMethod, label] = { models: ['refreshModels', '刷新模型配置'], mcp: ['refreshMcp', '刷新 MCP 状态'], skills: ['refreshSkills', '刷新技能状态'] }[domain];
  const writeCount = await callCount(writeMethod), readCount = await callCount(readMethod);
  await control('hold', readMethod); await control('fail', readMethod); await twice(content().getByRole('button', { name: label, exact: true })); await pending(readMethod); assert.equal(await callCount(readMethod), readCount + 1); await control('release', readMethod); await content().getByRole('button', { name: label, exact: true }).waitFor(); await settle();
  await twice(content().getByRole('button', { name: label, exact: true })); await content().getByRole('button', { name: label, exact: true }).waitFor({ state: 'detached' }); assert.equal(await callCount(readMethod), readCount + 2); assert.equal(await callCount(writeMethod), writeCount);
}
async function focused(locator) { await page.waitForFunction((node) => document.activeElement === node, await locator.elementHandle()); }
async function theme(value, route) { await nav().getByRole('button', { name: '通用', exact: true }).click(); await content().getByRole('button', { name: value, exact: true }).click(); await nav().getByRole('button', { name: route, exact: true }).click(); }
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: page horizontal overflow`);
  const overflows = await page.locator('.model-settings, .mcp-server-row, .installed-skill-row').evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 2).map((node) => ({ class: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth })));
  assert.deepEqual(overflows, [], `${name}: resource rows fit narrow window`);
  if (await page.locator('.model-settings').count()) {
    const gaps = await page.locator('.model-settings > .model-settings-section').evaluateAll((nodes) => nodes.slice(1).map((node, index) => node.getBoundingClientRect().top - nodes[index].getBoundingClientRect().bottom));
    assert(gaps.length >= 2 && gaps.every((gap) => gap >= 24), `${name}: actual section gaps >=24px, got ${gaps.join(', ')}`);
    (result.sectionGaps ??= {})[name] = gaps;
  }
  const hubGeometry = await page.locator('.skill-hub-card .skill-hub-search, .skill-hub-card .skill-hub-actions > button').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), card = node.closest('.skill-hub-card').getBoundingClientRect();
    return { control: node.getAttribute('aria-label') || node.textContent.trim() || node.className, left: box.left, right: box.right, cardLeft: card.left, cardRight: card.right, visible: box.width > 0 && box.height > 0 };
  }));
  assert.deepEqual(hubGeometry.filter(box => box.visible && (box.left < box.cardLeft - 1 || box.right > box.cardRight + 1)), [], `${name}: skill source search/actions stay inside their card`);
  (result.hubGeometry ??= []).push({ name, controls: hubGeometry });
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push(name);
}
async function cancelConfirm(title) { const dialog = page.getByRole(title.startsWith('删除') ? 'alertdialog' : 'dialog', { name: title, exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => { const url = route.request().url(); if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:8});(${installSettingsResourcesFixture.toString()})();` });
  await page.goto(server.origin);
  await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click();
  await page.locator('.assistant-response').first().waitFor();
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const draft = '设置模型、连接和技能时，请保留当前会话的草稿。';
  await composer.fill(draft);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav().getByRole('button', { name: '模型配置', exact: true }).click();
  await page.locator('.model-settings').waitFor();
  assert.equal(await content().getByRole('button', { name: '添加模型来源', exact: true }).count(), 1, 'single primary add-provider action');
  const defaults = content().getByRole('button', { name: '新对话默认模型', exact: true });
  await defaults.click();
  await page.getByRole('option').filter({ has: page.locator('.pi-select-option-label', { hasText: /^新的默认模型$/ }) }).click();
  await calls('setDefaultModel', 1);
  await content().getByRole('button', { name: '新对话默认思考强度', exact: true }).click();
  await page.getByRole('option').filter({ has: page.locator('.pi-select-option-label', { hasText: /^High$/ }) }).click();
  await calls('setDefaultThinkingLevel', 1);
  await nav().getByRole('button', { name: '返回对话', exact: true }).click();
  assert.match(await page.locator('.model-label').innerText(), /当前会话模型/);
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await callCount('conversationConfigure'), 0);
  result.checks.push('new-conversation model/thinking defaults write explicit workspace scope without changing the open session or draft');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const { longProvider, longMcp, longSkill } = await page.evaluate(() => window.__settingsResourcesQa);
  const provider = page.locator('[data-provider-id="qa"]');
  await provider.getByRole('button', { name: '管理模型', exact: true }).click();
  await provider.getByText('QA 模拟目录暂时不可用', { exact: true }).waitFor();
  await provider.getByRole('button', { name: '重新加载模型目录', exact: true }).click();
  const modelRows = provider.locator('.provider-model-row');
  await page.waitForFunction(() => document.querySelectorAll('[data-provider-id="qa"] .provider-model-row').length === 100);
  const loadMore = provider.getByRole('button', { name: '加载更多模型', exact: true });
  for (const [expected, firstNew] of [[200, 100], [300, 200], [350, 300]]) {
    await loadMore.click();
    await page.waitForFunction((count) => document.querySelectorAll('[data-provider-id="qa"] .provider-model-row').length === count, expected);
    await focused(provider.locator(`[data-model-id="qa/model-${firstNew}"] input[type="checkbox"]`));
  }
  assert.equal(await loadMore.count(), 0, 'the whole 350-model catalog can be reached');
  const search = provider.getByRole('textbox', { name: `搜索 ${longProvider} 的模型`, exact: true });
  await search.fill('目录末端模型');
  await page.waitForFunction(() => document.querySelectorAll('[data-provider-id="qa"] .provider-model-row').length === 1);
  assert.match(await modelRows.innerText(), /0349/);
  const lastCheckbox = modelRows.getByRole('checkbox');
  await lastCheckbox.focus();
  await lastCheckbox.press('Space');
  await calls('setEnabledModels', 1);
  assert.equal(await lastCheckbox.isChecked(), true);
  await lastCheckbox.press('Space');
  await calls('setEnabledModels', 2);
  assert.equal(await lastCheckbox.isChecked(), false);
  await search.fill('');
  await provider.getByRole('button', { name: '获取模型', exact: true }).click();
  await calls('discoverProviderModels', 1);
  await provider.getByRole('checkbox', { name: '已添加模型 当前会话模型', exact: true }).waitFor();
  assert.equal(await provider.getByRole('checkbox', { name: '已添加模型 当前会话模型', exact: true }).isDisabled(), true);
  const discovered = provider.getByRole('checkbox', { name: '选择模型 发现的新模型', exact: true });
  await discovered.focus(); await discovered.press('Space');
  await provider.getByRole('button', { name: '添加所选 1 个', exact: true }).click();
  await calls('importProviderModels', 1);
  assert.deepEqual(await page.evaluate(() => window.__settingsResourcesQa.calls.find((call) => call.method === 'importProviderModels').models.map((item) => item.id)), ['discovered-new']);
  await ensureCatalog(); await provider.getByRole('button', { name: '获取模型', exact: true }).click();
  await provider.getByRole('checkbox', { name: '已添加模型 发现的新模型', exact: true }).waitFor();
  await page.locator('[data-enabled-model-id="qa/discovered-new"] strong').filter({ hasText: /^发现的新模型$/ }).waitFor();
  result.checks.push('350-model full pagination and global search, keyboard enable/disable, discovery selection imports only the chosen model');
  await provider.getByRole('button', { name: `编辑 ${longProvider}`, exact: true }).click();
  await page.getByRole('dialog', { name: '编辑模型来源', exact: true }).waitFor();
  assert.equal(await page.getByLabel('服务地址', { exact: true }).inputValue(), 'https://qa.invalid/v1');
  await page.getByRole('dialog', { name: '编辑模型来源', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await provider.getByRole('switch', { name: `停用模型来源 ${longProvider}`, exact: true }).click();
  await calls('setProviderEnabled', 1);
  await content().getByText('模型来源已停用，请先启用来源或选择其他模型。', { exact: true }).waitFor();
  await provider.getByRole('switch', { name: `启用模型来源 ${longProvider}`, exact: true }).click();
  await calls('setProviderEnabled', 2);
  assert.match(await content().innerText(), /环境变量未设置/);
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  await capture('01-models-light');
  await theme('深色', '模型配置');
  await provider.locator('.model-settings-provider-heading').scrollIntoViewIfNeeded();
  assert.equal(await provider.locator('h3').first().evaluate((node) => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) + 1), true, 'long provider name wraps');
  await capture('02-models-dark');
  const deleteProvider = content().getByRole('button', { name: '删除模型来源 缺少认证的来源', exact: true });
  await deleteProvider.click(); await cancelConfirm('删除模型来源？');
  assert.equal(await callCount('removeProvider'), 0);
  result.checks.push('provider editor, explicit unavailable reason, source enable/disable, destructive source deletion requires confirmation');

  await nav().getByRole('button', { name: 'MCP 服务器', exact: true }).click();
  const mcpRow = (name) => page.locator('.mcp-server-row').filter({ has: page.getByRole('button', { name: `查看 MCP ${name} 详情`, exact: true }) });
  for (const [name, state, text] of [['已停用服务', 'disabled', '已停用'], ['等待连接服务', 'waiting', '等待连接'], [longMcp, 'error', '连接异常'], ['已连接零工具服务', 'connected', '已连接']]) {
    const item = mcpRow(name); await item.waitFor(); assert.equal(await item.getAttribute('data-state'), state); assert.match(await item.innerText(), new RegExp(text));
  }
  assert.match(await mcpRow('已连接零工具服务').innerText(), /0\s*个工具/);
  assert.doesNotMatch(await mcpRow('等待连接服务').innerText(), /连接异常/);
  await mcpRow(longMcp).getByText('查看错误', { exact: true }).click();
  assert.match(await mcpRow(longMcp).locator('pre').innerText(), /用户明确发起测试/);
  await capture('03-mcp-dark');
  await theme('浅色', 'MCP 服务器');
  await capture('04-mcp-light');
  const zeroDetails = mcpRow('已连接零工具服务').getByRole('button', { name: '查看 MCP 已连接零工具服务 详情', exact: true });
  await zeroDetails.focus(); await zeroDetails.press('Enter');
  await page.locator('.mcp-detail-dialog').waitFor();
  assert.match(await page.locator('.mcp-detail-status[data-state="connected"]').innerText(), /0\s*个工具/);
  await page.getByRole('button', { name: '关闭 MCP 详情', exact: true }).click();
  await mcpRow('等待连接服务').getByRole('button', { name: '查看 MCP 等待连接服务 详情', exact: true }).click();
  await page.locator('.mcp-detail-status[data-state="waiting"]').waitFor();
  assert.equal(await page.locator('.mcp-detail-status').innerText(), '等待连接');
  await page.getByRole('button', { name: '关闭 MCP 详情', exact: true }).click();
  const disabledSwitch = mcpRow('已停用服务').getByRole('switch');
  await disabledSwitch.focus(); await disabledSwitch.press('Space');
  await calls('setMcpEnabled', 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.mcp-server-row')].find((node) => node.textContent.includes('已停用服务'))?.getAttribute('data-state') === 'waiting');
  await disabledSwitch.press('Space'); await calls('setMcpEnabled', 2);
  const deleteMcp = mcpRow('已停用服务').getByRole('button', { name: '删除 MCP 已停用服务', exact: true });
  await deleteMcp.click(); await cancelConfirm('删除 MCP 服务器？');
  assert.equal(await callCount('removeMcp'), 0);
  await deleteMcp.click();
  await page.getByRole('alertdialog', { name: '删除 MCP 服务器？', exact: true }).getByRole('button', { name: '删除服务器', exact: true }).click();
  await calls('removeMcp', 1);
  await mcpRow('已停用服务').waitFor({ state: 'detached' });
  result.checks.push('MCP disabled/waiting/error/connected-zero are distinct; full error/details accessible, keyboard toggle and confirmed mock delete');

  await nav().getByRole('button', { name: '技能', exact: true }).click();
  const skillRow = (name) => page.locator('.installed-skill-row').filter({ has: page.getByRole('button', { name: `查看技能 ${name}`, exact: true }) });
  await skillRow(longSkill).waitFor();
  assert.match(await skillRow(longSkill).innerText(), /内容已变化/);
  assert.equal(await skillRow(longSkill).getAttribute('data-availability'), 'unavailable');
  assert.match(await skillRow('待信任项目共享技能').innerText(), /等待信任/);
  assert.match(await skillRow('显式调用技能').innerText(), /仅显式调用/);
  assert.equal(await skillRow('可用项目技能').getAttribute('data-invocation'), 'auto');
  assert.match(await skillRow('可用项目技能').evaluate((node) => node.closest('section').innerText), /默认自动发现/);
  for (const [name, group] of [['显式调用技能', 'Studio 应用技能'], ['用户共享技能', '共享技能'], [longSkill, 'Studio 项目技能'], ['待信任项目共享技能', '项目共享技能']]) assert.match(await skillRow(name).evaluate((node) => node.closest('section').innerText), new RegExp(group));
  await content().getByText('/qa/project/studio/unreadable/SKILL.md', { exact: true }).waitFor();
  await skillRow(longSkill).scrollIntoViewIfNeeded();
  assert.equal(await skillRow(longSkill).locator('strong').evaluate((node) => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) + 1), true, 'long skill name wraps');
  await capture('05-skills-light');
  await skillRow(longSkill).getByRole('button', { name: '重新信任', exact: true }).click();
  await cancelConfirm('信任项目技能？');
  assert.equal(await callCount('setSkillTrusted'), 0);
  await skillRow(longSkill).getByRole('button', { name: '重新信任', exact: true }).click();
  const trustDialog = page.getByRole('dialog', { name: '信任项目技能？', exact: true });
  assert.match(await trustDialog.innerText(), /运行脚本或修改文件/);
  await page.evaluate(() => { window.__settingsResourcesQa.failNextTrust = true; });
  await trustDialog.getByRole('button', { name: '信任技能', exact: true }).click();
  await calls('setSkillTrusted', 1);
  await content().getByText('QA setSkillTrusted 写入或读取失败', { exact: true }).waitFor();
  assert.equal(await skillRow(longSkill).getAttribute('data-availability'), 'unavailable', 'failed trust write never enables the skill');
  await skillRow(longSkill).getByRole('button', { name: '重新信任', exact: true }).click();
  await page.getByRole('dialog', { name: '信任项目技能？', exact: true }).getByRole('button', { name: '信任技能', exact: true }).click();
  await calls('setSkillTrusted', 2);
  await page.waitForFunction((name) => [...document.querySelectorAll('.installed-skill-row')].find((node) => node.textContent.includes(name))?.getAttribute('data-availability') === 'available', longSkill);
  const skillDelete = skillRow('显式调用技能').getByRole('button', { name: '删除技能 显式调用技能', exact: true });
  await skillDelete.click(); await cancelConfirm('删除技能？');
  assert.equal(await callCount('removeSkill'), 0);
  await skillDelete.click();
  await page.getByRole('alertdialog', { name: '删除技能？', exact: true }).getByRole('button', { name: '删除技能', exact: true }).click();
  await calls('removeSkill', 1);
  await skillRow('显式调用技能').waitFor({ state: 'detached' });
  await theme('深色', '技能');
  await skillRow(longSkill).scrollIntoViewIfNeeded();
  await capture('06-skills-dark');
  await nav().getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await composer.inputValue(), draft);
  assert.match(await page.locator('.model-label').innerText(), /当前会话模型/);
  result.checks.push('installed skill scopes and explicit invocation remain visible; changed/untrusted stay unavailable until explicit confirmation; failed trust save remains visible and explicit retry requires confirmation; cancel never writes, confirmed trust/delete mock only; draft preserved');
  // Round 18: mutations that committed in main but could not build their projection.
  await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: '模型配置', exact: true }).click();
  async function ensureCatalog(query = '') {
    const expand = provider.getByRole('button', { name: '管理模型', exact: true }); if (await expand.count()) await expand.click();
    await provider.getByRole('textbox', { name: `搜索 ${longProvider} 的模型`, exact: true }).fill(query); await settle();
  }
  async function modelBlocked() {
    assert.equal(await provider.getByRole('switch').isDisabled(), true);
    assert.equal(await content().getByRole('button', { name: '删除模型来源 缺少认证的来源', exact: true }).isDisabled(), true);
    assert.equal(await content().getByRole('button', { name: '添加模型来源', exact: true }).isEnabled(), true, 'bad configuration can still be repaired while projection recovery is pending');
    assert.equal(await provider.getByRole('button', { name: `编辑 ${longProvider}`, exact: true }).isEnabled(), true);
  }
  await ensureCatalog('目录末端模型');
  const enabledWrites = await callCount('setEnabledModels'); await control('hold', 'setEnabledModels'); await control('commitError', 'setEnabledModels'); await twice(provider.locator('[data-model-id="qa/model-349"] input'));
  await pending('setEnabledModels'); assert.equal(await callCount('setEnabledModels'), enabledWrites + 1); await control('release', 'setEnabledModels'); await content().getByRole('button', { name: '刷新模型配置', exact: true }).waitFor(); await modelBlocked();
  await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; }); await capture('07-model-toggle-committed-dark'); await recover('models', 'setEnabledModels'); await ensureCatalog('目录末端模型'); assert.equal(await provider.locator('[data-model-id="qa/model-349"] input').isChecked(), true);

  const providerWrites = await callCount('setProviderEnabled'); await control('hold', 'setProviderEnabled'); await control('commitError', 'setProviderEnabled'); await twice(provider.getByRole('switch')); await pending('setProviderEnabled'); assert.equal(await callCount('setProviderEnabled'), providerWrites + 1); await control('release', 'setProviderEnabled'); await content().getByRole('button', { name: '刷新模型配置', exact: true }).waitFor(); await modelBlocked(); await recover('models', 'setProviderEnabled');
  assert.equal(await provider.getByRole('switch').getAttribute('aria-checked'), 'false'); await provider.getByRole('switch').press('Space'); await page.waitForFunction(() => document.querySelector('[data-provider-id="qa"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
  result.checks.push('model/provider switches use same-task synchronous lock; committed projection failure blocks repeated stale writes but keeps edit/add repair paths; failed/successful refreshModels retries never repeat mutation');

  await ensureCatalog(); await provider.getByRole('button', { name: '获取模型', exact: true }).click(); await provider.getByRole('checkbox', { name: '选择模型 另一个发现模型', exact: true }).check();
  const importWrites = await callCount('importProviderModels'); await control('hold', 'importProviderModels'); await control('commitError', 'importProviderModels'); await twice(provider.getByRole('button', { name: '添加所选 1 个', exact: true })); await pending('importProviderModels'); assert.equal(await callCount('importProviderModels'), importWrites + 1); await control('release', 'importProviderModels'); await content().getByRole('button', { name: '刷新模型配置', exact: true }).waitFor();
  const stillSelected = provider.getByRole('checkbox', { name: '选择模型 另一个发现模型', exact: true }); if (await stillSelected.count()) assert.equal(await stillSelected.isChecked(), false, 'committed imports are no longer selected for resubmission');
  await modelBlocked(); await recover('models', 'importProviderModels'); await ensureCatalog('另一个发现模型'); assert.equal(await provider.locator('[data-model-id="qa/discovered-other"]').count(), 1); assert.equal(await provider.locator('[data-model-id="qa/discovered-other"] input').isChecked(), true);
  await ensureCatalog('目录模型 0348'); const deleteModelButton = provider.getByRole('button', { name: '删除模型 目录模型 0348', exact: true }); const modelDeletes = await callCount('removeCustomModel');
  await deleteModelButton.focus(); await page.keyboard.press('Enter'); await page.getByRole('alertdialog', { name: '删除模型？', exact: true }).getByRole('button', { name: '取消', exact: true }).press('Enter'); assert.equal(await callCount('removeCustomModel'), modelDeletes);
  await control('hold', 'removeCustomModel'); await control('commitError', 'removeCustomModel'); await twice(deleteModelButton); const modelConfirm = page.getByRole('alertdialog', { name: '删除模型？', exact: true }); await modelConfirm.getByRole('button', { name: '删除模型', exact: true }).press('Enter'); await pending('removeCustomModel'); assert.equal(await callCount('removeCustomModel'), modelDeletes + 1); await control('release', 'removeCustomModel'); await content().getByRole('button', { name: '刷新模型配置', exact: true }).waitFor(); assert.equal(await provider.locator('[data-model-id="qa/model-348"]').count(), 0, 'committed deleted model row is removed immediately'); await recover('models', 'removeCustomModel'); await ensureCatalog('目录模型 0348'); assert.equal(await provider.locator('[data-model-id="qa/model-348"]').count(), 0);
  const providerDeletes = await callCount('removeProvider'); await control('hold', 'removeProvider'); await control('commitError', 'removeProvider'); await twice(content().getByRole('button', { name: '删除模型来源 缺少认证的来源', exact: true })); await page.getByRole('alertdialog', { name: '删除模型来源？', exact: true }).getByRole('button', { name: '删除来源', exact: true }).press('Enter'); await pending('removeProvider'); assert.equal(await callCount('removeProvider'), providerDeletes + 1); await control('release', 'removeProvider'); await content().getByRole('button', { name: '刷新模型配置', exact: true }).waitFor(); assert.equal(await page.locator('[data-provider-id="missing"]').count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await page.setViewportSize({ width: 600, height: 760 }); await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; }); await capture('08-provider-deleted-committed-light'); await recover('models', 'removeProvider'); assert.equal(await page.locator('[data-provider-id="missing"]').count(), 0);
  result.checks.push('selected model import commits once and clears submitted selection; model/provider destructive cancel writes nothing, keyboard confirm commits once, deleted rows disappear before failed projection recovery, all retries read only');

  await page.setViewportSize({ width: 980, height: 640 }); await nav().getByRole('button', { name: 'MCP 服务器', exact: true }).click(); const mcpToggleWrites = await callCount('setMcpEnabled');
  await control('hold', 'setMcpEnabled'); await control('commitError', 'setMcpEnabled'); await twice(mcpRow('等待连接服务').getByRole('switch')); await pending('setMcpEnabled'); assert.equal(await callCount('setMcpEnabled'), mcpToggleWrites + 1); await control('release', 'setMcpEnabled'); await content().getByRole('button', { name: '刷新 MCP 状态', exact: true }).waitFor();
  assert.equal(await mcpRow('等待连接服务').getByRole('switch').isDisabled(), true); assert.equal(await mcpRow('等待连接服务').getByRole('button', { name: '删除 MCP 等待连接服务', exact: true }).isDisabled(), true); assert.equal(await content().getByRole('button', { name: '添加 MCP 服务器', exact: true }).isEnabled(), true); assert.equal(await mcpRow('等待连接服务').getByRole('button', { name: '编辑 等待连接服务', exact: true }).isEnabled(), true);
  await capture('09-mcp-toggle-committed-light'); await recover('mcp', 'setMcpEnabled'); assert.equal(await mcpRow('等待连接服务').getAttribute('data-state'), 'disabled');
  const mcpDeletes = await callCount('removeMcp'); await control('hold', 'removeMcp'); await control('commitError', 'removeMcp'); await twice(mcpRow('已连接零工具服务').getByRole('button', { name: '删除 MCP 已连接零工具服务', exact: true })); await page.getByRole('alertdialog', { name: '删除 MCP 服务器？', exact: true }).getByRole('button', { name: '删除服务器', exact: true }).press('Enter'); await pending('removeMcp'); assert.equal(await callCount('removeMcp'), mcpDeletes + 1); await control('release', 'removeMcp'); await content().getByRole('button', { name: '刷新 MCP 状态', exact: true }).waitFor(); assert.equal(await mcpRow('已连接零工具服务').count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.setViewportSize({ width: 600, height: 760 }); await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; }); await capture('10-mcp-deleted-committed-dark'); await recover('mcp', 'removeMcp'); assert.equal(await mcpRow('已连接零工具服务').count(), 0);
  result.checks.push('MCP toggle/delete preserve committed facts; stale switches/delete block while editor/add stay available, deleted row disappears, synchronous double actions and failed/successful refreshMcp retries never repeat writes');

  await page.setViewportSize({ width: 980, height: 760 }); await nav().getByRole('button', { name: '技能', exact: true }).click();
  const trustWrites = await callCount('setSkillTrusted'); await control('hold', 'setSkillTrusted'); await control('commitError', 'setSkillTrusted');
  await skillRow('待信任项目共享技能').getByRole('button', { name: '信任技能', exact: true }).click(); await page.getByRole('dialog', { name: '信任项目技能？', exact: true }).getByRole('button', { name: '信任技能', exact: true }).press('Enter'); await pending('setSkillTrusted'); assert.equal(await callCount('setSkillTrusted'), trustWrites + 1); await control('release', 'setSkillTrusted');
  await content().getByRole('button', { name: '刷新技能状态', exact: true }).waitFor(); assert.equal(await skillRow('待信任项目共享技能').getByRole('button', { name: '信任技能', exact: true }).isDisabled(), true); assert.equal(await skillRow('可用项目技能').getByRole('button', { name: '删除技能 可用项目技能', exact: true }).isDisabled(), true); assert.equal(await content().getByRole('button', { name: '添加技能', exact: true }).isEnabled(), true);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; }); await capture('11-skill-trust-committed-light'); await recover('skills', 'setSkillTrusted'); assert.equal(await skillRow('待信任项目共享技能').getAttribute('data-availability'), 'available');
  const skillDeletes = await callCount('removeSkill'); await control('hold', 'removeSkill'); await control('commitError', 'removeSkill'); await twice(skillRow('可用项目技能').getByRole('button', { name: '删除技能 可用项目技能', exact: true })); await page.getByRole('alertdialog', { name: '删除技能？', exact: true }).getByRole('button', { name: '删除技能', exact: true }).press('Enter'); await pending('removeSkill'); assert.equal(await callCount('removeSkill'), skillDeletes + 1); await control('release', 'removeSkill'); await content().getByRole('button', { name: '刷新技能状态', exact: true }).waitFor(); assert.equal(await skillRow('可用项目技能').count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.setViewportSize({ width: 600, height: 760 }); await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; }); await capture('12-skill-deleted-committed-dark'); await recover('skills', 'removeSkill'); assert.equal(await skillRow('可用项目技能').count(), 0);
  result.checks.push('skill trust/delete committed failure retains completion, prohibits repeated stale writes, removes deleted row immediately, and retries refreshSkills only through failed/successful reads without changing trust or deleting twice');
  await control('enableMarketplace');
  await nav().getByRole('button', { name: 'MCP 服务器', exact: true }).click();
  await nav().getByRole('button', { name: '技能', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索技能源', exact: true }).fill('市场安装恢复验证技能'); await page.getByRole('button', { name: '查看技能 市场安装恢复验证技能', exact: true }).click();
  const skillInstall = page.locator('.skill-install-dialog'); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).waitFor();
  await control('hold', 'installPreparedSkill'); await control('commitError', 'installPreparedSkill'); await twice(skillInstall.getByRole('button', { name: '安装技能', exact: true })); await pending('installPreparedSkill'); assert.equal(await callCount('installPreparedSkill'), 1); await control('release', 'installPreparedSkill'); await skillInstall.getByRole('button', { name: '重试刷新', exact: true }).waitFor(); await skillInstall.getByRole('status').filter({ hasText: /技能已安装/ }).waitFor(); assert.equal(await skillInstall.getByRole('button', { name: '项目', exact: true }).isDisabled(), true);
  assert.equal(await skillInstall.evaluate(node => node.scrollWidth > node.clientWidth + 1), false); await capture('13-skill-market-committed-dark');
  const marketReads = await callCount('refreshSkills'); await control('fail', 'refreshSkills'); await control('hold', 'refreshSkills'); await twice(skillInstall.getByRole('button', { name: '重试刷新', exact: true })); await pending('refreshSkills'); assert.equal(await callCount('refreshSkills'), marketReads + 1); await control('release', 'refreshSkills'); await skillInstall.getByRole('alert').filter({ hasText: /refreshSkills/ }).waitFor(); await twice(skillInstall.getByRole('button', { name: '重试刷新', exact: true })); await skillInstall.waitFor({ state: 'detached' }); assert.equal(await callCount('installPreparedSkill'), 1); assert.equal(await callCount('refreshSkills'), marketReads + 2);
  await skillRow('市场安装恢复验证技能').waitFor(); assert.equal(await content().getByRole('button', { name: '刷新技能状态', exact: true }).count(), 0); result.checks.push('mock marketplace token is submitted once; committed install locks scope, displays installed fact and retries refreshSkills only through error/success; no actual installation or process/network activity');
  await page.locator('.skill-hub-item').getByRole('button', { name: '查看技能 市场安装恢复验证技能', exact: true }).click(); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).waitFor(); await skillInstall.getByRole('button', { name: '项目', exact: true }).click(); await skillInstall.getByRole('button', { name: '项目技能工作区', exact: true }).click(); await page.getByRole('option', { name: /第二个隔离工作区/ }).click(); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).waitFor();
  await control('fail', 'settings'); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).click(); await skillInstall.getByRole('button', { name: '重试页面更新', exact: true }).waitFor(); assert.equal(await callCount('installPreparedSkill'), 2); const callbackReads = await callCount('refreshSkills'); await twice(skillInstall.getByRole('button', { name: '重试页面更新', exact: true })); await skillInstall.waitFor({ state: 'detached' }); assert.equal(await callCount('installPreparedSkill'), 2); assert.equal(await callCount('refreshSkills'), callbackReads, 'ready installation retries only App callback/current settings read');
  await page.locator('.skill-hub-item').getByRole('button', { name: '查看技能 市场安装恢复验证技能', exact: true }).click(); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).waitFor(); await control('hold', 'installPreparedSkill'); await control('commitError', 'installPreparedSkill'); await skillInstall.getByRole('button', { name: '安装技能', exact: true }).click(); await pending('installPreparedSkill');
  await control('openSecondSession'); await nav().waitFor({ state: 'detached' }); await page.locator('.assistant-response').first().waitFor(); await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: '技能', exact: true }).click(); await page.locator('.installed-skills').waitFor(); const readsBeforeOldInstall = await callCount('settings'); await control('release', 'installPreparedSkill'); assert.equal(await skillInstall.count(), 0); await content().getByRole('button', { name: '刷新技能状态', exact: true }).waitFor(); assert.match(await content().locator('.model-refresh-notice').innerText(), /市场安装恢复验证技能.*已安装/); assert.equal(await callCount('settings'), readsBeforeOldInstall, 'unmounted installer must not call old onInstalled');
  await control('openFirstSession'); await nav().waitFor({ state: 'detached' }); await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: 'MCP 服务器', exact: true }).click(); result.checks.push('marketplace ready result plus current-workspace callback read failure retries callback only; held old-scope installation completion cannot reopen dialog or invoke old callback; commit fact still marks the original target for explicit read recovery');

  // A delayed recovery from workspace A must not overwrite the new workspace projection.
  await control('commitError', 'setMcpEnabled'); await mcpRow('等待连接服务').getByRole('switch').click(); await content().getByRole('button', { name: '刷新 MCP 状态', exact: true }).waitFor();
  const staleMcp = await page.evaluate(() => { const value = window.__settingsResourcesQa.mcpProjection(); value.providers = []; value.mcp = [{ ...value.mcp[0], name: 'OBSOLETE_SCOPE_MCP' }]; return value; }); await control('reply', 'refreshMcp', staleMcp); await control('hold', 'refreshMcp'); await content().getByRole('button', { name: '刷新 MCP 状态', exact: true }).click(); await pending('refreshMcp');
  await control('openSecondSession'); await nav().waitFor({ state: 'detached' }); await page.locator('.assistant-response').first().waitFor(); await page.locator('.sidebar-bottom button[title="设置"]').click(); await nav().getByRole('button', { name: 'MCP 服务器', exact: true }).click(); await mcpRow('等待连接服务').waitFor(); await control('release', 'refreshMcp'); assert.equal(await content().getByText('OBSOLETE_SCOPE_MCP', { exact: true }).count(), 0); await mcpRow('等待连接服务').waitFor(); await content().getByRole('button', { name: '刷新 MCP 状态', exact: true }).waitFor(); await recover('mcp', 'setMcpEnabled');
  await nav().getByRole('button', { name: '模型配置', exact: true }).click(); await provider.waitFor(); await control('openFirstSession'); await nav().waitFor({ state: 'detached' }); assert.equal(await composer.inputValue(), draft);
  result.checks.push('held MCP recovery from workspace A cannot replace workspace B list/providers after native session navigation; completion notice persists until explicit current-scope read recovery, original conversation draft survives return');

  const allCalls = await page.evaluate(() => window.__settingsResourcesQa.calls);
  assert(allCalls.filter((call) => ['setDefaultModel', 'setDefaultThinkingLevel', 'setEnabledModels', 'setProviderEnabled', 'importProviderModels', 'removeCustomModel', 'removeProvider', 'setMcpEnabled', 'removeMcp', 'setSkillTrusted', 'removeSkill'].includes(call.method)).every((call) => call.cwd === '/qa/synthetic/performance'), 'every scoped mutation uses active workspace explicitly');
  assert.equal(await page.evaluate(() => window.__performanceQa.submitCalls), 0);
  assert.deepEqual(await page.evaluate(() => window.__settingsResourcesQa.forbidden), []);
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []);
  result.calls = allCalls; result.passed = true; await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) {
  result.passed = false; result.error = error.stack;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  result.finishedAt = new Date().toISOString(); if (page && !result.calls) result.calls = await page.evaluate(() => window.__settingsResourcesQa?.calls || []).catch(() => []);
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots, pageErrors: result.pageErrors }, null, 2));
