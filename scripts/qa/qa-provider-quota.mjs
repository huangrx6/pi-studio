import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import quotaMapping from '../../electron/main/core/provider-quota.cjs';
import quotaService from '../../electron/main/services/provider-quota.cjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsResourcesFixture } from './fixtures/settings-resources.mjs';

const output = new URL('../../.qa/provider-quota/', import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
const responseData = { usage: { week: { remaining: 120 }, hour: { used: 0.375 } }, balance: 22.11, status: 'active' };
let status = 200, reads = 0;
const quotaApi = createServer((req, res) => {
  reads++;
  const url = new URL(req.url, 'http://localhost');
  const auth = url.pathname.split('/')[2] || 'bearer';
  const allowed = req.method === 'GET' && url.pathname.startsWith('/quota') && (
    auth === 'none' ? !req.headers.authorization
      : auth === 'query' ? url.searchParams.get('access_key') === 'fixture-value'
      : auth === 'authorization' ? req.headers.authorization === 'fixture-value'
      : auth === 'bearer' ? req.headers.authorization === 'Bearer fixture-value'
      : req.headers[auth === 'custom-header' ? 'ocp-apim-subscription-key' : auth] === 'fixture-value'
  );
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
    const [first, second, third] = Array.from(dialog.querySelectorAll('.quota-mapping'), card => card.getBoundingClientRect());
    return {
      footerAligned: Array.from(dialog.querySelectorAll('.quota-mapping')).every(card => {
        const remove = card.querySelector('.quota-field-footer button').getBoundingClientRect();
        const label = card.querySelector('.quota-summary-option');
        const fields = card.querySelector('.quota-mapping-fields');
        const end = fields.getBoundingClientRect();
        return Math.abs(remove.right - end.right) <= 1 && remove.top >= end.bottom
          && getComputedStyle(label).fontSize === getComputedStyle(fields.querySelector('label')).fontSize;
      }),
      width: box.width, contentHeight: body.scrollHeight,
      fits: box.left >= 0 && box.right <= innerWidth && body.scrollWidth <= body.clientWidth + 1,
      footerVisible: footer.top >= body.getBoundingClientRect().bottom - 1 && footer.bottom <= innerHeight,
      beside: first.right <= second.left && Math.abs(first.top - second.top) < 1,
      oddFieldSpans: third && Math.abs(third.left - first.left) <= 1 && Math.abs(third.right - second.right) <= 1,
      stacked: first.bottom <= second.top && Math.abs(first.left - second.left) < 1,
    };
  });
  assert.ok(layout.footerAligned, 'remove ends the field group and checkbox matches other labels');
  assert.ok(layout.fits, 'all fields fit without horizontal scrolling');
  assert.ok(layout.footerVisible, 'save and cancel stay outside the scrollable fields');
  return layout;
}

