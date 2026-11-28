/** Exercise the official notes package on a disposable PARA vault. */
import { checkPluginTheme, openPluginCatalog, openPluginTool } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/notes-library/', import.meta.url));
const icon = await readFile(new URL('../../assets/official-plugins/packages/notes-library/assets/icon.png', import.meta.url));
const iconUrl = 'data:image/png;base64,' + icon.toString('base64');
const { themes } = JSON.parse(await readFile(new URL('../../assets/official-plugins/packages/notes-library/extension/appearance.json', import.meta.url), 'utf8'));
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-notes-qa-')));
const profile = path.join(scratch, 'profile');
const vault = path.join(scratch, 'notes');
const work = path.join(scratch, 'workspace');
const trash = path.join(scratch, 'trash');
const resources = path.join(vault, '03 Resources');
const documentPath = path.join(resources, '01 推理入门.md');
const htmlPath = path.join(resources, '02 阅读示例.html');
const createdPath = path.join(resources, '验证记录.md');
const longSections = [
  '01 算法与数据结构的学习路线和练习资料',
  '02 从问题抽象到复杂度估算的基础方法',
  '03 递归展开与主定理的证明和几何解释',
  '04 递推方程里的边界条件和常见误区',
  '05 实际性能测量与理论分析的对照实验',
  '06 算法优化案例和不同输入规模下的观察记录',
];
const longName = '复杂度实验复盘';
const longDirectory = path.join(resources, ...longSections);

const markdown = [
  '---', 'title: 推理入门', 'tags: [学习, AI]', '---', '',
  '# 推理入门', '', '理解模型如何一步步生成答案，以及哪些结果值得记录和复用。', '',
  '## 先看结构', '', '> [!TIP]', '> 先用一个可重复的例子确定观察点，再对照实际输出。', '',
  '| 观察点 | 要记下的证据 |', '| --- | --- |', '| 输入 | 模型与提示的版本 |', '| 输出 | 可复现的验收样例 |', '',
  '## 一个简单的例子', '', '单步概率可以写成 $P(x \\mid y)$。', '',
  '~~~mermaid', 'graph LR', 'A[输入] --> B[推理]', 'B --> C[输出]', '~~~', '',
  '继续阅读 [[02 阅读示例|排版示例]]。', '',
].join('\n');
const html = [
  '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="../90 Assets/reading.css"></head>',
  '<body><main><h1>把复杂内容讲清楚</h1><p>这是一个带有本地样式的 HTML 阅读稿。</p>',
  '<img src="../90 Assets/mark.svg" alt="库内插图">',
  '<img src="https://notes-preview.invalid/forbidden.png" alt="外部图片" hidden>',
  '<script>document.querySelector("h1").textContent = "脚本执行了";</script></main></body></html>',
].join('\n');

await Promise.all([output, profile, work, trash, longDirectory, ...['01 Projects', '90 Assets']
  .map(folder => path.join(vault, folder))].map(folder => mkdir(folder, { recursive: true })));
await Promise.all([
  writeFile(documentPath, markdown),
  writeFile(htmlPath, html),
  writeFile(path.join(longDirectory, longName + '.md'), '# ' + longName + '\n\n记录实验中的输入规模和耗时。\n'),
  writeFile(path.join(vault, '01 Projects', '实现进展.md'), '# 实现进展\n\n[[01 推理入门]]\n'),
  writeFile(path.join(vault, '90 Assets', 'reading.css'),
    'body{background:#f5efe4;color:#3f372f}main{max-width:680px;margin:55px auto}h1{color:rgb(52, 88, 115);font-size:38px}img{width:110px}'),
  writeFile(path.join(vault, '90 Assets', 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 44"><rect width="110" height="44" rx="9" fill="#a6bdce"/></svg>'),
]);

let app;
let page;
let mainPage;
const errors = [];
const blockedRequests = [];
const ui = () => page.frameLocator('iframe.extension-view-frame[title="知识库"]');
const tool = (label, options = {}) => ui().getByRole('button', { name: label, exact: true, ...options });
const tree = () => ui().getByRole('navigation', { name: 'PARA 目录', exact: true });
const workspace = () => ui().locator('.knowledge-app');
const background = locator => locator.evaluate(element => getComputedStyle(element).backgroundColor);
const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(channel => parseInt(channel, 16)).join(', ') + ')';
const rowAppearance = locator => locator.evaluate(async row => {
  await Promise.allSettled(row.getAnimations().map(animation => animation.finished));
  const style = getComputedStyle(row);
  return { height: row.offsetHeight, font: style.fontSize, radius: style.borderRadius, background: style.backgroundColor };
});

async function verifyTheme(name) {
  const theme = themes.find(preset => preset.title === name);
  await tool('知识库主题').click();
  await tool(name).click();
  assert.equal(await workspace().getAttribute('data-knowledge-theme'), theme.id);
  for (const selector of ['.notes-sidebar', '.notes-toolbar', '.notes-outline']) {
    assert.equal(await background(ui().locator(selector)), rgb(theme.surface), selector);
  }
  assert.equal(await background(ui().locator('.notes-document')), rgb(theme.bg));
  return theme;
}

async function openNotes() {
  const toolWindow = await openPluginTool(app, mainPage, '知识库');
  if (page !== toolWindow.page) {
    page = toolWindow.page;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('notes-preview.invalid')) blockedRequests.push(request.url());
    });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ui().locator('body').waitFor();
}

