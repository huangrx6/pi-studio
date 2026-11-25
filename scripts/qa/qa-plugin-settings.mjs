/** Production Electron coverage for the plugin settings workflow in a disposable profile. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archive from '../../electron/main/core/extension-archive.cjs';
import officialRegistry from '../../assets/official-plugins/registry.json' with { type: 'json' };
import { assertSettingsRowLinkHover, launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-studio-plugin-settings-')));
const profile = path.join(base, 'profile');
const workspace = path.join(base, 'workspace');
const sourceDirectory = path.join(base, 'catalog');
const output = fileURLToPath(new URL('../../.qa/plugin-settings/', import.meta.url));
const example = fileURLToPath(new URL('../../examples/plugins/toolkit-starter/', import.meta.url));
const zip = path.join(base, 'toolkit-starter.pi-plugin.zip');
const originalName = 'Toolkit Starter';
const updateName = 'Toolkit Starter Local';
const otherName = 'Toolkit Automation';
const sourceName = '本地测试源';
let app;
let page;

try {
  await Promise.all([profile, workspace, sourceDirectory, output].map(dir => mkdir(dir, { recursive: true })));
  const files = (await readdir(example, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  await writeFile(zip, archive.createZipArchive(await Promise.all(files.map(async file => {
    const filename = path.join(file.parentPath, file.name);
    return { path: path.relative(example, filename).split(path.sep).join('/'), content: await readFile(filename) };
  }))));
  const manifest = JSON.parse(await readFile(path.join(example, 'pi-studio.plugin.json'), 'utf8'));
  for (const [folder, changes] of [
    ['update', { name: updateName, version: '0.2.0' }],
    ['other', { id: 'example.toolkit-automation', name: otherName, category: 'automation' }],
  ]) {
    const directory = path.join(sourceDirectory, folder);
    await cp(example, directory, { recursive: true });
    await writeFile(path.join(directory, 'pi-studio.plugin.json'), JSON.stringify({ ...manifest, ...changes }));
  }

  ({ app, page } = await launchTestDesktop(workspace, profile, 1240, 840));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  const nav = page.locator('.settings-navigation');
  const content = page.locator('.settings-content');
  const workspacePage = content.locator('.plugin-workspace');
  const toolbar = workspacePage.locator('.plugin-workspace-toolbar');
  const tabs = content.getByRole('tablist', { name: '插件与资源' });
  const catalog = content.getByRole('region', { name: '插件目录', exact: true });
  const sources = page.getByRole('dialog', { name: '插件源', exact: true });
  const review = page.getByRole('dialog', { name: '安装预览', exact: true });
  const settings = () => page.locator('.sidebar-bottom button[title="设置"]').click();
  const click = (parent, name) => parent.getByRole('button', { name, exact: true }).click();
  const detailButton = (parent, name) => parent.getByRole('button', { name: `查看插件 ${name}`, exact: true });
  const tab = name => tabs.getByRole('tab', { name, exact: true }).click();
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  const snapshot = () => page.evaluate(() => window.piApi.listPlugins());
  async function shot(locator, name) {
    await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
    await locator.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  }
  const card = name => catalog.locator('.plugin-package-card').filter({ has: detailButton(page, name) });
  async function checkCards(columns) {
    const layout = await catalog.locator('.plugin-card-grid').evaluate(grid => {
      const bounds = grid.getBoundingClientRect();
      const cards = [...grid.children].map(element => {
        const card = element.getBoundingClientRect();
        const heading = element.querySelector('.plugin-card-heading').getBoundingClientRect();
        const footer = element.querySelector('.plugin-card-footer').getBoundingClientRect();
        const badge = element.querySelector('.plugin-installed-status')?.getBoundingClientRect();
        const name = element.querySelector('h2').getBoundingClientRect();
        return {
          left: card.left, width: card.width,
          inside: heading.left > card.left && footer.right < card.right && footer.top > heading.bottom
            && (!badge || name.right <= badge.left),
          border: getComputedStyle(element).borderStyle,
        };
      });
      return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, width: bounds.width, cards };
    });
    assert.equal(layout.columns, columns, JSON.stringify(layout));
    assert.ok(layout.cards.length > 0 && layout.cards.every(card => card.inside && card.border === 'solid'), JSON.stringify(layout));
    assert.ok(Math.abs(layout.width / columns - layout.cards[0].width) < 12, 'cards fill one grid track');
    if (layout.cards.length > 1) assert.equal(layout.cards[0].left === layout.cards[1].left, columns === 1);
  }
  async function checkCatalogSpacing() {
    const layout = await workspacePage.evaluate(workspace => {
      const bounds = selector => workspace.querySelector(selector).getBoundingClientRect();
      const tabs = bounds('[role=tablist]');
      const actions = bounds('.plugin-workspace-actions');
      const search = bounds('input[type=search]');
      const grid = bounds('.plugin-card-grid');
      return {
        aligned: [bounds('h1').left, tabs.left, search.left].every(left => Math.abs(left - grid.left) <= 1),
        right: Math.abs(actions.right - grid.right) <= 1,
        below: tabs.bottom < search.top && search.bottom < grid.top,
      };
    });
    assert.deepEqual(layout, { aligned: true, right: true, below: true });
  }
  async function checkTabGap(name) {
    await tabs.getByRole('tab', { name, exact: true }).hover();
    const geometry = await tabs.evaluate(async list => {
      await Promise.allSettled(list.getAnimations({ subtree: true }).map(animation => animation.finished));
      const indicator = getComputedStyle(list, '::before');
      const selected = list.querySelector('[aria-selected="true"]').getBoundingClientRect();
      const hovered = list.querySelector('[role="tab"]:hover');
      const translation = new DOMMatrixReadOnly(indicator.transform).m41;
      const left = list.getBoundingClientRect().left + list.clientLeft + parseFloat(indicator.left) + translation;
      const right = left + parseFloat(indicator.width);
      return {
        leftOffset: Math.abs(left - selected.left), rightOffset: Math.abs(right - selected.right),
        gap: hovered.getBoundingClientRect().left - right, hover: getComputedStyle(hovered).backgroundColor,
      };
    });
    assert.ok(geometry.leftOffset < 1 && geometry.rightOffset < 1 && geometry.gap >= 2.5 && geometry.gap <= 3.5, JSON.stringify(geometry));
    assert.notEqual(geometry.hover, 'rgba(0, 0, 0, 0)');
  }
  async function checkResourceToolbar(section, buttonCount, visibleLabels = buttonCount) {
    await tab(section);
    await toolbar.locator('.plugin-workspace-actions').waitFor();
    const layout = await toolbar.evaluate(node => {
      const tabs = node.querySelector('[role=tablist]').getBoundingClientRect();
      const buttons = [...node.querySelectorAll('.plugin-workspace-actions > button')];
      return {
        count: buttons.length,
        labels: buttons.filter(button => button.querySelector('span') && getComputedStyle(button.querySelector('span')).display !== 'none').length,
        fits: buttons.every(button => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= tabs.right && bounds.right <= node.getBoundingClientRect().right + 1
            && Math.abs((bounds.top + bounds.bottom) - (tabs.top + tabs.bottom)) <= 1;
        }),
        named: buttons.every(button => button.hasAttribute('aria-label') && button.title),
        separateRows: node.parentElement.querySelectorAll('[role=tabpanel] .plugin-workspace-actions').length,
      };
    });
    assert.deepEqual(layout, { count: buttonCount, labels: visibleLabels, fits: true, named: true, separateRows: 0 }, section);
  }
  async function choose(parent, label, value) {
    await click(parent, label);
    await page.getByRole('option', { name: value, exact: true }).click();
  }
  async function theme(name, value) {
    await click(nav, '通用');
    await click(content, name);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, value);
    await click(nav, '插件');
    await tab('插件');
    await catalog.waitFor();
  }
  async function pickLocal(entry, selection) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, selection);
    await click(toolbar, '本地安装');
    await page.getByRole('menuitem', { name: entry, exact: true }).click();
    await review.waitFor();
  }

  await settings();
  await theme('浅色', 'light');
  await detailButton(catalog, 'Excalidraw').waitFor();
  assert.equal((await snapshot()).length, 0);
  assert.equal(await content.getByRole('tablist').count(), 1, 'resource tabs are the only tab strip');
  assert.equal(await content.getByRole('button', { name: '浏览市场' }).count(), 0);
  await checkResourceToolbar('插件', 3, 2);
  await checkCards(2);
  await checkCatalogSpacing();
  await shot(workspacePage, 'catalog-single-light');
  await theme('深色', 'dark');
  await checkTabGap('MCP');
  await shot(tabs, 'resource-tabs-gap-dark');

  await pickLocal('选择插件包…', zip);
  await review.getByRole('heading', { name: originalName, exact: true }).waitFor();
  await click(review, '取消');
  await review.waitFor({ state: 'detached' });
  assert.equal((await snapshot()).length, 0, 'review and cancellation leave the package uninstalled');
  await pickLocal('选择插件目录…', example);
  await review.getByRole('heading', { name: '附带资源', exact: true }).waitFor();
  await click(review, '确认安装');
  const details = dialog('插件 ' + originalName);
  await details.waitFor();
  assert.equal((await snapshot())[0].version, '0.1.0');
  await click(details, '查看MCP 服务器');
  await content.getByRole('heading', { name: 'MCP 服务器', level: 1, exact: true }).waitFor();
  await content.getByRole('button', { name: '查看 MCP toolkit-demo 详情' }).waitFor();
  await tab('插件');
  const enable = catalog.getByRole('switch', { name: `启用插件 ${originalName}`, exact: true });
  await enable.click();
  await catalog.getByRole('switch', { name: `启用插件 ${originalName}`, checked: false }).waitFor();
  assert.equal((await snapshot())[0].enabled, false);
  await card(originalName).getByText('已安装', { exact: true }).waitFor();
  await enable.click();
  await catalog.getByRole('switch', { name: `启用插件 ${originalName}`, checked: true }).waitFor();
  await theme('深色', 'dark');
  await checkCards(2);
  await shot(workspacePage, 'installed-dark');

  await checkResourceToolbar('MCP', 2);
  await checkTabGap('技能');
  await assertSettingsRowLinkHover(page, content.getByRole('button', { name: '查看 MCP toolkit-demo 详情' }), '.mcp-server-row');
  await shot(workspacePage, 'mcp-toolbar-dark');
  await checkResourceToolbar('技能', 1);
  await assertSettingsRowLinkHover(page, content.getByRole('button', { name: '查看技能 toolkit-demo', exact: true }), '.installed-skill-row');
  await checkResourceToolbar('扩展', 3);
  for (const id of ['pi-quota-status', 'pi-project-scripts']) {
    const source = fileURLToPath(new URL(`../../extensions/${id}/`, import.meta.url));
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, source);
    await click(toolbar, '安装扩展');
    const installer = dialog('安装扩展');
    await click(installer, '选择扩展开发目录');
    await click(installer, '校验并预览');
    const preview = dialog('确认扩展安装');
    await preview.getByRole('checkbox').check();
    await preview.getByRole('button', { name: /^安装 v/ }).click();
    await preview.waitFor({ state: 'detached' });
  }
  await content.getByRole('button', { name: '打开 项目脚本速查 设置' }).waitFor();
  await shot(workspacePage, 'extension-library-grid-dark');
  await click(content, '打开 额度状态 设置');
  const quotaSettings = dialog('额度状态');
  await quotaSettings.getByRole('group', { name: '额度状态 显示位置' }).waitFor();
  await shot(quotaSettings.locator('.extension-detail-dialog'), 'quota-settings-dark');
  await click(quotaSettings, '完成');
  const builtinList = content.locator('.builtin-extension-section');
  if (await builtinList.getAttribute('open') === null) await builtinList.locator('summary').click();
  await builtinList.getByRole('button', { name: '打开 Studio 指标 设置', exact: true }).click();
  const extensionSettings = page.locator('.extension-detail-dialog');
  await extensionSettings.locator('.extension-appearance-trigger').first().click();
  await extensionSettings.locator('.extension-appearance-editor').waitFor();
  await extensionSettings.getByRole('button', { name: '完成', exact: true }).click();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 730, deviceScaleFactor: 1, mobile: false });
  await checkResourceToolbar('MCP', 2, 1);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 730, deviceScaleFactor: 1, mobile: false });
  await checkResourceToolbar('MCP', 2, 0);
  await checkTabGap('技能');
  await shot(workspacePage, 'mcp-toolbar-narrow-dark');
  await click(toolbar, '添加 MCP 服务器');
  const mcpEditor = dialog('添加 MCP 服务器');
  await click(mcpEditor, '取消');
  await mcpEditor.waitFor({ state: 'detached' });
  await checkResourceToolbar('技能', 1, 0);
  await checkResourceToolbar('扩展', 3, 0);
  await checkResourceToolbar('插件', 3, 0);
  await detailButton(catalog, originalName).waitFor();
  await checkCards(1);
  await checkCatalogSpacing();
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await tab('插件');

  await detailButton(catalog, 'Excalidraw').waitFor();
  await detailButton(catalog, originalName).waitFor();
  const search = catalog.getByRole('searchbox', { name: '搜索插件' });
  await search.fill('mermaid');
  await detailButton(catalog, 'Excalidraw').waitFor();
  await search.fill('无此插件');
  await catalog.getByText('没有匹配的插件。').waitFor();
  await search.clear();
  await click(toolbar, '管理插件源');
  await click(sources, '添加来源');
  const add = dialog('添加插件源');
  await click(add, '本地目录');
  await add.getByRole('textbox', { name: '显示名称' }).fill(sourceName);
  const location = add.getByRole('textbox', { name: '来源地址' });
  await location.fill(path.join(base, 'missing'));
  await click(add, '添加来源');
  await add.getByRole('alert').filter({ hasText: '插件目录不存在' }).waitFor();
  await location.fill(sourceDirectory);
  await click(add, '添加来源');
  await add.waitFor({ state: 'detached' });
  await sources.getByText(sourceName, { exact: true }).waitFor();
  await click(sources, '完成');
  await detailButton(catalog, updateName).waitFor();
  const expectedNames = [...officialRegistry.plugins.map(plugin => plugin.name), updateName, otherName];
  assert.deepEqual((await catalog.locator('.plugin-card-open').allTextContents()).sort(), expectedNames.sort());
  assert.equal(await detailButton(catalog, originalName).count(), 0, 'the installed copy and its listing share one card');
  await card(updateName).getByText('已安装', { exact: true }).waitFor();
  await card(updateName).getByRole('button', { name: '更换 ' + updateName + ' 的版本' }).waitFor();
  await shot(workspacePage, 'catalog-dark');
  await theme('浅色', 'light');
  await detailButton(catalog, updateName).waitFor();
  await shot(workspacePage, 'catalog-light');
  await theme('深色', 'dark');
  await click(toolbar, '管理插件源');
  await sources.getByText(sourceName, { exact: true }).waitFor();
  await shot(sources.locator('.detail-dialog'), 'sources-dark');
  await click(sources, '完成');
  await choose(catalog, '按来源筛选', sourceName);
  await choose(catalog, '按分类筛选', 'automation');
  await detailButton(catalog, otherName).waitFor();
  assert.equal(await detailButton(catalog, updateName).count(), 0);
  await click(catalog, `安装 ${otherName}`);
  await review.getByRole('heading', { name: '名称冲突' }).waitFor();
  assert.equal(await review.getByRole('button', { name: '确认安装' }).isDisabled(), true);
  await click(review, '取消');
  await review.waitFor({ state: 'detached' });
  await choose(catalog, '按分类筛选', '全部分类');
  await detailButton(catalog, updateName).waitFor();
  await checkCards(2);
  const link = detailButton(catalog, otherName);
  const otherCard = card(otherName);
  await page.mouse.move(0, 0);
  const baseBorder = await otherCard.evaluate(node => getComputedStyle(node).borderColor);
  const body = await otherCard.locator('.plugin-card-description').boundingBox();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
  assert.ok(await link.evaluate(node => node.matches(':hover')), 'clicking the card body targets its detail button');
  assert.notEqual(await otherCard.evaluate(node => getComputedStyle(node).borderColor), baseBorder);
  await checkCards(2);
  await link.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.ok(await link.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node, '::after').outlineStyle === 'solid'),
    'keyboard users get a focus outline around the card');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 730, deviceScaleFactor: 1, mobile: false });
  assert.ok(await content.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'catalog fits a narrow settings window');
  assert.ok(await catalog.locator('.plugin-catalog-filters').evaluate(node => {
    const search = node.querySelector('input').getBoundingClientRect();
    const [source, category] = [...node.querySelectorAll('.pi-select-trigger')].map(select => select.getBoundingClientRect());
    return search.bottom < source.top && source.top === category.top && Math.abs(source.width - category.width) < 1;
  }), 'filters share an evenly spaced row below search in narrow windows');
  await checkCards(1);
  await checkCatalogSpacing();
  await checkResourceToolbar('插件', 3, 1);
  await shot(workspacePage, 'catalog-narrow');
  await detailButton(catalog, updateName).click();
  const listing = dialog('插件 ' + updateName);
  await click(listing, '更换版本');
  await review.waitFor();
  await page.keyboard.press('Escape');
  await review.waitFor({ state: 'detached' });
  await listing.getByRole('button', { name: '更换版本', exact: true }).evaluate(element => new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      if (document.activeElement === element) resolve();
      else reject(new Error('Cancelling the review did not restore focus to the install action'));
    });
  }));
  await click(listing, '更换版本');
  await review.getByText('v0.1.0', { exact: true }).waitFor();
  await review.getByText('v0.2.0', { exact: true }).waitFor();
  await shot(review, 'update-review-dark');
  await click(review, '安装此版本');
  const updated = dialog('插件 ' + updateName);
  await review.waitFor({ state: 'detached' });
  await updated.getByRole('button', { name: '重新安装' }).waitFor();
  assert.equal((await snapshot())[0].version, '0.2.0');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await click(updated, '完成');
  await page.reload();
  await settings();
  await click(nav, '插件');
  await tab('插件');
  await detailButton(catalog, updateName).waitFor();
  await click(toolbar, '管理插件源');
  const sourceSwitch = sources.getByRole('switch', { name: `启用来源 ${sourceName}` });
  await sourceSwitch.click();
  await sources.getByRole('switch', { name: `启用来源 ${sourceName}`, checked: false }).waitFor();
  await click(sources, '完成');
  await card(updateName).getByText('本机', { exact: true }).waitFor();
  await card(updateName).getByText('已安装', { exact: true }).waitFor();
  await click(toolbar, '管理插件源');
  await sourceSwitch.click();
  await click(sources, '完成');
  await card(updateName).getByText(sourceName, { exact: true }).waitFor();
  await detailButton(catalog, updateName).click();
  await click(updated, '卸载插件');
  const confirm = page.getByRole('alertdialog', { name: `卸载插件「${updateName}」？` });
  await click(confirm, '卸载插件');
  await updated.waitFor({ state: 'detached' });
  await card(updateName).getByRole('button', { name: `安装 ${updateName}` }).waitFor();
  assert.equal(await card(updateName).getByText('已安装', { exact: true }).count(), 0);
  assert.equal((await snapshot()).length, 0);

  await click(toolbar, '管理插件源');
  await sourceSwitch.click();
  await sources.getByRole('switch', { name: `启用来源 ${sourceName}`, checked: false }).waitFor();
  await click(sources, `移除来源 ${sourceName}`);
  await click(page.getByRole('alertdialog', { name: `移除插件源「${sourceName}」？` }), '移除来源');
  await sources.getByText(sourceName, { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Verified same-row resource actions in wide and narrow layouts.');
  console.log('Verified a single card directory, responsive columns, local-only installs, installed badges, source controls, package previews, filtering, updates, persistence and uninstall.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(base, { recursive: true, force: true });
}
