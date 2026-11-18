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
  const examples = [
    ['algorithmic-art', '用种子、形状和色彩参数制作可复现的生成艺术。'],
    ['brand-guidelines', '将品牌配色和字体应用到文档、演示和界面。'],
    ['canvas-design', '将主题或简报制作成可导出的静态视觉作品。'],
    ['doc-coauthoring', '协作起草、修订和审阅技术文档。'],
    ['docx', '编辑文档结构、批注和段落样式。'],
    ['frontend-design', '构建响应式页面，细化组件布局和交互。'],
    ['pdf', '提取文本、合并页面或填写表单。'],
    ['xlsx', '整理表格、检查公式并分析数据。'],
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
    makeCatalog('team', '团队目录', 38), makeCatalog('off', '归档源', 0, { enabled: false }),
    makeCatalog('unavailable', '离线目录', 0, { lastError: '无法读取目录' }),
  ];
  window.piApi.skillHub = async ({ refresh } = {}) => {
    if (refresh) catalogs[3] = makeCatalog('unavailable', '离线目录', 1);
    return { sources: catalogs.map(entry => entry.source), catalogs };
  };
  const prepare = window.piApi.prepareSkillInstall;
  window.piApi.prepareSkillInstall = async request => ({
    ...await prepare(request), resourceCount: 39, totalBytes: 4000,
    files: Array.from({ length: 40 }, (_, i) => ({ path: i ? `references/工作流程-${i}.md` : 'SKILL.md', size: 100 })),
  });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:2});(${installSettingsResourcesFixture})();(${installCatalogFixture})();` });
  await page.goto(server.origin);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '技能', exact: true }).click();
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
  await page.locator('.settings-content').evaluate(node => { node.scrollTop = 50; });
  const before = await positions();
  await source('Anthropics').click();
  await page.getByRole('dialog', { name: 'Anthropics', exact: true }).waitFor();
  assert.equal(await cards.count(), 20);
  assert.equal(await hub.locator('.skill-hub-item').count(), 0);
  await focused(search);
  assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: `${output}/catalog-dark.png` });
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const last = cards.last().getByRole('button');
  const previousTop = await list.evaluate(node => node.scrollTop);
  await last.click();
  const preview = page.locator('.skill-install-dialog');
  await preview.getByRole('button', { name: '安装技能', exact: true }).waitFor();
  const fileDetails = preview.locator('.skill-install-files');
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
