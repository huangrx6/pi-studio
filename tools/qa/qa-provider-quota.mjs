import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import quotaMapping from '../../electron/core/provider-quota.cjs';
import quotaService from '../../electron/services/provider-quota.cjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsResourcesFixture } from './fixtures/settings-resources.mjs';

const output = new URL('../../.qa/provider-quota/', import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
const responseData = { usage: { week: { remaining: 120 }, hour: { used: 0.375 } }, status: 'active' };
let status = 200, reads = 0;
const quotaApi = createServer((req, res) => {
  reads++;
  const allowed = req.method === 'GET' && req.url === '/quota' && req.headers.authorization === 'Bearer fixture-value';
  res.writeHead(allowed ? status : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(allowed && status === 200 ? responseData : { error: 'fixture' }));
});
quotaApi.listen(0, '127.0.0.1');
await once(quotaApi, 'listening');
const origin = `http://127.0.0.1:${quotaApi.address().port}`;
const endpoint = origin + '/quota';
const provider = { id: 'qa', enabled: true, baseUrl: origin + '/v1', quota: null };
const monitor = quotaService.createProviderQuotaMonitor({
  getProvider: id => id === provider.id ? provider : undefined,
  readKey: () => 'fixture-value',
});

async function measureQuotaForm(editor) {
  const layout = await editor.evaluate(dialog => {
    const body = dialog.querySelector('.dialog-body');
    const box = dialog.getBoundingClientRect();
    const footer = dialog.querySelector('.dialog-footer').getBoundingClientRect();
    const [first, second] = Array.from(dialog.querySelectorAll('.quota-mapping'), card => card.getBoundingClientRect());
    return {
      width: box.width, contentHeight: body.scrollHeight,
      fits: box.left >= 0 && box.right <= innerWidth && body.scrollWidth <= body.clientWidth + 1,
      footerVisible: footer.top >= body.getBoundingClientRect().bottom - 1 && footer.bottom <= innerHeight,
      beside: first.right <= second.left && Math.abs(first.top - second.top) < 1,
      stacked: first.bottom <= second.top && Math.abs(first.left - second.left) < 1,
    };
  });
  assert.ok(layout.fits, 'all fields fit without horizontal scrolling');
  assert.ok(layout.footerVisible, 'save and cancel stay outside the scrollable fields');
  return layout;
}

// Use the production mapping and query service behind an in-memory provider.
function installQuotaFixture(baseUrl) {
  window.__legacyQuotaReads = 0;
  const base = window.piApi;
  const fixtures = window.__settingsResourcesQa;
  fixtures.failNextCatalog = false;
  const extensionEnabled = () => localStorage.getItem('quota-extension') !== 'off';
  const project = async () => {
    const { models, settings } = fixtures.projection();
    const all = models.models.map(item => item.id);
    const config = await window.readQuotaConfig();
    const providers = settings.providers.map(source => ({ ...source, quotaEnabled: source.id === 'qa' && config?.enabled === true }));
    return { models: { ...models, enabled: all }, settings: { ...settings, enabledModels: all, providers, extensions: [{ id: 'user:pi-quota-status', available: extensionEnabled() }] } };
  };
  const legacy = {
    id: 'user:pi-quota-status/chip', contributionId: 'chip', extensionId: 'user:pi-quota-status',
    extensionName: '旧额度扩展', scope: 'user', slot: 'status.chip', details: 'detail', title: '旧额度状态', size: 'compact',
    content: [{ kind: 'dataView', sourceId: 'user:pi-quota-status/live' }],
  };
  const withSessionModel = read => async input => {
    const result = await read(input);
    if ((input.id ?? input) === 'perf-1') return { ...result, model: { ...result.model, modelRef: 'missing/model', label: '第二来源模型' } };
    const quota = await window.readQuotaConfig();
    return { ...result, model: { ...result.model, quotaProvider: quota?.enabled ? { id: 'qa', name: fixtures.longProvider } : undefined } };
  };
  window.piApi = new Proxy({
    settings: async () => (await project()).settings, models: async () => (await project()).models,
    refreshModels: project,
    providerConfig: async id => ({ ...(await base.providerConfig(id)), baseUrl, quota: id === 'qa' ? await window.readQuotaConfig() : null }),
    addProvider: async draft => {
      await window.saveQuotaConfig(draft.quota);
      return { committed: true, projection: { status: 'ready', value: await project() } };
    },
    providerQuota: (id, force) => window.readQuota(id, force),
    providerQuotaFields: draft => window.inspectQuota(draft),
    previewQuotaMapping: draft => window.previewQuota(draft),
    conversationPage: withSessionModel(base.conversationPage),
    conversationSnapshot: withSessionModel(base.conversationSnapshot),
    subscribeConversation: withSessionModel(base.subscribeConversation),
    openExtensionDataView: async payload => {
      if (payload.sourceId.startsWith('user:pi-quota-status/')) window.__legacyQuotaReads++;
      return base.openExtensionDataView(payload);
    },
    extensionsUi: async () => ({ items: extensionEnabled() ? [legacy, { ...legacy, id: 'user:pi-quota-status/detail', contributionId: 'detail', slot: 'conversation.detail', size: 'regular' }] : [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
  }, { get: (target, key) => key in target ? target[key] : base[key] });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await Promise.all([
    page.exposeFunction('readQuotaConfig', () => provider.quota),
    page.exposeFunction('saveQuotaConfig', value => { provider.quota = quotaMapping.normalizeProviderQuota(value); monitor.invalidate(provider.id); }),
    page.exposeFunction('readQuota', (id, force) => monitor.read(id, force)),
    page.exposeFunction('inspectQuota', draft => monitor.inspect(draft.providerId, draft)),
    page.exposeFunction('previewQuota', quotaMapping.previewQuota),
  ]);
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:2,turnCount:4});(${installSettingsResourcesFixture})();(${installQuotaFixture})(${JSON.stringify(provider.baseUrl)});` });
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  await page.locator('.assistant-response').first().waitFor();
  const workspace = page.getByRole('button', { name: '打开扩展与轨迹' });
  await workspace.click();
  await page.getByRole('dialog', { name: '扩展与轨迹' }).waitFor();
  assert.equal(await page.getByText('旧额度状态', { exact: true }).count(), 0);
  assert.equal(await page.locator('.quota-menu-row').count(), 0);
  const views = page.getByRole('group', { name: '会话视图' });
  await views.getByRole('button', { name: /^扩展/ }).click();
  await page.getByText('暂无会话扩展').waitFor();
  assert.equal(reads, 0);
  assert.equal(await page.evaluate(() => window.__legacyQuotaReads), 0);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();

  const nav = page.locator('.settings-navigation');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.getByText('已启用模型 350').waitFor();
  assert.equal(await page.locator('[data-enabled-model-id]').count(), 0);
  await page.getByRole('button', { name: '新对话默认模型' }).click();
  const directory = page.getByRole('dialog', { name: '已启用模型' });
  await directory.waitFor();
  assert.equal(await directory.locator('[data-enabled-model-id]').count(), 24);
  await directory.getByRole('button', { name: '下一页模型' }).click();
  await directory.getByText('25–48 / 350 个模型').waitFor();
  await directory.getByRole('button', { name: '按来源' }).click();
  await directory.getByRole('searchbox').fill('model-349');
  await directory.getByText('目录末端模型 0349', { exact: true }).waitFor();
  await directory.getByRole('button', { name: '设 目录末端模型 0349 为默认模型' }).click();
  await directory.locator('.enabled-model-default').waitFor();
  await page.keyboard.press('Escape');
  await directory.waitFor({ state: 'detached' });
  await page.screenshot({ path: fileURLToPath(new URL('models.png', output)) });

  const source = page.locator('[data-provider-id="qa"]');
  const edit = source.getByRole('button', { name: /^编辑 / });
  await edit.click();
  const editor = page.getByRole('dialog', { name: '编辑模型来源' });
  const toggle = editor.getByRole('switch', { name: '开启额度监控' });
  await toggle.waitFor();
  const compactWidth = (await editor.boundingBox()).width;
  await toggle.click();
  await editor.getByLabel('额度接口（GET）').fill(endpoint);
  await editor.getByRole('button', { name: '额度接口认证' }).click();
  await page.getByRole('option', { name: /Bearer/ }).click();
  await editor.getByRole('button', { name: '读取接口字段' }).click();
  await editor.getByRole('button', { name: '选择接口返回字段' }).click();
  await page.getByRole('option', { name: 'usage.week.remaining' }).click();
  const group = n => editor.getByRole('group', { name: '额度字段 ' + n, exact: true });
  await group(1).getByLabel('显示名称').fill('每周剩余');
  await group(1).getByLabel('单位（可选）').fill('次');
  await editor.getByRole('button', { name: '添加额度字段' }).click();
  await group(2).getByLabel('显示名称').fill('套餐状态');
  await group(2).getByLabel('返回字段路径').fill('status');
  await group(2).getByRole('button', { name: /显示格式/ }).click();
  await page.getByRole('option', { name: '状态翻译' }).click();
  await group(2).getByLabel('值翻译').fill('active=可用\nexhausted=已耗尽');
  await editor.getByRole('button', { name: '添加额度字段' }).click();
  assert.equal(await group(3).getByRole('checkbox').isDisabled(), true);
  await group(2).getByRole('checkbox').uncheck();
  await group(3).getByRole('checkbox').check();
  await group(3).getByLabel('显示名称').fill('小时已用');
  await group(3).getByLabel('返回字段路径').fill('usage.hour.used');
  await group(3).getByRole('button', { name: /显示格式/ }).click();
  await page.getByRole('option', { name: '比例（0–1）' }).click();
  const desktop = await measureQuotaForm(editor);
  assert.ok(desktop.width > compactWidth && desktop.beside, 'adding quota fields expands the form into two columns');
  await editor.locator('.quota-mapping-heading').evaluate(heading => heading.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: fileURLToPath(new URL('editor.png', output)) });
  const activeField = group(2).getByLabel('返回字段路径');
  await activeField.focus();
  await page.setViewportSize({ width: 432, height: 680 });
  const narrow = await measureQuotaForm(editor);
  assert.ok(narrow.stacked && narrow.contentHeight > desktop.contentHeight, 'narrow forms use one column');
  assert.equal(await activeField.inputValue(), 'status');
  assert.ok(await activeField.evaluate(input => input === document.activeElement), 'reflow keeps keyboard focus');
  await editor.locator('.quota-mapping-heading').evaluate(heading => heading.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: fileURLToPath(new URL('editor-narrow.png', output)) });
  await page.setViewportSize({ width: 1280, height: 820 });
  assert.equal((await measureQuotaForm(editor)).width, desktop.width);
  await editor.getByText('用返回样例预览').click();
  await editor.getByLabel('JSON 返回样例').fill(JSON.stringify(responseData));
  await editor.getByRole('button', { name: '预览映射' }).click();
  await editor.locator('.quota-preview-list').getByText('120 次').waitFor();
  await editor.locator('.quota-preview-list').getByText('可用').waitFor();
  await editor.getByRole('button', { name: '保存更改' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(provider.quota.fields.length, 3);
  assert.equal(await source.locator('.provider-model-list').count(), 0, 'editing quota keeps the catalog collapsed');
  const quotaButton = source.getByRole('button', { name: /^查看 .* 额度$/ });
  await quotaButton.click();
  const detail = page.getByRole('dialog', { name: '额度监控' });
  await detail.getByText('120 次').waitFor();
  const refresh = detail.getByRole('button', { name: '刷新额度' });
  status = 503; await refresh.click(); await detail.getByText(/上次成功/).waitFor();
  await detail.getByText('120 次').waitFor();
  status = 401; await refresh.click(); await detail.getByText(/认证失败/).waitFor();
  assert.equal(await detail.getByText('120 次').count(), 0);
  status = 200; await refresh.click(); await detail.getByText('可用').waitFor();
  await page.setViewportSize({ width: 980, height: 680 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: fileURLToPath(new URL('quota.png', output)) });
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: '返回对话' }).click();
  await workspace.click();
  const row = page.locator('.quota-menu-row');
  await row.getByText('每周剩余 120 次 · 小时已用 37.5%').waitFor();
  assert.equal(await page.locator('.workspace-menu-extension-row').filter({ hasText: '旧额度状态' }).count(), 0);
  await row.click(); await detail.getByText('可用').waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('workspace-menu-trigger'));
  await workspace.click();
  await views.getByRole('button', { name: /^扩展/ }).click();
  await page.locator('.extension-hub-card').getByText('120 次').waitFor();
  await page.getByRole('button', { name: '打开 旧额度状态 详情' }).click();
  await page.locator('.extension-page').getByText('可用').waitFor();
  assert.equal(await page.evaluate(() => window.__legacyQuotaReads), 0);
  await page.evaluate(() => window.__settingsResourcesQa.openSecondSession());
  await page.locator('.model-label').getByText('第二来源模型').waitFor();
  await workspace.click();
  await page.getByRole('dialog', { name: '扩展与轨迹' }).waitFor();
  assert.equal(await page.getByText('旧额度状态', { exact: true }).count(), 0);
  assert.equal(await row.count(), 0);
  await page.reload();
  await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click();
  await page.locator('.model-label').getByText('当前会话模型').waitFor();
  await workspace.click();
  await row.getByText('每周剩余 120 次 · 小时已用 37.5%').waitFor();
  await workspace.click();
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await edit.click();
  assert.equal(await group(1).getByLabel('返回字段路径').inputValue(), 'usage.week.remaining');
  await toggle.click();
  await editor.getByRole('button', { name: '保存更改' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(await quotaButton.count(), 0);
  const before = reads;
  await nav.getByRole('button', { name: '返回对话' }).click(); await workspace.click();
  await page.getByRole('dialog', { name: '扩展与轨迹' }).waitFor();
  assert.equal(await page.getByText('旧额度状态', { exact: true }).count(), 0);
  assert.equal(await row.count(), 0); assert.equal(reads, before);
  // A saved, enabled source still needs the extension to expose any quota UI.
  provider.quota = { ...provider.quota, enabled: true };
  await page.evaluate(() => localStorage.setItem('quota-extension', 'off'));
  await page.reload();
  await page.locator('.session-row').first().click();
  await workspace.click();
  await views.waitFor();
  assert.equal(await row.count(), 0);
  await workspace.click();
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await edit.click();
  await editor.getByLabel('显示名称', { exact: true }).waitFor();
  assert.equal(await toggle.count(), 0);
  assert.equal(await quotaButton.count(), 0);
  assert.equal(reads, before);
  assert.deepEqual(errors, []);
  console.log('350-model directory, quota mapping, stale/auth/retry, saved preferences, keyboard focus and existing extension verified.');
} finally {
  await browser?.close();
  quotaApi.closeAllConnections();
  await new Promise(resolve => quotaApi.close(resolve));
  await server.close();
}
