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
  const detail = { id: 'detail', title: '构建详情', slot: 'panel.side', content: [{ kind: 'text', text: '当前构建正常' }] };
  const history = { id: 'history', title: '构建历史', slot: 'panel.side', content: [{ kind: 'text', text: '最近构建已完成' }] };
  const build = { id: 'build', title: '构建状态', slots: ['status.chip', 'composer.above', 'composer.below'], details: 'detail',
    icon: 'terminal', color: 'warning', content: [{ kind: 'text', text: '就绪' }] };
  const settings = [{ id: 'settings', title: '构建偏好', content: [{ kind: 'text', text: '自动检测构建状态' }] }];
  const manifests = [quotaManifest, { id: 'qa.build', name: '构建监控', description: '查看当前构建状态和最近的构建记录。', author: 'Studio QA', version: '1.0.0', contributes: { panels: [detail, history, build], settings } },
    { id: 'qa.other', name: '另一个扩展', description: '管理工作区的自定义偏好。', author: 'Studio QA', version: '1.0.0', contributes: {
      settings: [{ id: 'settings', title: '其他偏好', content: [{ kind: 'text', text: '仅在自己的设置中显示' }] }],
    } }];
  const notebook = { id: 'qa.notes', name: '自定义笔记', version: '1.0.0', contributes: { panels: [
    { id: 'notes', title: '工作区笔记', description: '打开项目笔记', slot: 'panel.side', icon: 'database', color: 'info',
      content: [{ kind: 'text', text: '工作区笔记内容' }] },
  ] } };
  if (localStorage.getItem('qa:launcher-notebook')) manifests.push(notebook);
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
  api.settings = async cwd => ({ ...await readSettings(cwd),
    providers: [{ id: 'qa', name: '测试来源', enabled: true, quotaEnabled: true }], extensions, extensionErrors: [] });
  api.gitRepositories = async cwd => [
    { id: 'projects/a-repository-with-a-long-name', name: '长名称仓库', root: `${cwd}/projects/a-repository-with-a-long-name` },
    { id: '.', name: '项目根目录', root: cwd },
  ];
  api.gitWorkspaceStatus = async () => ({ available: true, branch: 'feature/long-branch-for-narrow-header',
    dirty: { total: 0, staged: 0, unstaged: 0, untracked: 0 }, worktree: { isWorktree: false }, worktrees: [] });
  api.officialExtensions = async () => ({ extensions: [], errors: [] });
  api.extensionPublisherTrust = async () => ({ publishers: [] });
  const extensionListeners = new Set();
  api.onExtensionsChanged = listener => {
    extensionListeners.add(listener);
    return () => extensionListeners.delete(listener);
  };
  window.__installLauncherNotebook = () => {
    extensions.push(toExtension(notebook));
    localStorage.setItem('qa:launcher-notebook', 'installed');
    for (const listener of extensionListeners) listener();
  };
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 850 } });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await page.addInitScript({ content: `const saved = localStorage.getItem('pi-studio:preferences');
    (${installPerformanceFixture})({sessionCount:1,turnCount:1});
    if (saved) localStorage.setItem('pi-studio:preferences', saved);
    else {
      const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
      prefs.extensionPlacements = { 'user:pi-quota-status/quota-chip': 'header' };
      localStorage.setItem('pi-studio:preferences', JSON.stringify(prefs));
    }
    (${installAppearanceFixture})(${JSON.stringify(quota)});` });
  const button = name => page.getByRole('button', { name, exact: true });
  const openSettings = async () => {
    await page.locator('.sidebar-bottom button[title="设置"]').click();
    await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
  };
  const closeSettings = () => page.locator('.settings-navigation').getByRole('button', { name: '返回对话' }).click();
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
  const header = page.locator('.chat-header');
  const picker = page.getByRole('dialog', { name: '扩展', exact: true });
  const openExtensions = () => header.getByRole('button', { name: '扩展', exact: true }).click();
  const quotaCard = picker.getByRole('article', { name: '额度状态', exact: true });
  const buildCard = picker.getByRole('article', { name: '构建监控', exact: true });
  const composer = page.locator('.composer-editor');
  await page.goto(server.origin);
  await composer.waitFor();
  await openExtensions();
  await quotaCard.waitFor();
  assert.equal(await quotaCard.locator('.provider-quota-summary').count(), 0, 'drafts have an entry with no quota summary');
  assert.equal(await page.evaluate(() => window.__quotaReads ?? 0), 0, 'opening the draft extension list does not query quota');
  const manage = picker.getByRole('button', { name: '管理扩展', exact: true });
  const background = await manage.evaluate(node => getComputedStyle(node).backgroundColor);
  await manage.hover();
  await page.waitForFunction(idle => getComputedStyle(document.querySelector('.extension-picker-manage')).backgroundColor !== idle, background);
  assert.ok(await manage.evaluate(node => {
    const { paddingLeft, paddingRight } = getComputedStyle(node);
    return parseFloat(paddingLeft) >= 8 && paddingLeft === paddingRight;
  }));
  await picker.screenshot({ path: fileURLToPath(new URL('picker-hover.png', output)) });
  await page.keyboard.press('Escape');
  await page.locator('.session-row').first().click();
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
  assert.deepEqual(await quotaPlacement.getByRole('button').allTextContents(), ['扩展菜单', '隐藏摘要']);
  await detailDialog.screenshot({ path: fileURLToPath(new URL('quota-settings.png', output)) });
  assert.equal(await quotaPlacement.getByRole('button', { name: '扩展菜单', pressed: true }).count(), 1);
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
  assert.equal(await page.getByText('自动检测构建状态').count(), 0);
  await configure('额度状态');
  await button('额度状态 图标与配色').click();
  await page.getByRole('group', { name: '额度状态 外观' }).getByRole('button', { name: '钱包' }).click();
  await closeDetail();
  await closeSettings();
  await composer.fill('切换工作台后的会话草稿');
  await icon(above, 'cloud', 'success').waitFor();
  assert.equal(await below.count(), 0);
  assert.ok((await above.boundingBox()).y < (await composer.boundingBox()).y);
  assert.equal(await header.getByText('12%', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__quotaReads ?? 0), 0, 'the closed picker does not read quota');
  await openExtensions();
  await quotaCard.getByText('12%', { exact: true }).waitFor();
  assert.equal(await quotaCard.locator('dd').count(), 2);
  assert.equal(await icon(quotaCard, 'wallet', 'neutral').count(), 1);
  await buildCard.getByText('就绪', { exact: true }).waitFor();
  await picker.screenshot({ path: fileURLToPath(new URL('cards-light.png', output)) });
  await quotaCard.getByRole('button', { name: '查看 额度状态 详情', exact: true }).click();
  const quotaPanel = page.getByRole('tabpanel', { name: '额度状态', exact: true });
  await quotaPanel.getByText('每日剩余').waitFor();
  const quotaHeading = quotaPanel.locator('.extension-page-head');
  assert.ok(await quotaHeading.getByRole('heading', { name: '额度状态', exact: true }).isVisible());
  assert.equal(await quotaHeading.locator('.extension-slot-source').count(), 0);
  assert.equal(await icon(quotaHeading, 'wallet', 'neutral').count(), 1);
  await quotaPanel.screenshot({ path: fileURLToPath(new URL('quota-panel.png', output)) });
  await quotaPanel.getByRole('button', { name: '刷新额度' }).click();
  await quotaPanel.getByText('16%', { exact: true }).waitFor();
  await openExtensions();
  await quotaCard.getByText('16%', { exact: true }).waitFor();
  await buildCard.getByRole('button', { name: '查看 构建监控 详情', exact: true }).click();
  const buildPanel = page.getByRole('tabpanel', { name: '构建监控', exact: true });
  await buildPanel.getByText('当前构建正常').waitFor();
  await buildPanel.getByRole('button', { name: '构建历史' }).click();
  await buildPanel.getByText('最近构建已完成').waitFor();
  assert.equal(await page.getByRole('tab', { name: '构建监控', exact: true }).count(), 1);
  assert.equal(await composer.innerText(), '切换工作台后的会话草稿');
  await page.screenshot({ path: fileURLToPath(new URL('workbench-light.png', output)) });
  await button('全屏').click();
  await buildPanel.getByText('最近构建已完成').waitFor();
  assert.equal(await page.locator('.panel-tabbar').getByText('16%', { exact: true }).count(), 0);
  await button('退出全屏').click();
  assert.equal(await composer.innerText(), '切换工作台后的会话草稿');
  await button('收起右侧面板').click();

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
  await placement.getByRole('button', { name: '顶栏' }).click();
  await buildTrigger.click();
  await preview.getByRole('button', { name: '恢复默认' }).click();
  await icon(preview, 'terminal', 'warning').waitFor();
  const prefs = await stored();
  assert.equal(prefs.extensionPlacements['user:qa.build/build'], 'header');
  assert.deepEqual(prefs.extensionAppearances, {
    'user:pi-quota-status/quota-chip': { icon: 'wallet' },
    'user:pi-quota-status/quota-detail': { icon: 'wallet' },
  });
  await closeDetail();
  await closeSettings();
  await icon(header.locator('.extension-summary-item'), 'terminal', 'warning').waitFor();
  assert.equal(await below.count(), 0);
  await button('打开右侧面板').click();
  await button('打开工具').click();
  await page.getByRole('menuitem', { name: '打开扩展…' }).click();
  await buildCard.getByRole('button', { name: '查看 构建监控 详情', exact: true }).click();
  await buildPanel.getByText('当前构建正常').waitFor();
  await page.setViewportSize({ width: 1176, height: 730 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.ok(await buildPanel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: fileURLToPath(new URL('workbench-dark.png', output)) });
  await page.setViewportSize({ width: 980, height: 730 });
  await page.waitForFunction(() => !document.querySelector('.file-panel.is-overlay'));
  await page.waitForFunction(() => {
    const heading = document.querySelector('.chat-heading');
    const tools = document.querySelector('.chat-actions');
    const repoLabel = heading?.querySelector('.git-repository-picker .pi-select-value');
    const branchLabel = heading?.querySelector('.git-branch-trigger > span');
    return repoLabel && branchLabel && getComputedStyle(repoLabel).display === 'none' && getComputedStyle(branchLabel).display === 'none'
      && branchLabel.parentElement.getBoundingClientRect().right <= tools.getBoundingClientRect().left;
  });
  assert.equal(await header.locator('.chat-header-status').isVisible(), false, 'pinned summaries have room in the picker');
  await header.getByRole('button', { name: '顶栏项目仓库' }).click();
  await page.getByRole('listbox', { name: '顶栏项目仓库' }).waitFor();
  await page.keyboard.press('Escape');
  await header.getByRole('button', { name: /^切换分支，当前 / }).click();
  await page.getByRole('dialog', { name: '切换分支', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await openExtensions();
  await quotaCard.getByText('12%', { exact: true }).waitFor();
  await buildCard.getByText('就绪', { exact: true }).waitFor();
  assert.ok(await picker.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await picker.screenshot({ path: fileURLToPath(new URL('cards-docked-narrow-dark.png', output)) });
  await page.keyboard.press('Escape');
  await composer.fill('窄窗口仍可继续编辑');
  assert.equal(await composer.innerText(), '窄窗口仍可继续编辑');
  await page.setViewportSize({ width: 820, height: 730 });
  await page.locator('.file-panel.is-overlay').waitFor();
  assert.equal(await page.locator('.panel-tabbar').getByText('12%', { exact: true }).count(), 0);
  await button('打开工具').click();
  await page.getByRole('menuitem', { name: '打开扩展…' }).click();
  await quotaCard.getByText('12%', { exact: true }).waitFor();
  await button('收起右侧面板').click();
  await openExtensions();
  await quotaCard.getByText('12%', { exact: true }).waitFor();

  await page.setViewportSize({ width: 1440, height: 850 });
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...prefs, showCodeView: true }));
  });
  await page.reload();
  await page.locator('.session-row').first().click();
  await button('打开右侧面板').click();
  const launcher = page.getByRole('region', { name: '工作台应用', exact: true });
  const tile = name => launcher.getByRole('button', { name, exact: true });
  const labels = () => launcher.locator('.panel-launcher-label').allTextContents();
  const editor = launcher.getByRole('list', { name: '扩展顺序' });
  const systemEditor = launcher.getByRole('list', { name: '系统工具顺序' });
  const row = name => editor.getByRole('listitem').filter({ hasText: name });
  const systemRow = name => systemEditor.getByRole('listitem').filter({ hasText: name });
  await tile('构建监控').waitFor();
  const defaultTools = ['工作区文件', 'Git', '新建终端', '进展', '子智能体', '轨迹', '浏览器', '运行服务', '临时聊天'];
  assert.deepEqual((await labels()).slice(0, 9), defaultTools);
  assert.equal(await tile('另一个扩展').count(), 0, 'settings-only extensions have no launcher tile');
  await tile('排序').click();
  await systemEditor.getByRole('button', { name: '上移 Git', exact: true }).press('Enter');
  assert.equal((await labels())[0], 'Git');
  const grouped = await labels();
  await row('构建监控').locator('.panel-launcher-grip').dragTo(systemRow('工作区文件'));
  assert.deepEqual(await labels(), grouped, 'system tools and extensions retain their own groups');
  await systemRow('新建终端').locator('.panel-launcher-grip').dragTo(systemRow('Git'));
  assert.equal((await labels())[0], '新建终端');
  await launcher.screenshot({ path: fileURLToPath(new URL('launcher-order.png', output)) });
  await tile('完成').click();
  const arranged = await labels();
  await page.evaluate(() => window.__installLauncherNotebook());
  const notebookTile = tile('自定义笔记');
  await icon(notebookTile, 'database', 'info').waitFor();
  assert.deepEqual(await labels(), [...arranged, '自定义笔记']);

  await openSettings();
  await button('对话显示顺序').click();
  await displayOrder.getByText('自定义笔记', { exact: true }).waitFor();
  const spacing = await displayOrder.evaluate(panel => {
    const frame = panel.getBoundingClientRect();
    const title = panel.querySelector('h2').getBoundingClientRect();
    let divider = panel.querySelector('header').getBoundingClientRect().bottom;
    const rowInsets = [];
    for (const row of panel.querySelectorAll('li')) {
      const label = row.querySelector('span').getBoundingClientRect();
      rowInsets.push(label.top - divider);
      divider = row.getBoundingClientRect().bottom;
      rowInsets.push(divider - label.bottom);
    }
    const lastLabel = panel.querySelector('li:last-child > span').getBoundingClientRect();
    return { rowInsets, aboveTitle: title.top - frame.top, belowLastLabel: frame.bottom - lastLabel.bottom };
  });
  assert.ok(Math.max(...spacing.rowInsets) - Math.min(...spacing.rowInsets) <= 1, 'even spacing on both sides of every row divider');
  assert.ok(Math.abs(spacing.aboveTitle - spacing.belowLastLabel) <= 6, 'outer whitespace balances the title and last label');
  await displayOrder.screenshot({ path: fileURLToPath(new URL('display-order-three.png', output)) });
  await button('关闭对话显示顺序').click();
  await configure('自定义笔记');
  const notebookSettings = detailDialog;
  await notebookSettings.getByRole('button', { name: '工作区笔记 工作台图标与配色', exact: true }).click();
  const notebookAppearance = notebookSettings.getByRole('group', { name: '工作区笔记 工作台外观' });
  await notebookAppearance.getByRole('button', { name: '云', exact: true }).click();
  await notebookAppearance.getByRole('button', { name: '成功绿', exact: true }).click();
  await closeDetail();
  await closeSettings();
  await icon(notebookTile, 'cloud', 'success').waitFor();
  await page.reload();
  await page.locator('.session-row').first().click();
  await button('打开右侧面板').click();
  await icon(notebookTile, 'cloud', 'success').waitFor();
  assert.deepEqual(await labels(), [...arranged, '自定义笔记']);

  await page.setViewportSize({ width: 980, height: 730 });
  await tile('排序').click();
  assert.ok(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await tile('恢复默认').click();
  await tile('完成').click();
  assert.deepEqual((await labels()).slice(0, 9), defaultTools);
  await button('全屏').click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await launcher.screenshot({ path: fileURLToPath(new URL('launcher-dark.png', output)) });
  await notebookTile.click();
  const notebookPanel = page.getByRole('tabpanel', { name: '自定义笔记', exact: true });
  await notebookPanel.getByText('工作区笔记内容').waitFor();
  await icon(page.getByRole('tab', { name: '自定义笔记', exact: true }), 'cloud', 'success').waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified extension appearance, quota, launcher ordering and persistence, new extension placement, and workbench launch.');
} finally {
  await browser?.close();
  await server.close();
}
