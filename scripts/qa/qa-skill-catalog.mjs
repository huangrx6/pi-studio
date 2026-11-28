import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSettingsResourcesFixture } from './fixtures/settings-resources.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = `${root}/.qa/skill-catalog`;
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);

function installCatalogFixture() {
  const readSettings = window.piApi.settings;
  window.piApi.settings = async cwd => {
    const settings = await readSettings(cwd);
    const studio = { ...settings.skills.find(skill => skill.origin === 'studio' && skill.scope === 'user'),
      name: '文档审阅', description: '核对技术文档中的步骤和引用。', disableModelInvocation: false };
    const plugin = { ...studio, name: 'Excalidraw 画布', description: '在对话侧栏中编辑、预览和导出图形。',
      path: '/qa/plugins/excalidraw/skills/canvas/SKILL.md', baseDir: '/qa/plugins/excalidraw/skills/canvas',
      origin: 'plugin', ownerPluginId: 'studio.excalidraw', managed: true };
    return { ...settings, skills: [studio, plugin, ...settings.skills.filter(skill => skill.scope === 'user' && skill.origin === 'agents')], skillErrors: [] };
  };
  const examples = [
    ['algorithmic-art', '用种子、形状和色彩参数制作可复现的生成艺术。'],
    ['brand-guidelines', '将品牌配色和字体应用到文档、演示和界面。'],
    ['canvas-design', '将主题或简报制作成可导出的静态视觉作品。'],
    ['doc-coauthoring', '协作起草、修订和审阅技术文档。'],
    ['docx', '编辑文档结构、批注和段落样式。'],
    ['frontend-design', '构建响应式页面，细化组件布局和交互。'],
    ['pdf', '提取文本、合并页面或填写表单。'],
    ['xlsx', '整理表格、检查公式并分析数据。'],
    ['web-artifacts-builder', 'Build interactive web artifacts with reusable components, page navigation, and shared styles. The preview shows the files and resources that will be installed.'],
  ];
  const makeCatalog = (id, name, count, extra = {}) => {
    const source = { id, name, type: 'directory', location: `/qa/skills/${id}`, enabled: true, lastError: '', itemCount: count, ...extra };
    const items = Array.from({ length: count }, (_, index) => {
      const [name, description] = (id === 'public' && examples[index]) || [`workflow-${index + 1}`, '从项目资料中整理步骤，生成可复用的工作记录。'];
      return { id: `${id}:${name}`, listingId: name, name, description, sourceId: id, sourceName: source.name, version: index % 3 ? '1.0' : '', invocation: 'automatic', resourceCount: index % 5, promptTokens: 32 + index * 3, installed: index === 1 || index === 4, updateAvailable: index === 4, installedVersion: index === 4 ? '0.9' : undefined };
    });
    return { source, items, diagnostics: [] };
  };
  const catalogs = [
    makeCatalog('public', 'Anthropics', 20, { type: 'github', location: 'https://github.com/anthropics/skills' }),
  ];
  window.piApi.skillHub = async ({ refresh } = {}) => {
    if (refresh && catalogs.length === 1) {
      catalogs.push(makeCatalog('team', '团队目录', 38), makeCatalog('off', '归档源', 0, { enabled: false }),
        makeCatalog('unavailable', '离线目录', 0, { lastError: '无法读取目录' }));
    } else if (refresh) catalogs[3] = makeCatalog('unavailable', '离线目录', 1);
    return { sources: catalogs.map(entry => entry.source), catalogs };
  };
  const prepare = window.piApi.prepareSkillInstall;
  window.piApi.prepareSkillInstall = async request => {
    const preview = await prepare(request);
    if (request.listingId === 'web-artifacts-builder') {
      const listing = catalogs[0].items.find(item => item.listingId === request.listingId);
      const files = [
        { path: 'SKILL.md', size: 3072 },
        { path: 'LICENSE.txt', size: 11366 },
        { path: 'scripts/bundle-artifact.sh', size: 1536 },
        { path: 'scripts/init-artifact.sh', size: 9933 },
        { path: 'scripts/shadcn-components.tar.gz', size: 19968 },
      ];
      return { ...preview, name: listing.name, sourceName: listing.sourceName, version: '0.0.0+fa5ee40038cd',
        description: listing.description, promptTokens: 132, resourceCount: files.length - 1,
        totalBytes: files.reduce((total, file) => total + file.size, 0), files };
    }
    return { ...preview, resourceCount: 39, totalBytes: 4000,
      files: Array.from({ length: 40 }, (_, i) => ({ path: i ? `references/工作流程-${i}.md` : 'SKILL.md', size: 100 })) };
  };
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:2});(${installSettingsResourcesFixture})();(${installCatalogFixture})();` });
  await page.goto(server.origin);
  await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tablist', { name: '插件与资源' }).getByRole('tab', { name: '技能', exact: true }).click();
  const hub = page.locator('.skill-hub-card');
  const source = name => hub.getByRole('button', { name: `浏览技能源 ${name}`, exact: true });
  const catalog = page.locator('.skill-catalog-dialog');
  const list = catalog.locator('.skill-catalog-results');
  const cards = catalog.locator('.skill-hub-item');
  const search = catalog.getByRole('textbox', { name: '搜索技能', exact: true });
  const positions = () => page.evaluate(() => ({
    pageTop: document.querySelector('.settings-content').scrollTop,
    installedTop: document.querySelector('.installed-skills').getBoundingClientRect().top,
    overviewHeight: document.querySelector('.skill-hub-card').getBoundingClientRect().height,
  }));
  const focused = async locator => assert.ok(await locator.evaluate(node => document.activeElement === node));

  await source('Anthropics').waitFor();
  const overview = page.locator('.plugin-workspace');
  const installed = overview.getByRole('region', { name: '已安装技能', exact: true });
  const summaries = installed.locator('.installed-skill-group summary');
  assert.equal(await summaries.count(), 3);
  assert.deepEqual(await summaries.locator('.pi-accordion-badge').allTextContents(), ['1 个', '1 个', '11 个']);
  assert.equal(await installed.locator('code').count(), 0);
  assert.ok(await installed.getByRole('button', { name: '请在插件页卸载「excalidraw」' }).isDisabled());
  for (const trigger of await summaries.all()) {
    if (await trigger.evaluate(node => node.parentElement.open)) await trigger.click();
  }
  await page.mouse.move(0, 0);
  for (const [theme, width] of [['light', 1440], ['dark', 540]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok(await overview.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const aligned = (selector, edge) => overview.locator(selector).evaluateAll((nodes, edge) => {
      const values = nodes.map(node => node.getBoundingClientRect()[edge]);
      return Math.max(...values) - Math.min(...values) <= 1;
    }, edge);
    assert.ok(await aligned('.installed-skill-group-heading strong, .skill-hub-overview-copy strong', 'left'));
    assert.ok(await aligned('.pi-accordion-badge, .skill-hub-source-status', 'right'));
    const box = await overview.boundingBox();
    await page.screenshot({ path: `${output}/skills-overview-${theme}.png`,
      clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await hub.getByRole('button', { name: '刷新技能源' }).click();
  await source('团队目录').waitFor();
  await source('Anthropics').scrollIntoViewIfNeeded();
  const before = await positions();
  await source('Anthropics').click();
  await page.getByRole('dialog', { name: 'Anthropics', exact: true }).waitFor();
  assert.equal(await cards.count(), 20);
  assert.equal(await hub.locator('.skill-hub-item').count(), 0);
  await focused(search);
  assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: `${output}/catalog-dark.png` });
  const preview = page.locator('.skill-install-dialog');
  const fileDetails = preview.locator('.skill-install-files');
  const install = preview.getByRole('button', { name: '安装技能', exact: true });
  const shortPreview = catalog.getByRole('button', { name: '查看技能 web-artifacts-builder', exact: true });
  await shortPreview.click();
  await install.waitFor();
  assert.equal(await preview.locator('.skill-install-heading p').innerText(), 'Anthropics · v0.0.0+fa5ee40038cd');
  assert.ok(await fileDetails.evaluate(node => node.open), 'short file manifests start open');
  for (const [theme, width] of [['light', 1440], ['dark', 430]]) {
    await page.setViewportSize({ width, height: 820 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const edges = await preview.evaluate(dialog => {
      const rect = selector => dialog.querySelector(selector).getBoundingClientRect();
      const left = ['.skill-install-heading h2', '.skill-install-heading p', '.skill-install-description', '.skill-install-overview dt',
        '.skill-install-scope-heading h3', '.skill-install-scope-path', '.pi-accordion-label', '.skill-install-file-list code',
        '.skill-install-file-hash'].map(selector => rect(selector).left);
      const right = ['.detail-header .icon-button', '.skill-install-scope-options', '.pi-accordion-chevron',
        '.skill-install-file-list > div > span', '.skill-install-footer-actions'].map(selector => rect(selector).right);
      const spread = values => Math.max(...values) - Math.min(...values);
      return { left: spread(left), right: spread(right), overflow: dialog.scrollWidth - dialog.clientWidth };
    });
    assert.ok(edges.left <= 1 && edges.right <= 1 && edges.overflow <= 1, `${width}px preview aligns both edges: ${JSON.stringify(edges)}`);
    await preview.screenshot({ path: `${output}/install-aligned-${theme}.png` });
  }
  await preview.getByRole('button', { name: '共享', exact: true }).click();
  await install.waitFor();
  assert.equal(await preview.locator('.skill-install-scope-path').innerText(), '/qa/user/agents');
  await preview.getByRole('button', { name: '项目', exact: true }).click();
  await preview.getByRole('button', { name: '项目技能工作区', exact: true }).waitFor();
  await install.waitFor();
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  await focused(shortPreview);
  await page.setViewportSize({ width: 1440, height: 900 });
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const last = cards.last().getByRole('button');
  const previousTop = await list.evaluate(node => node.scrollTop);
  await last.click();
  await install.waitFor();
  assert.equal(await fileDetails.evaluate(node => node.open), false, 'large file manifests start collapsed');
  await fileDetails.locator('summary').focus();
  await fileDetails.locator('summary').press('Enter');
  const files = preview.getByRole('group', { name: '技能文件列表' });
  assert.equal(await files.locator('code').count(), 40);
  assert.ok(await files.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight <= 260));
  await files.focus();
  await files.press('End');
  await page.waitForFunction(() => document.querySelector('.skill-install-file-list').scrollTop > 0);
  for (const [theme, width] of [['dark', 1440], ['light', 430]]) {
    await page.setViewportSize({ width, height: 820 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await preview.screenshot({ path: `${output}/install-files-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  await focused(last);
  assert.equal(await list.evaluate(node => node.scrollTop), previousTop);
  await search.fill('brand');
  assert.equal(await cards.count(), 1);
  assert.equal(await list.evaluate(node => node.scrollTop), 0);
  await search.fill('不存在');
  await catalog.getByRole('button', { name: '清除搜索', exact: true }).click();
  await focused(search);
  await page.keyboard.press('Escape');
  await catalog.waitFor({ state: 'detached' });
  assert.deepEqual(await positions(), before);
  await focused(source('Anthropics'));

  await hub.getByRole('button', { name: '搜索技能', exact: true }).click();
  await search.fill('workflow-38');
  assert.equal(await cards.count(), 1);
  await cards.first().getByText('团队目录', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await source('团队目录').click();
  assert.equal(await cards.count(), 24);
  await catalog.getByRole('button', { name: /显示更多/ }).click();
  assert.equal(await cards.count(), 38);
  await page.setViewportSize({ width: 430, height: 620 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await search.fill('workflow-3');
  assert.equal(await cards.count(), 10);
  assert.ok(await list.evaluate(node => node.scrollWidth === node.clientWidth));
  assert.equal(await catalog.locator('.skill-hub-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
  await page.screenshot({ path: `${output}/catalog-narrow.png` });
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1440, height: 900 });
  await source('归档源').click();
  await catalog.getByText('此技能源已停用。').waitFor();
  await catalog.getByRole('button', { name: '管理源', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '管理技能源' });
  await manager.waitFor();
  for (const [theme, width] of [['light', 1440], ['dark', 600]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await manager.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
    assert.ok(await manager.locator('.dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await manager.screenshot({ path: `${output}/source-manager-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await manager.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await source('离线目录').click();
  await catalog.getByRole('alert').getByText('无法读取目录').waitFor();
  await catalog.getByRole('button', { name: '重新读取' }).click();
  await cards.first().waitFor();
  assert.equal(await catalog.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed skill source browsing, search, paging, nested dialogs, scroll restoration, disabled sources, retry and responsive layout.');
} finally {
  await browser?.close();
  await server.close();
}