// Use the production mapping and query service behind an in-memory provider.
function installQuotaFixture(baseUrl) {
  const base = window.piApi;
  const fixtures = window.__settingsResourcesQa;
  fixtures.failNextCatalog = false;
  const quotaListeners = new Set();
  const extensionEnabled = () => localStorage.getItem('quota-extension') !== 'off';
  const project = async () => {
    const { models, settings } = fixtures.projection();
    const all = models.models.map(item => item.id);
    const config = await window.readQuotaConfig();
    const providers = settings.providers.map(source => ({ ...source, quotaEnabled: source.id === 'qa' && config?.enabled === true }));
    return { models: { ...models, enabled: all }, settings: { ...settings, enabledModels: all, providers, extensions: [{ id: 'user:pi-quota-status', available: extensionEnabled() }] } };
  };
  const quotaChip = {
    id: 'user:pi-quota-status/quota-chip', contributionId: 'quota-chip', extensionId: 'user:pi-quota-status',
    extensionName: '额度状态', scope: 'user', slot: 'status.chip', details: 'quota-detail', title: '额度状态', size: 'compact',
    content: [],
  };
  const draftPlacement = sessionStorage.getItem('qa:quota-placement');
  if (draftPlacement) {
    const preferences = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    preferences.extensionPlacements = { [quotaChip.id]: draftPlacement };
    localStorage.setItem('pi-studio:preferences', JSON.stringify(preferences));
  }
  const withSessionModel = read => async input => {
    const result = await read(input);
    if ((input.id ?? input) === 'perf-1') return { ...result, model: { ...result.model, modelRef: 'missing/model', label: '第二来源模型' } };
    const quota = await window.readQuotaConfig();
    return { ...result, model: { ...result.model, quotaProvider: quota?.enabled ? { id: 'qa', name: fixtures.longProvider } : undefined } };
  };
  window.piApi = new Proxy({
    state: async () => {
      const result = await base.state();
      const quota = await window.readQuotaConfig();
      return {...result, model: {...result.model, quotaProvider: quota?.enabled && extensionEnabled()
        ? {id:'qa', name:fixtures.longProvider} : undefined}};
    },
    settings: async () => (await project()).settings, models: async () => (await project()).models,
    refreshModels: project,
    providerConfig: async id => ({ ...(await base.providerConfig(id)), baseUrl, quota: id === 'qa' ? await window.readQuotaConfig() : null }),
    addProvider: async draft => {
      await window.saveQuotaConfig(draft.quota);
      for (const listener of quotaListeners) listener(draft.providerId);
      return { committed: true, projection: { status: 'ready', value: await project() } };
    },
    onProviderQuotaInvalidated: listener => {
      quotaListeners.add(listener);
      return () => quotaListeners.delete(listener);
    },
    providerQuota: (id, force) => window.readQuota(id, force),
    providerQuotaFields: draft => window.inspectQuota(draft),
    previewQuotaMapping: draft => window.previewQuota(draft),
    conversationPage: withSessionModel(base.conversationPage),
    conversationSnapshot: withSessionModel(base.conversationSnapshot),
    subscribeConversation: withSessionModel(base.subscribeConversation),
    extensionsUi: async () => ({ items: extensionEnabled() ? [quotaChip,
      { ...quotaChip, id: 'user:pi-quota-status/quota-detail', contributionId: 'quota-detail', slot: 'status.detail', size: 'regular' },
    ] : [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
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
  const header = page.locator('.chat-header');
  const footer = page.getByRole('contentinfo', { name: '状态栏' });
  const quotaChip = footer.getByRole('button', { name: '打开 额度状态 详情' });
  const quotaPanel = footer.getByRole('dialog', { name: '额度状态', exact: true });
  assert.equal(await quotaChip.count(), 0);
  assert.equal(reads, 0);

  const nav = page.locator('.settings-navigation');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.getByRole('button', {name: '查看已启用模型'}).filter({hasText:'350'}).waitFor();
  assert.equal(await page.locator('[data-enabled-model-id]').count(), 0);
  const defaultModelButton = page.getByRole('button', { name: '新对话默认模型' });
  await defaultModelButton.click();
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
  assert.ok(await defaultModelButton.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'none'),
    'the native dialog restores its mouse opener without a focus ring');
  await page.screenshot({ path: fileURLToPath(new URL('models.png', output)) });

  const source = page.locator('[data-provider-id="qa"]');
  const manage = source.getByRole('button', { name: /^管理 / });
  await manage.focus();
  await page.keyboard.press('Enter');
  const back = page.getByRole('button', {name:'模型来源', exact:true});
  await back.waitFor();
  await back.focus();
  await page.keyboard.press('Space');
  await manage.waitFor();
  const more = source.getByRole('button', { name: /更多操作$/ });
  async function openEditor() {
    await more.click();
    await page.getByRole('menuitem', {name:'编辑连接', exact:true}).click();
  }
  await openEditor();
  const editor = page.getByRole('dialog', { name: '编辑模型来源' });
  const toggle = editor.getByRole('switch', { name: '开启额度监控' });
  await toggle.waitFor();
  const media = editor.locator('.provider-media-fields');
  assert.equal(await media.evaluate(node => node.open), false, 'unconfigured media starts collapsed');
  await media.locator('summary').click();
  await editor.getByLabel('图像生成模型 ID', { exact: true }).fill('image/draft');
  await media.locator('summary').click();
  await editor.getByLabel('服务地址', { exact: true }).fill(provider.baseUrl + '/');
  assert.equal(await media.evaluate(node => node.open), false, 'parent edits keep optional media collapsed');
  await media.locator('summary').click();
  assert.equal(await editor.getByLabel('图像生成模型 ID', { exact: true }).inputValue(), 'image/draft');
  await editor.getByLabel('图像生成模型 ID', { exact: true }).fill('');
  await media.locator('summary').click();
  await editor.getByLabel('服务地址', { exact: true }).fill(provider.baseUrl);
  const settingsDialogBackgrounds = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await editor.locator('.dialog-body').evaluate(body => { body.scrollTop = 0; });
    settingsDialogBackgrounds[theme] = await editor.evaluate(node => getComputedStyle(node).backgroundColor);
    await editor.screenshot({ path: fileURLToPath(new URL(`provider-sections-${theme}.png`, output)) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const compactWidth = (await editor.boundingBox()).width;
  await toggle.click();
  // Exercise the real settings form and production service for every transport.
  for (const [auth, label] of [
    ['authorization', '来源 API Key · 原始 Authorization'], ['x-api-key', '来源 API Key · x-api-key'],
    ['api-key', '来源 API Key · api-key'], ['x-goog-api-key', '来源 API Key · x-goog-api-key'],
    ['custom-header', '来源 API Key · 自定义请求头'], ['query', '来源 API Key · 查询参数'], ['none', '无需凭据'],
  ]) {
    await editor.getByLabel('额度接口（GET）').fill(endpoint + '/' + auth);
    await editor.getByRole('button', { name: '额度接口认证' }).click();
    await page.getByRole('option', { name: new RegExp('^' + label) }).click();
    if (auth === 'custom-header') await editor.getByLabel('认证请求头名称').fill('Ocp-Apim-Subscription-Key');
    if (auth === 'query') await editor.getByLabel('认证查询参数名称').fill('access_key');
    await editor.getByRole('button', { name: '读取接口字段' }).click();
    await editor.getByRole('button', { name: '选择接口返回字段' }).waitFor();
  }
  await editor.getByLabel('额度接口（GET）').fill(endpoint);
  await editor.getByRole('button', { name: '额度接口认证' }).click();
  await page.getByRole('option', { name: '来源 API Key · Bearer', exact: true }).click();
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
  assert.ok(desktop.width >= compactWidth && desktop.beside && desktop.oddFieldSpans, 'quota fields retain the wide provider editor, share rows and let an odd last field span the full width');
  await editor.locator('.quota-mapping-heading').evaluate(heading => heading.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: fileURLToPath(new URL('editor.png', output)) });
  await editor.getByRole('region', { name: '额度接口设置', exact: true }).scrollIntoViewIfNeeded();
  await editor.screenshot({ path: fileURLToPath(new URL('quota-connection-section.png', output)) });
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
  const preview = editor.locator('.quota-sample');
  const readsBeforePreview = reads;
  await editor.getByText('额度预览', { exact: true }).click();
  const rendered = preview.getByRole('region', { name: '映射预览' });
  await rendered.getByText('示例数据', { exact: true }).waitFor();
  await rendered.getByText('可用', { exact: true }).waitFor();
  assert.deepEqual(await rendered.locator('dt').allTextContents(), ['每周剩余', '套餐状态', '小时已用']);
  assert.equal(await rendered.getByRole('progressbar').count(), 1);
  assert.ok(await preview.evaluate(el => Boolean(el.compareDocumentPosition(el.parentElement.querySelector('.quota-mapping-list')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  const verifyTab = preview.getByRole('tab', { name: '验证 JSON' });
  await verifyTab.click();
  const sample = editor.getByLabel('JSON 返回样例');
  const format = editor.getByRole('button', { name: '格式化 JSON' });
  assert.equal(await sample.inputValue(), '');
  const sampleFocusStyle = () => sample.evaluate(input => {
    const style = getComputedStyle(input.parentElement);
    const panelStyle = getComputedStyle(input.closest('.quota-sample-columns'));
    return {
      outline: style.outlineStyle,
      offset: style.outlineOffset,
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
      innerRadius: `${parseFloat(panelStyle.borderTopLeftRadius) - parseFloat(panelStyle.borderLeftWidth)}px`,
    };
  });
  await page.keyboard.press('Tab');
  assert.ok(await sample.evaluate(input => input === document.activeElement));
  const wideFocus = await sampleFocusStyle();
  assert.equal(wideFocus.outline, 'solid');
  assert.equal(wideFocus.offset, '-1px');
  assert.deepEqual(wideFocus.radii, [wideFocus.innerRadius, '0px', wideFocus.innerRadius, '0px']);
  await preview.locator('.quota-sample-columns').screenshot({ path: fileURLToPath(new URL('json-input-focus.png', output)) });
  await sample.fill(JSON.stringify({ note: '用于检查横向滚动的长字段'.repeat(80), ...responseData }));
  await sample.press('ControlOrMeta+a');
  await sample.press('ArrowLeft');
  assert.deepEqual(await sample.evaluate(el => [getComputedStyle(el, '::-webkit-scrollbar').width, getComputedStyle(el, '::-webkit-scrollbar').height]), ['0px', '8px']);
  assert.ok(await sample.evaluate(el => el.scrollWidth > el.clientWidth));
  await sample.hover();
  await page.mouse.wheel(220, 0);
  await page.waitForFunction(() => document.querySelector('.quota-sample textarea').scrollLeft > 0);
  await sample.press('ControlOrMeta+a');
  await sample.press('ArrowLeft');
  assert.equal(await sample.evaluate(el => el.selectionStart), 0);
  await page.waitForFunction(() => document.querySelector('.quota-sample textarea').scrollLeft <= 1);
  await sample.fill('{');
  await rendered.getByRole('alert').waitFor();
  assert.ok(await format.isDisabled());
  await sample.fill('');
  await rendered.getByText('输入 JSON 后查看显示效果。').waitFor();
  await sample.fill('{}');
  await rendered.getByText(/没有匹配到额度字段/).waitFor();
  await rendered.getByText('查看 3 个字段问题').click();
  await rendered.getByText('usage.week.remaining', { exact: true }).waitFor();
  await sample.fill('{"status":"active"}');
  await rendered.getByText('已匹配 1 / 3 项').waitFor();
  assert.deepEqual(await rendered.locator('dt').allTextContents(), ['套餐状态']);
  const escaped = JSON.stringify('一,二:\n"三"');
  const literal = '{"x":9007199254740993123456,"x":[{},[],1.20e+3],"escape":' + escaped + '}';
  await sample.fill(literal);
  await format.click();
  const reindented = await sample.inputValue();
  assert.ok(reindented.includes('\n  "x": 9007199254740993123456,') && reindented.includes('1.20e+3'));
  assert.deepEqual(JSON.parse(reindented), JSON.parse(literal));
  await sample.fill(JSON.stringify(responseData));
  await format.click();
  assert.equal(await sample.inputValue(), JSON.stringify(responseData, null, 2));
  assert.ok(await format.isDisabled());
  await rendered.getByText('每周剩余 120 次 · 小时已用 37.5%', { exact: true }).waitFor();
  await rendered.getByText('120 次', { exact: true }).waitFor();
  await rendered.getByText('可用', { exact: true }).waitFor();
  assert.equal(await rendered.getByRole('progressbar', { name: '小时已用' }).getAttribute('value'), '37.5');
  await preview.getByRole('tab', { name: '显示示例' }).click();
  await rendered.getByText('示例数据', { exact: true }).waitFor();
  await verifyTab.click();
  await preview.locator(':scope > summary').click();
  await preview.locator(':scope > summary').click();
  assert.equal(await sample.inputValue(), JSON.stringify(responseData, null, 2));
  await group(1).getByLabel('显示名称').fill('本周可用');
  await rendered.getByText('本周可用 120 次 · 小时已用 37.5%', { exact: true }).waitFor();
  await group(1).getByLabel('显示名称').fill('每周剩余');
  await rendered.getByText('每周剩余 120 次 · 小时已用 37.5%', { exact: true }).waitFor();
  assert.equal(reads, readsBeforePreview, 'editing a sample only changes the local preview');
  const layout = () => preview.evaluate(el => {
    const rect = selector => el.querySelector(selector).getBoundingClientRect();
    const left = rect('.quota-sample-source');
    const right = rect('.quota-preview-list');
    const sourceTitle = rect('label');
    const resultTitle = rect('h4');
    return {
      paired: Math.abs(left.right - right.left) <= 1 && Math.abs(left.top - right.top) <= 1 && Math.abs(left.bottom - right.bottom) <= 1,
      titlesAligned: Math.abs((sourceTitle.top + sourceTitle.bottom - resultTitle.top - resultTitle.bottom) / 2) <= 1,
      stacked: Math.abs(left.bottom - right.top) <= 1 && Math.abs(left.left - right.left) <= 1 && Math.abs(left.right - right.right) <= 1,
    };
  });
  const widePreview = await layout();
  assert.ok(widePreview.paired && widePreview.titlesAligned, 'sample and result share bounds and a title baseline');
  const inputStyle = await sample.evaluate(el => {
    const style = getComputedStyle(el);
    return { resize: style.resize, border: style.borderTopWidth, font: style.fontFamily, fits: el.scrollHeight <= el.clientHeight + 1 };
  });
  assert.equal(inputStyle.resize, 'none');
  assert.equal(inputStyle.border, '0px');
  assert.match(inputStyle.font, /monospace/);
  assert.ok(inputStyle.fits, 'a short formatted response fits without vertical scrolling');
  await preview.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await preview.screenshot({ path: fileURLToPath(new URL('display-sample-detail.png', output)) });
  await page.screenshot({ path: fileURLToPath(new URL('display-sample.png', output)) });
  await page.setViewportSize({ width: 432, height: 680 });
  assert.ok((await layout()).stacked, 'the result follows the editable sample on narrow windows');
  assert.equal(await sample.inputValue(), JSON.stringify(responseData, null, 2));
  await sample.focus();
  const narrowFocus = await sampleFocusStyle();
  assert.equal(narrowFocus.outline, 'solid');
  assert.deepEqual(narrowFocus.radii, [narrowFocus.innerRadius, narrowFocus.innerRadius, '0px', '0px']);
  const lastMetric = rendered.getByRole('progressbar', { name: '小时已用' });
  await lastMetric.evaluate(el => el.scrollIntoView({ block: 'center' }));
  assert.ok(await lastMetric.evaluate(el => el.getBoundingClientRect().bottom <= el.closest('dialog').querySelector('.dialog-footer').getBoundingClientRect().top));
  await page.setViewportSize({ width: 432, height: 860 });
  await preview.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await preview.screenshot({ path: fileURLToPath(new URL('display-sample-narrow.png', output)) });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await preview.screenshot({ path: fileURLToPath(new URL('display-sample-dark.png', output)) });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await editor.getByRole('button', { name: '保存更改' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(provider.quota.fields.length, 3);
  assert.equal(await page.locator('.model-stage').count(), 0, 'editing quota preserves the source list');
  const quotaButton = page.getByRole('menuitem', { name: '查看额度', exact: true });
  for (const width of [1280, 432]) {
    await page.setViewportSize({ width, height: 820 });
    await more.click();
    await quotaButton.waitFor();
    assert.equal(await quotaButton.locator('svg').count(), 0, 'quota action is text only');
    const menu = page.getByRole('menu').filter({ has: quotaButton });
    assert.ok(await menu.evaluate(menu => {
      const box = menu.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }), 'all source actions fit the viewport');
    const labelEdges = await menu.locator('button > span').evaluateAll(labels => labels.map(node => node.getBoundingClientRect().left));
    assert.ok(Math.max(...labelEdges) - Math.min(...labelEdges) < 1, 'all action labels use the same left edge');
    await page.screenshot({ path: fileURLToPath(new URL(`provider-actions-${width}.png`, output)) });
    await page.keyboard.press('Escape');
    assert.ok(await more.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'none'),
      'Escape returns focus to the mouse-opened menu trigger without a ring');
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  await more.click();
  await quotaButton.click();
  const detail = page.getByRole('dialog', { name: '额度监控' });
  await detail.getByText('120 次').waitFor();
  const refresh = detail.getByRole('button', { name: '刷新额度' });
  status = 503; await refresh.click(); await detail.getByText(/上次成功/).waitFor();
  await detail.getByText('120 次').waitFor();
  await detail.locator('.provider-quota-dialog').screenshot({ path: fileURLToPath(new URL('detail-stale.png', output)) });
  status = 401; await refresh.click(); await detail.getByText(/认证失败/).waitFor();
  assert.equal(await detail.getByText('120 次').count(), 0);
  await detail.locator('.provider-quota-dialog').screenshot({ path: fileURLToPath(new URL('detail-error.png', output)) });
  assert.equal(await detail.locator('.provider-quota-dialog').evaluate(node => getComputedStyle(node).backgroundColor), settingsDialogBackgrounds.light);
  status = 200; await refresh.click(); await detail.getByText('可用').waitFor();
  await page.setViewportSize({ width: 980, height: 680 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: fileURLToPath(new URL('quota.png', output)) });
  await page.keyboard.press('Escape');
  await page.locator('[data-sidebar-section="conversations"]').click();
  await page.setViewportSize({ width: 1440, height: 920 });
  assert.equal(await header.getByText('每周剩余', { exact: true }).count(), 0);
  await quotaChip.getByText(/每周剩余 120 次 · 小时已用 37.5%/).waitFor();
  assert.equal(await page.locator('.composer-quota-button').count(), 0);
  await quotaChip.click();
  await quotaPanel.getByText('可用').waitFor();
  assert.equal(await page.locator('.file-panel').count(), 0);
  const savedQuota = provider.quota;
  const saveQuota = quota => page.evaluate(quota => window.piApi.addProvider({ providerId: 'qa', quota }), quota);
  await saveQuota({ ...savedQuota, fields: [{ ...savedQuota.fields[0], label: '¥', path: 'balance', unit: '元' }] });
  await quotaChip.getByText('余额 22.11 元', { exact: true }).waitFor();
  const balance = quotaPanel.locator('.quota-featured');
  await balance.getByText('余额', { exact: true }).waitFor();
  assert.equal(await balance.locator('dd').innerText(), '22.11 元');
  assert.equal(await quotaPanel.getByText('¥', { exact: true }).count(), 0);
  const sidebarDivider = page.getByRole('separator', { name: '调整侧边栏宽度' });
  const divider = await sidebarDivider.boundingBox();
  const popover = await quotaPanel.boundingBox();
  const overlap = { x: divider.x + divider.width / 2, y: popover.y + 20 };
  assert.ok(overlap.x > popover.x && overlap.x < popover.x + popover.width, 'the quota popover straddles the divider');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const backgrounds = await quotaPanel.evaluate(node => {
      const app = node.closest('.app');
      const original = app.classList.contains('has-custom-background');
      const initial = getComputedStyle(node).backgroundColor;
      app.classList.add('has-custom-background');
      const withWallpaper = getComputedStyle(node).backgroundColor;
      app.classList.toggle('has-custom-background', original);
      return [initial, withWallpaper];
    });
    assert.deepEqual(backgrounds, [settingsDialogBackgrounds[theme], settingsDialogBackgrounds[theme]]);
    await page.mouse.move(overlap.x, overlap.y);
    assert.ok(await quotaPanel.evaluate((el, { x, y }) => el.contains(document.elementFromPoint(x, y)), overlap),
      'the quota popover receives pointer events on top of the sidebar divider');
    await page.mouse.click(overlap.x, overlap.y);
    assert.equal(await quotaChip.getAttribute('aria-expanded'), 'true');
    await quotaPanel.screenshot({ path: fileURLToPath(new URL(`balance-${theme}.png`, output)) });
  }
  await saveQuota({ ...savedQuota, fields: [{ ...savedQuota.fields[0], label: '¥', path: 'balance', unit: '' }] });
  await quotaChip.getByText('余额 ¥22.11', { exact: true }).waitFor();
  await saveQuota({ ...savedQuota, fields: [{ ...savedQuota.fields[0], label: '余额', path: 'balance', unit: '¥' }] });
  await balance.getByText('¥22.11', { exact: true }).waitFor();
  await saveQuota({ ...savedQuota, fields: [{ ...savedQuota.fields[0], path: 'missing' }] });
  await quotaPanel.getByText('未返回此字段', { exact: true }).waitFor();
  assert.equal(await quotaPanel.locator('.quota-featured').count(), 0);
  await quotaPanel.screenshot({ path: fileURLToPath(new URL('unmapped.png', output)) });
  await saveQuota(savedQuota);
  await quotaPanel.getByText('120 次', { exact: true }).waitFor();
  assert.equal(await quotaPanel.getByRole('progressbar', { name: '小时已用' }).getAttribute('value'), '37.5');
  await quotaPanel.screenshot({ path: fileURLToPath(new URL('usage-windows.png', output)) });
  const beforeLiveUpdate = reads;
  await saveQuota({ ...savedQuota, fields: savedQuota.fields.map((field, index) => index === 0
    ? { ...field, label: '短周期额度', path: 'usage.hour.used', format: 'fraction', unit: '' } : field) });
  await quotaChip.getByText(/短周期额度 37.5% · 小时已用 37.5%/).waitFor();
  await quotaPanel.getByText('短周期额度', { exact: true }).waitFor();
  assert.equal(await quotaPanel.getByText('120 次', { exact: true }).count(), 0);
  assert.equal(reads, beforeLiveUpdate + 1, 'visible quota surfaces share one new read after the commit');
  await saveQuota(savedQuota);
  await quotaChip.getByText(/每周剩余 120 次/).waitFor();
  await page.keyboard.press('Escape');
  await quotaPanel.waitFor({state:'detached'});
  assert.ok(await quotaChip.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'none'),
    'Escape quietly restores the pointer-opened quota chip');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.ok(await quotaChip.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'solid'),
    'keyboard navigation immediately restores a visible focus ring');
  await page.keyboard.press('Enter');
  await quotaPanel.waitFor();
  await page.keyboard.press('Escape');
  await quotaPanel.waitFor({state:'detached'});
  assert.ok(await quotaChip.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'solid'),
    'a keyboard-opened panel keeps keyboard focus visible on return');
  await page.mouse.move(overlap.x, overlap.y);
  await page.mouse.down();
  await page.mouse.move(overlap.x + 16, overlap.y);
  assert.ok(Math.abs((await sidebarDivider.boundingBox()).x - divider.x - 16) < 1, 'the same point resizes the sidebar once the popover closes');
  await page.mouse.move(overlap.x, overlap.y);
  await page.mouse.up();
  await page.evaluate(() => window.__settingsResourcesQa.openSecondSession());
  await page.locator('.model-label').getByText('第二来源模型').waitFor();
  assert.equal(await quotaChip.count(), 0);
  await page.evaluate(() => sessionStorage.setItem('qa:quota-placement', 'hidden'));
  await page.reload();
  await page.locator('.composer-editor').waitFor();
  assert.equal(await quotaChip.count(), 0);
  await page.evaluate(() => sessionStorage.removeItem('qa:quota-placement'));
  await page.reload();
  await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click();
  await page.locator('.model-label').getByText('当前会话模型').waitFor();
  await quotaChip.getByText(/每周剩余 120 次 · 小时已用 37.5%/).waitFor();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await openEditor();
  assert.equal(await group(1).getByLabel('返回字段路径').inputValue(), 'usage.week.remaining');
  await editor.getByLabel('额度接口（GET）').fill(endpoint + '/authorization');
  await editor.getByRole('button', { name: '额度接口认证' }).click();
  await page.getByRole('option', { name: /^来源 API Key · 原始 Authorization/ }).click();
  await editor.locator('.quota-request-options > summary').click();
  await editor.getByRole('button', { name: '添加请求头', exact: true }).click();
  await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).fill('2023-06-01');
  await group(1).getByLabel('显示名称').fill('小时额度');
  await group(1).getByLabel('返回字段路径').fill('usage.hour.used');
  await group(1).getByLabel('单位（可选）').fill('');
  await group(1).getByRole('button', { name: /显示格式/ }).click();
  await page.getByRole('option', { name: '比例（0–1）' }).click();
  await group(3).getByRole('checkbox').uncheck();
  await group(2).getByRole('checkbox').check();
  await group(2).getByLabel('值翻译').fill('active=生效');
  await editor.getByRole('button', { name: '保存更改' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(provider.quota.auth, 'authorization');
  assert.deepEqual(provider.quota.headers, [{ name: 'anthropic-version', value: '2023-06-01' }]);
  await page.locator('[data-sidebar-section="conversations"]').click();
  await quotaChip.getByText(/小时额度 37.5% · 套餐状态 生效/).waitFor();
  await quotaChip.click();
  await quotaPanel.getByText('生效', { exact: true }).waitFor();
  await page.screenshot({path: fileURLToPath(new URL('statusbar-quota.png', output))});
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await openEditor();
  assert.match(await editor.getByRole('button', { name: '额度接口认证' }).innerText(), /原始 Authorization/);
  assert.equal(await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).inputValue(), '2023-06-01');
  await editor.getByRole('button', { name: '读取接口字段' }).click();
  await editor.getByRole('button', { name: '选择接口返回字段' }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('auth-authorization.png', output)) });
  const headersAccordion = editor.locator('.quota-request-options');
  const headersTrigger = headersAccordion.locator('summary');
  assert.equal(await headersTrigger.evaluate(node => getComputedStyle(node).listStyleType), 'none');
  assert.equal(await headersAccordion.locator('.pi-accordion-badge').innerText(), '1');
  await headersTrigger.focus();
  await headersTrigger.press('Space');
  await page.waitForFunction(() => !document.querySelector('.quota-request-options').open);
  // A saved header used to force this section open again on every draft edit.
  await editor.getByLabel('额度接口（GET）').fill(endpoint + '/authorization?view=compact');
  assert.equal(await headersAccordion.evaluate(node => node.open), false, 'parent edits retain the collapsed state');
  await editor.getByLabel('额度接口（GET）').fill(endpoint + '/authorization');
  await headersTrigger.press('Enter');
  await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).waitFor();
  assert.equal(await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).inputValue(), '2023-06-01');
  await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).fill('');
  await headersTrigger.click();
  assert.equal(await editor.locator('form').evaluate(form => form.reportValidity()), false);
  assert.equal(await headersAccordion.evaluate(node => node.open), true, 'invalid fields reveal their collapsed section before native validation focuses them');
  await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).fill('2023-06-01');
  await editor.getByRole('textbox', { name: '附加请求头 1 的值' }).blur();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await headersAccordion.screenshot({ path: fileURLToPath(new URL(`accordion-${theme}.png`, output)) });
  }
  await page.setViewportSize({ width: 640, height: 760 });
  assert.ok(await headersAccordion.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await headersAccordion.screenshot({ path: fileURLToPath(new URL('accordion-narrow.png', output)) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await toggle.click();
  await editor.getByRole('button', { name: '保存更改' }).click();
  await editor.waitFor({ state: 'detached' });
  await more.click();
  assert.equal(await quotaButton.count(), 0);
  await page.keyboard.press('Escape');
  const before = reads;
  await page.locator('[data-sidebar-section="conversations"]').click();
  assert.equal(await quotaChip.count(), 0);
  assert.equal(reads, before);
  // A saved, enabled source still needs the extension to expose any quota UI.
  provider.quota = { ...provider.quota, enabled: true };
  await page.evaluate(() => localStorage.setItem('quota-extension', 'off'));
  await page.reload();
  await page.locator('.session-row').first().click();
  assert.equal(await quotaChip.count(), 0);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: '模型配置', exact: true }).click();
  await more.click();
  assert.equal(await quotaButton.count(), 0);
  await page.keyboard.press('Escape');
  await openEditor();
  await editor.getByLabel('显示名称', { exact: true }).waitFor();
  assert.equal(await toggle.count(), 0);
  assert.equal(reads, before);
  assert.deepEqual(errors, []);
  console.log('350-model directory, quota mapping, stale/auth/retry, saved preferences, keyboard focus and existing extension verified.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({path:fileURLToPath(new URL('failure.png', output))});
  throw error;
} finally {
  await browser?.close();
  quotaApi.closeAllConnections();
  await new Promise(resolve => quotaApi.close(resolve));
  await server.close();
}
