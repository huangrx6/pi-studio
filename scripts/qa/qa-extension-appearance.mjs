import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/extension-appearance/', root);
const quota = JSON.parse(await readFile(new URL('extensions/pi-quota-status/pi-studio.extension.json', root), 'utf8'));
function installAppearanceFixture(quotaManifest) {
  const api = window.piApi;
  const detail = { id: 'detail', title: '构建详情', slot: 'tool.view', content: [{ kind: 'text', text: '当前构建正常' }] };
  const history = { id: 'history', title: '构建历史', slot: 'tool.view', content: [{ kind: 'text', text: '最近构建已完成' }] };
  const build = { id: 'build', title: '构建状态', slots: ['status.chip', 'composer.above', 'composer.below'], details: 'detail',
    icon: 'terminal', color: 'warning', content: [{ kind: 'text', text: '就绪' }] };
  const settings = [{ id: 'settings', title: '构建偏好', content: [{ kind: 'text', text: '自动检测构建状态' }] }];
  const manifests = [quotaManifest, { id: 'qa.build', name: '构建监控', description: '查看当前构建状态和最近的构建记录。', author: 'Studio QA', version: '1.0.0', contributes: { panels: [detail, history, build], settings } },
    { id: 'qa.other', name: '另一个扩展', description: '管理工作区的自定义偏好。', author: 'Studio QA', version: '1.0.0', contributes: {
      settings: [{ id: 'settings', title: '其他偏好', content: [{ kind: 'text', text: '仅在自己的设置中显示' }] }],
    } }];
  const toExtension = manifest => ({ id: 'user:' + manifest.id, name: manifest.name, version: manifest.version,
    scope: 'user', tier: 'user', enabled: true, trusted: true, available: true, health: 'ready', manifest });
  const extensions = manifests.map(toExtension);
  const items = () => extensions.flatMap(extension => [
    ...(extension.manifest.contributes.panels ?? []),
    ...(extension.manifest.contributes.settings ?? []).map(setting => ({ ...setting, slot: 'settings.panel' })),
  ].map(panel => ({
    ...panel, id: extension.id + '/' + panel.id, contributionId: panel.id, extensionId: extension.id, extensionName: extension.name,
    scope: 'user', slot: panel.slot ?? panel.slots[0], slots: panel.slots ?? [panel.slot], size: panel.size ?? 'regular', priority: 0,
  })));
  const readSettings = api.settings;
  const readState = api.state;
  api.state = async cwd => {
    const snapshot = await readState(cwd);
    return { ...snapshot, model: { ...snapshot.model, quotaProvider: { id: 'qa', name: '测试来源' } } };
  };
  for (const key of ['conversationPage', 'conversationSnapshot', 'subscribeConversation']) {
    const read = api[key];
    api[key] = async (...args) => {
      const snapshot = await read(...args);
      return { ...snapshot, model: { ...snapshot.model, quotaProvider: { id: 'qa', name: '测试来源' } } };
    };
  }
  api.settings = async cwd => ({ ...await readSettings(cwd),
    providers: [{ id: 'qa', name: '测试来源', enabled: true, quotaEnabled: true }], extensions, extensionErrors: [] });
  api.gitRepositories = async cwd => [
    { id: 'projects/a-repository-with-a-long-name', name: '长名称仓库', root: `${cwd}/projects/a-repository-with-a-long-name` },
    { id: '.', name: '项目根目录', root: cwd },
  ];
  const branch = 'feature/long-branch-for-narrow-header';
  api.gitWorkspaceStatus = async () => ({ available: true, branch,
    dirty: { total: 0, staged: 0, unstaged: 0, untracked: 0 }, worktree: { isWorktree: false }, worktrees: [] });
  api.gitBranches = async cwd => ({ root: cwd, branch, head: 'abc1234',
    branches: [{ name: branch, head: 'abc1234', remote: false, worktree: cwd, upstreamRemote: '', upstreamBranch: '' }] });
  api.gitRead = async (_id, { kind, repository }) => {
    if (kind !== 'state') throw new Error(`Unexpected Git read: ${kind}`);
    return { root: repository, branch, head: 'abc1234', files: [], filesVersion: 'clean', filesUnchanged: false,
      merging: false, mergeHead: '', indexVersion: 'clean', remotes: [], upstreamRemote: '', upstreamBranch: '', ahead: 0, behind: 0, gone: false };
  };
  api.officialExtensions = async () => ({ extensions: [], errors: [] });
  api.extensionPublisherTrust = async () => ({ publishers: [] });
  const extensionListeners = new Set();
  api.onExtensionsChanged = listener => {
    extensionListeners.add(listener);
    return () => extensionListeners.delete(listener);
  };
  api.openToolWindow = async request => { window.lastTool = request; };
  api.extensionsUi = async () => ({ items: items(), errors: [], apiVersion: 1, syncedAt: Date.now() });
  api.onProviderQuotaInvalidated = () => () => {};
  api.providerQuota = async (_id, refresh) => {
    window.__quotaReads = (window.__quotaReads ?? 0) + 1;
    if (refresh) window.__quotaHours = 16;
    const hours = window.__quotaHours ?? 12;
    return { status: 'ready', metrics: [
      { summary: true, label: '小时已用', value: hours + '%', percent: hours },
      { summary: true, label: '本周已用', value: '28%', percent: 28 },
      { summary: false, label: '每日剩余', value: '100 次' },
    ], updatedAt: Date.now() };
  };
}