async function openResource(name) {
  const heading = tree().getByRole('button', { name: '03 Resources', exact: true });
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
  await tree().getByRole('button', { name, exact: true }).click();
}

try {
  ({ app, page } = await launchTestDesktop(work, profile, 1500, 930));
  mainPage = page;
  await app.evaluate(({ dialog, shell }, { vault, trash }) => {
    const nativePick = dialog.showOpenDialog;
    dialog.showOpenDialog = (...args) => args.at(-1)?.title === '选择笔记目录'
      ? Promise.resolve({ canceled: false, filePaths: [vault] }) : nativePick(...args);
    const paths = process.getBuiltinModule('node:path');
    shell.trashItem = file => process.getBuiltinModule('node:fs/promises').rename(file, paths.join(trash, paths.basename(file)));
  }, { vault, trash });
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.piApi.waitForStartup());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPluginCatalog(page);
  const notesCard = page.locator('.plugin-package-card').filter({
    has: page.getByRole('button', { name: '查看插件 知识库', exact: true }),
  });
  assert.equal(await notesCard.locator('img.studio-package-mark').getAttribute('src'), iconUrl);
  await page.getByRole('button', { name: '安装 知识库', exact: true }).click();
  const install = page.getByRole('dialog', { name: '安装预览', exact: true });
  await install.getByRole('button', { name: '确认安装', exact: true }).click();
  await install.waitFor({ state: 'detached' });

  await page.reload();
  await page.locator('.app').waitFor();
  await openNotes();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await page.locator('.tool-tab[data-active=true] button').first().innerText(), '知识库');
  await tool('选择目录').click();
  await tree().getByRole('button', { name: '03 Resources', exact: true }).waitFor();
  assert.equal((await ui().locator('.sidebar-title').textContent()).trim(), '知识库');
  assert.equal(await ui().locator('.sidebar-mark').evaluate(img => img.complete && img.naturalWidth === 128), true);
  const start = ui().locator('.library-start');
  await start.getByRole('heading', { name: '选择一篇笔记开始阅读' }).waitFor();
  assert.equal(await start.getByRole('button').count(), 0);
  await page.screenshot({ path: path.join(output, 'empty-library.png'), scale: 'css' });
  await tool('知识库设置').click();
  await tool('补齐 PARA 目录和规范').click();
  await tree().getByRole('button', { name: '99 System', exact: true }).waitFor();
  assert.match(await readFile(path.join(vault, '99 System', 'notes-spec.md'), 'utf8'), /知识库规范/);

  await openResource('01 推理入门');
  await ui().getByRole('heading', { name: '推理入门', exact: true }).waitFor();
  assert.equal(await workspace().getAttribute('data-knowledge-theme'), 'studio');
  await checkPluginTheme(page, ui(), [
    ['.notes-document', '--surface-canvas'], ['.notes-sidebar', '--surface-chrome'],
    ['.notes-toolbar', '--surface-chrome'], ['.notes-search', '--surface-raised'],
  ], output);
  assert.equal(await ui().locator('.katex').count(), 1);
  await ui().getByRole('img', { name: 'Mermaid 图表', exact: true }).waitFor();
  await tool('大纲与反向链接').click();
  await ui().getByRole('navigation', { name: '反向链接', exact: true }).getByRole('button', { name: '实现进展' }).waitFor();
  const headingRow = ui().getByRole('navigation', { name: '大纲', exact: true }).getByRole('button', { name: '推理入门', exact: true });
  await headingRow.click();
  assert.equal(await headingRow.getAttribute('aria-current'), 'location');
  const currentRow = await rowAppearance(ui().locator('.tree-row[data-current]'));
  assert.equal(currentRow.height, 34);
  assert.deepEqual(await rowAppearance(headingRow), currentRow);
  assert.equal((await ui().locator('.modes').textContent()).trim(), '');
  assert.equal(await tool('管理当前文件').count(), 0);
  await tool('阅读').hover();
  const viewHandle = await page.locator('iframe.extension-view-frame[title="知识库"]').elementHandle();
  const frame = await viewHandle.contentFrame();
  await frame.waitForFunction(() => {
    const button = document.querySelector('.modes [aria-label="阅读"]');
    return button && getComputedStyle(button, '::after').visibility === 'visible';
  });
  assert.equal(await tool('阅读').evaluate(button => getComputedStyle(button, '::after').content), '"阅读"');
  await page.mouse.move(0, 0);
  const signal = ui().locator('.save-status');
  await signal.locator('.save-dot').waitFor();
  assert.equal(await signal.getAttribute('data-state'), 'saved');
  const savedColor = await background(signal.locator('.save-dot'));

  const resize = ui().getByRole('separator', { name: '调整大纲宽度' });
  const handle = await resize.boundingBox();
  assert.ok(handle);
  const x = handle.x + handle.width / 2;
  const y = handle.y + 95;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 68, y, { steps: 6 });
  await page.mouse.up();
  assert.equal(await resize.getAttribute('aria-valuenow'), '284');
  assert.equal(Math.round((await ui().locator('.notes-outline').boundingBox()).width), 284);
  await resize.press('Home');
  assert.equal(await resize.getAttribute('aria-valuenow'), '180');
  await resize.press('End');
  assert.equal(await resize.getAttribute('aria-valuenow'), await resize.getAttribute('aria-valuemax'));
  await resize.press('Home');
  await resize.press('ArrowLeft');
  assert.equal(await resize.getAttribute('aria-valuenow'), '196');
  await page.mouse.move(0, 0);
  await frame.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: path.join(output, 'markdown.png'), scale: 'css' });

  await tool('知识库主题').click();
  const themeMenu = ui().getByRole('group', { name: '选择知识库主题', exact: true });
  assert.deepEqual(await themeMenu.getByRole('button').allTextContents(), ['跟随 Studio', '蓝墨', '暖炭', '亚麻', '灰绿']);
  await page.screenshot({ path: path.join(output, 'theme-menu.png'), scale: 'css' });
  const studio = tool('跟随 Studio');
  const studioBackground = await background(studio.locator('.theme-swatch'));
  await studio.click();
  assert.equal(await workspace().getAttribute('data-knowledge-theme'), 'studio');
  assert.equal(await background(ui().locator('.notes-document')), studioBackground);
  await verifyTheme('暖炭');
  await page.screenshot({ path: path.join(output, 'knowledge-graphite.png'), scale: 'css' });
  const sage = await verifyTheme('灰绿');
  await tool('知识库设置').click();
  const settings = ui().getByRole('dialog', { name: '知识库设置' });
  assert.equal(await background(settings), rgb(sage.floating));
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'knowledge-light.png'), scale: 'css' });

  const paper = await verifyTheme('亚麻');
  await tool('分屏').click();
  const editor = ui().getByRole('textbox', { name: '笔记源码', exact: true });
  assert.equal(await background(ui().locator('.note-editor')), rgb(paper.bg));
  await editor.fill(markdown + '\n## 本地草稿\n');
  assert.equal(await signal.getAttribute('data-state'), 'dirty');
  assert.notEqual(await background(signal.locator('.save-dot')), savedColor);
  await writeFile(documentPath, markdown + '\n## 编辑器外的更新\n');
  await ui().getByText('磁盘上的版本已修改，草稿已保留。', { exact: true }).waitFor();
  await tool('查看差异').click();
  await ui().getByRole('dialog', { name: '查看差异' }).getByText('磁盘版本', { exact: true }).waitFor();
  await ui().getByRole('dialog', { name: '查看差异' }).getByRole('button', { name: '关闭', exact: true }).click();
  await tool('保留我的').click();
  await ui().locator('.save-status[data-state="saved"]').waitFor();
  assert.match(await readFile(documentPath, 'utf8'), /本地草稿/);
  await page.screenshot({ path: path.join(output, 'split-paper.png'), scale: 'css' });

  await tool('阅读').click();
  await ui().getByRole('link', { name: '排版示例', exact: true }).click();
  const preview = ui().frameLocator('iframe[title="HTML 阅读预览"]');
  const headline = preview.getByRole('heading', { name: '把复杂内容讲清楚', exact: true });
  await headline.waitFor();
  assert.equal(await headline.evaluate(node => getComputedStyle(node).color), 'rgb(52, 88, 115)');
  const image = preview.getByRole('img', { name: '库内插图', exact: true });
  assert.equal(await image.evaluate(node => node.complete && node.naturalWidth > 0), true);
  assert.equal(await preview.getByText('脚本执行了', { exact: true }).count(), 0);
  assert.deepEqual(blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'html.png'), scale: 'css' });

  const search = ui().getByRole('textbox', { name: '搜索标题和正文', exact: true });
  const searchResults = ui().getByRole('navigation', { name: '搜索结果', exact: true });
  await search.fill('可复现的验收样例');
  await searchResults.getByRole('button', { name: /01 推理入门/ }).waitFor();
  await search.fill(longName);
  await searchResults.getByRole('button', { name: new RegExp(longName) }).click();
  await tool('清除搜索').click();
  const crumbs = ui().getByRole('navigation', { name: '当前文件路径' });
  await crumbs.getByText(longName, { exact: true }).waitFor();
  await ui().locator('.breadcrumb-track[data-compact="true"]').waitFor();
  assert.equal(await crumbs.getByText(longSections[0], { exact: true }).isVisible(), false);
  const revealPath = crumbs.locator('summary[aria-label="查看完整路径"]');
  await revealPath.click();
  const fullPath = crumbs.getByRole('list', { name: '完整路径' });
  assert.deepEqual(await fullPath.getByRole('listitem').allTextContents(), ['03 Resources', ...longSections, longName + '.md']);
  assert.ok((await crumbs.boundingBox()).x + (await crumbs.boundingBox()).width <= (await ui().locator('.toolbar-actions').boundingBox()).x);
  await page.screenshot({ path: path.join(output, 'breadcrumb.png'), scale: 'css' });
  await revealPath.press('Escape');
  await fullPath.waitFor({ state: 'hidden' });

  await tool('在 03 Resources 新建').click();
  const create = ui().getByRole('dialog', { name: '新建', exact: true });
  await create.getByRole('textbox', { name: '标题', exact: true }).fill('验证记录');
  await create.getByRole('button', { name: '创建', exact: true }).click();
  await editor.waitFor();
  assert.match(await readFile(createdPath, 'utf8'), /title: "验证记录"/);
  await tree().getByRole('button', { name: '验证记录', exact: true }).click({ button: 'right' });
  await tool('重命名').click();
  const rename = ui().getByRole('dialog', { name: '重命名', exact: true });
  await rename.getByRole('textbox', { name: '名称', exact: true }).fill('验收记录.md');
  await rename.getByRole('button', { name: '保存名称', exact: true }).click();
  await crumbs.getByText('验收记录', { exact: true }).waitFor();
  await tree().getByRole('button', { name: '验收记录', exact: true }).press('Shift+F10');
  await tool('移到废纸篓').click();
  await ui().getByRole('dialog', { name: '移到废纸篓', exact: true }).getByRole('button', { name: '移到废纸篓', exact: true }).click();
  await ui().getByRole('dialog', { name: '移到废纸篓', exact: true }).waitFor({ state: 'detached' });
  assert.match(await readFile(path.join(trash, '验收记录.md'), 'utf8'), /# 验证记录/);
  await assert.rejects(stat(createdPath), /ENOENT/);

  await openResource('01 推理入门');
  await tool('源码').click();
  await editor.fill(markdown + '\n## 重开后恢复的草稿\n');
  await ui().getByRole('navigation', { name: 'PARA 目录' }).click({ position: { x: 10, y: 2 } });
  await page.reload();
  await openNotes();
  await openResource('01 推理入门');
  assert.equal(await workspace().getAttribute('data-knowledge-theme'), 'paper');
  await tool('大纲与反向链接').click();
  assert.equal(await resize.getAttribute('aria-valuenow'), '196');
  await tool('源码').click();
  assert.match(await editor.inputValue(), /重开后恢复的草稿/);
  assert.doesNotMatch(await readFile(documentPath, 'utf8'), /重开后恢复的草稿/);

  assert.deepEqual(errors, []);
  console.log('Knowledge Library official install, Markdown/HTML, themes, compact path, outline resizing, conflict, CRUD and draft recovery passed.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