await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 850 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await page.addInitScript({ content: `const saved = localStorage.getItem('pi-studio:preferences');
    (${installPerformanceFixture})({sessionCount:1,turnCount:1});
    if (saved) localStorage.setItem('pi-studio:preferences', saved);
    else {
      const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
      prefs.extensionPlacements = { 'user:pi-quota-status/quota-chip': 'hidden' };
      localStorage.setItem('pi-studio:preferences', JSON.stringify(prefs));
    }
    (${installAppearanceFixture})(${JSON.stringify(quota)});` });
  const button = name => page.getByRole('button', { name, exact: true });
  const openSettings = async () => {
    await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
    await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
  };
  const closeSettings = () => page.locator('[data-sidebar-section="conversations"]').click();
  const configure = name => button(`打开 ${name} 设置`).click();
  const detailDialog = page.locator('.extension-detail-dialog');
  const closeDetail = async () => {
    await detailDialog.getByRole('button', { name: '完成', exact: true }).click();
    await detailDialog.waitFor({ state: 'detached' });
  };
  const icon = (parent, name, color) => parent.locator(`svg[data-icon="${name}"][data-color="${color}"]`);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('pi-studio:preferences')));
  const buildTrigger = button('构建状态 图标与配色');
  const preview = page.getByRole('group', { name: '构建状态 外观' }).locator('.extension-appearance-preview');
  const placement = page.getByRole('group', { name: '构建状态 显示位置' });
  const above = page.locator('.extension-summaries.is-composer-above');
  const below = page.locator('.extension-summaries.is-composer-below');
  const composer = page.locator('.composer-editor');
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  await composer.waitFor();
  await openSettings();
  const library = page.locator('.installed-extension-section');
  const cards = library.locator('article');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 3);
  assert.equal(await library.getByRole('switch').count(), 0);
  assert.equal(await library.locator('.extension-placement-options, .extension-appearance-trigger').count(), 0);
  const columns = () => library.locator('.extension-library-items').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  for (const [width, count] of [[1440, 2], [900, 2], [480, 1]]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await columns(), count, `${width}px window lays out ${count} columns`);
    assert.ok(await cards.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
  }
  await page.setViewportSize({ width: 1440, height: 850 });
  assert.equal(await library.getByRole('group', { name: '扩展排列方式' }).count(), 0);
  await page.locator('.plugin-workspace').screenshot({ path: fileURLToPath(new URL('library-grid-light.png', output)) });
  const displayOrder = page.locator('.extension-display-order');
  await button('对话显示顺序').click();
  assert.equal(await displayOrder.locator('li').count(), 2);
  await displayOrder.screenshot({ path: fileURLToPath(new URL('display-order.png', output)) });
  await button('关闭对话显示顺序').click();
  await configure('额度状态');
  assert.equal(await detailDialog.locator('.extension-appearance-trigger').count(), 1, 'linked quota chip and detail panel share one appearance row');
  await icon(button('额度状态 图标与配色'), 'gauge', 'neutral').waitFor();
  const quotaPlacement = page.getByRole('group', { name: '额度状态 显示位置' });
  assert.deepEqual(await quotaPlacement.getByRole('button').allTextContents(), ['底部状态栏', '隐藏摘要']);
  await detailDialog.screenshot({ path: fileURLToPath(new URL('quota-settings.png', output)) });
  assert.equal(await quotaPlacement.getByRole('button', { name: '隐藏摘要', pressed: true }).count(), 1);
  await quotaPlacement.getByRole('button', { name: '底部状态栏' }).click();
  await closeDetail();
  await configure('构建监控');
  await icon(buildTrigger, 'terminal', 'warning').waitFor();
  await buildTrigger.press('Enter');
  await button('云').click();
  await button('成功绿').click();
  const green = icon(preview, 'cloud', 'success');
  await green.waitFor();
  const lightColor = await green.evaluate(el => getComputedStyle(el).color);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.notEqual(await green.evaluate(el => getComputedStyle(el).color), lightColor);
  const swatches = await page.locator('.extension-color-choices i').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor));
  assert.equal(new Set(swatches).size, 6, 'settings preview retains the six workspace colors');
  await detailDialog.screenshot({ path: fileURLToPath(new URL('settings-dark.png', output)) });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await detailDialog.screenshot({ path: fileURLToPath(new URL('settings-light.png', output)) });
  await placement.getByRole('button', { name: '输入框上方' }).click();
  const ownSettings = page.locator('.extension-detail-dialog').getByRole('region', { name: '扩展设置' });
  await ownSettings.getByText('自动检测构建状态').waitFor();
  assert.equal(await page.getByText('仅在自己的设置中显示').count(), 0);
  await button('关闭扩展详情').click();
  await detailDialog.waitFor({ state: 'detached' });
  await configure('额度状态');
  await button('额度状态 图标与配色').click();
  await page.getByRole('group', { name: '额度状态 外观' }).getByRole('button', { name: '钱包' }).click();
  await closeDetail();
  await closeSettings();
  await composer.fill('切换工作台后的会话草稿');
  await icon(above, 'cloud', 'success').waitFor();
  assert.equal(await below.count(), 0);
  assert.ok((await above.boundingBox()).y < (await composer.boundingBox()).y);
  await button('打开 额度状态 详情').click();
  const quotaPanel = page.getByRole('dialog', { name: '额度状态', exact: true });
  await quotaPanel.getByText('每日剩余').waitFor();
  await quotaPanel.locator('.popover-title').getByText('额度状态', { exact: true }).waitFor();
  assert.equal(await icon(quotaPanel, 'wallet', 'neutral').count(), 1);
  await quotaPanel.screenshot({ path: fileURLToPath(new URL('quota-panel.png', output)) });
  await quotaPanel.getByRole('button', { name: '刷新额度' }).click();
  await quotaPanel.getByText('16%', { exact: true }).waitFor();
  await quotaPanel.getByRole('button', { name: '关闭', exact: true }).click();
  await above.getByRole('button', { name: '打开 构建状态 详情' }).click();
  await page.waitForFunction(() => window.lastTool?.panelId === 'user:qa.build/detail');
  assert.equal(await composer.innerText(), '切换工作台后的会话草稿');

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置' }).click();
  const statusBar = page.getByRole('contentinfo', { name: '状态栏' });
  const settingsRegion = page.getByRole('region', { name: '设置', exact: true });
  await settingsRegion.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.mouse.move(0, 0);
  await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  await settingsRegion.getByRole('main').evaluate(canvas => { canvas.scrollTop = 0; });
  await page.screenshot({ path: fileURLToPath(new URL('settings-statusbar.png', output)), animations: 'disabled' });
  const branchPicker = statusBar.getByRole('button', { name: /^切换分支，当前/ });
  await branchPicker.click();
  await page.getByRole('dialog', { name: '切换分支' }).waitFor();
  await page.keyboard.press('Escape');
  await statusBar.getByRole('button', { name: '打开 额度状态 详情' }).click();
  await quotaPanel.getByText('每日剩余').waitFor();
  await page.keyboard.press('Escape');
  await quotaPanel.waitFor({ state: 'hidden' });
  assert.equal(await settingsRegion.isVisible(), true);
  await branchPicker.click();
  await page.getByRole('dialog', { name: '切换分支' }).getByRole('button', { name: '打开 Git' }).click();
  await settingsRegion.waitFor({ state: 'detached' });
  await page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: 'Git', pressed: true }).waitFor();
  await openSettings();
  await configure('构建监控');
  await placement.getByRole('button', { name: '输入框下方' }).click();
  await closeDetail();
  await closeSettings();
  await icon(below, 'cloud', 'success').waitFor();
  assert.equal(await above.count(), 0);
  assert.ok((await below.boundingBox()).y > (await composer.boundingBox()).y);
  await page.reload();
  await page.locator('.session-row').first().click();
  await icon(below, 'cloud', 'success').waitFor();
  await openSettings();
  await configure('构建监控');
  await placement.getByRole('button', { name: '底部状态栏' }).click();
  await buildTrigger.click();
  await preview.getByRole('button', { name: '恢复默认' }).click();
  await icon(preview, 'terminal', 'warning').waitFor();
  const prefs = await stored();
  assert.equal(prefs.extensionPlacements['user:qa.build/build'], 'statusbar');
  assert.deepEqual(prefs.extensionAppearances, {
    'user:pi-quota-status/quota-chip': { icon: 'wallet' },
    'user:pi-quota-status/quota-detail': { icon: 'wallet' },
  });
  await closeDetail();
  await closeSettings();
  await icon(page.locator('.studio-statusbar'), 'terminal', 'warning').waitFor();
  assert.equal(await below.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Verified extension settings, summary placement, status details and standalone tool launch.');
} finally {
  await browser?.close();
  await server.close();
}
