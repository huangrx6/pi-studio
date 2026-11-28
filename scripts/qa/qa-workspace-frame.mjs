import { openSessionInspection } from './fixtures/open-session-inspection.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAtlasWorkspace } from './fixtures/atlas-workspace.mjs';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/workspace-titlebar/', import.meta.url));
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-workspace-frame-')));
const mainTree = path.join(scratch, 'Atlas Notes');
const feature = path.join(scratch, 'tag-search');
const profile = path.join(scratch, 'profile');
const title = '为笔记添加标签搜索';

async function dragSeparator(page, name, distance, fromTitlebar = false) {
  const separator = page.getByRole('separator', { name, exact: true });
  const bounds = await separator.boundingBox();
  const title = fromTitlebar && await page.locator('.content-region > .shell-header:visible').boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = title ? title.y + title.height / 2 : bounds.y + bounds.height / 2;
  assert.ok(await separator.evaluate((node, { x, y }) => document.elementFromPoint(x, y) === node, { x, y }),
    'Mouse input at the painted divider reaches the resize handle');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(18, 12);
}

async function verifySwitcherWidth(switcher) {
  const { width, available, buttons } = await switcher.evaluate(nav => {
    const row = nav.parentElement;
    const action = nav.nextElementSibling;
    const reserved = action ? action.getBoundingClientRect().width + parseFloat(getComputedStyle(row).columnGap) : 0;
    return {
      width: nav.getBoundingClientRect().width,
      available: row.clientWidth - reserved,
      buttons: [...nav.querySelectorAll('button')].map(button => button.getBoundingClientRect().width),
    };
  });
  assert.ok(Math.abs(width - available) <= 1, 'Switcher fills the space beside its toolbar action');
  assert.ok(Math.max(...buttons) - Math.min(...buttons) <= 1, 'Segments share the width equally');
}

async function verifyFrame(page, docked) {
  const data = await page.locator('.content-region .shell-canvas:visible').evaluate(node => {
    const side = node.closest('.content-region').querySelector('.file-panel');
    const geometry = element => {
      const r = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { x: r.left, y: r.top, right: r.right, bottom: r.bottom,
        corners: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius].map(parseFloat) };
    };
    const line = handle => {
      const css = getComputedStyle(handle, '::after'), r = handle.getBoundingClientRect();
      return { top: r.top + parseFloat(css.top), bottom: r.bottom - parseFloat(css.bottom), width: css.width, color: css.backgroundColor };
    };
    const preview = node.querySelector('.file-preview-pane');
    const inner = side?.querySelector('.file-panel-inner');
    return { canvas: geometry(node), preview: preview && geometry(preview), side: side && geometry(side), inner: inner && geometry(inner),
      divider: inner && getComputedStyle(inner).borderInlineStartWidth,
      leftLine: line(document.querySelector('.sidebar-resize-handle')),
      rightLine: side && line(side.querySelector('.panel-resize-handle')) };
  });
  const { canvas, side } = data;
  if (data.preview) {
    assert.equal(data.preview.x, canvas.x, 'The document preview reaches the left canvas edge');
    assert.equal(data.preview.right, canvas.right, 'The document preview reaches the right canvas edge');
  }
  if (!docked) {
    assert.ok(canvas.corners.every(radius => radius > 0), 'A closed sidebar restores all four canvas corners: ' + JSON.stringify(data));
    return;
  }
  assert.ok(Math.abs(canvas.right - side.x) <= 1, 'Canvas and inspector meet at one straight edge');
  assert.ok(Math.abs(canvas.y - side.y) <= 1 && Math.abs(canvas.bottom - side.bottom) <= 1, 'Shared top and bottom edges');
  assert.ok(canvas.corners[0] > 0 && canvas.corners[3] > 0 && side.corners[1] > 0 && side.corners[2] > 0,
    'All exterior corners are rounded: ' + JSON.stringify(data));
  assert.deepEqual([canvas.corners[1], canvas.corners[2], side.corners[0], side.corners[3]], [0, 0, 0, 0],
    'Both sides of the joint are square');
  assert.equal(data.divider, '1px', 'A full-height divider separates the docked panel from the canvas');
  assert.deepEqual([data.inner.y, data.inner.bottom], [canvas.y, canvas.bottom]);
  assert.equal(data.rightLine.width, '1px');
  assert.notEqual(data.rightLine.color, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(data.rightLine, data.leftLine, 'Both resize indicators have identical ends, width and color');
  assert.ok(data.rightLine.top > side.y && data.rightLine.bottom < side.bottom);
  assert.deepEqual(data.inner.corners, side.corners, 'Panel content is clipped to the same exterior corners');
}

async function verifyPanelToggles(page) {
  const geometry = await page.locator('.workspace-panel-toggle').evaluate(right => {
    const region = right.closest('.content-region');
    const left = region.closest('.app').classList.contains('is-sidebar-collapsed')
      ? region.querySelector('.sidebar-expand') : document.querySelector('.sidebar-top-toggle');
    const size = button => [button, button.querySelector('svg')].map(el => {
      const { width, height } = el.getBoundingClientRect();
      return [width, height];
    });
    const box = right.getBoundingClientRect();
    const dragOverlap = [...region.querySelectorAll(':scope > .shell-header, .workspace-side-modes')]
      .filter(el => getComputedStyle(el).getPropertyValue('app-region') === 'drag')
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
      }).map(el => el.className);
    const y = box.top + box.height / 2;
    const clickable = [box.left + 2, box.left + box.width / 2, box.right - 2]
      .every(x => right.contains(document.elementFromPoint(x, y)));
    return { left: size(left), right: size(right), dragOverlap, clickable };
  });
  assert.deepEqual(geometry.right, geometry.left, 'Both panel toggles share the same hit area and icon size: ' + JSON.stringify(geometry));
  assert.deepEqual(geometry.dragOverlap, [], 'Native window dragging must stop before the right toggle');
  assert.ok(geometry.clickable, 'Both edges and the center of the right toggle receive clicks');
}

async function verifyTitlebar(page) {
  await verifyPanelToggles(page);
  const nav = page.getByRole('navigation', { name: '工作区视图' });
  const data = await nav.evaluate(node => {
    const side = document.getElementById('workspace-side-panel');
    const region = side.closest('.content-region');
    const header = region.querySelector('.shell-header');
    const toggle = region.querySelector('.workspace-panel-toggle');
    const bounds = element => element.getBoundingClientRect().toJSON();
    const line = (element, pseudo) => {
      const css = getComputedStyle(element, pseudo);
      const top = css.top.endsWith('%') ? parseFloat(css.top) * element.clientHeight / 100 : parseFloat(css.top);
      return {
        y: element.getBoundingClientRect().top + element.clientTop + top + new DOMMatrixReadOnly(css.transform).m42,
        width: css.width, height: css.height, color: css.backgroundColor, content: css.content,
      };
    };
    const modeButtons = [...node.querySelectorAll('button')].map(button => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { bounds: bounds(button), clickable: button.contains(hit) };
    });
    const handle = side.querySelector('.panel-resize-handle');
    const navBounds = bounds(node);
    return {
      titleGrip: document.elementFromPoint(navBounds.left + 0.5, navBounds.top + navBounds.height / 2) === handle,
      dragRegion: getComputedStyle(handle).getPropertyValue('-webkit-app-region'),
      direct: node.parentElement === side,
      nav: bounds(node), side: bounds(side), header: bounds(header), toggle: bounds(toggle), modeButtons,
      leftLine: line(document.querySelector('.sidebar-top-toggle'), '::after'),
      rightLine: line(node, '::before'),
    };
  });
  const aligned = (a, b) => Math.abs(a - b) <= 1;
  assert.ok(data.direct, 'Workspace view navigation belongs directly to the sidebar');
  assert.ok(data.titleGrip, 'The visible right titlebar separator is draggable');
  assert.equal(data.dragRegion, 'no-drag', 'Resizing takes priority over dragging the native window');
  assert.ok(aligned(data.nav.top, data.header.top) && aligned(data.nav.bottom, data.side.top),
    'File and Git navigation align with the window titlebar');
  assert.ok(aligned(data.nav.left, data.side.left) && data.nav.right <= data.toggle.left,
    'The draggable panel title ends before the toggle');
  for (const { bounds, clickable } of data.modeButtons) {
    assert.ok(bounds.left >= data.side.left && bounds.right <= data.toggle.left,
      'Workspace buttons stay clear of the window sidebar toggle');
    assert.ok(aligned(bounds.top + bounds.height / 2, data.toggle.top + data.toggle.height / 2),
      'Workspace buttons align vertically with the titlebar toggle');
    assert.ok(clickable, 'Workspace navigation receives pointer input above the canvas and drawer scrim');
  }
  assert.notEqual(data.leftLine.content, 'none');
  assert.equal(data.leftLine.width, '1px');
  assert.ok(parseFloat(data.leftLine.height) > 0 && parseFloat(data.leftLine.height) < data.nav.height);
  assert.deepEqual(data.rightLine, data.leftLine, 'Both titlebar separators have the same position, size and color');
}

async function screenshot(app, page, file) {
  await page.mouse.move(18, 12);
  await page.evaluate(() => document.fonts.ready);
  const target = path.join(output, file);
  if (process.platform === 'darwin') {
    const id = await app.evaluate(({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).getMediaSourceId().split(':')[1], page.url());
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', id, target], { stdio:'pipe' });
      const png = await readFile(target);
      const expected = await page.evaluate(() => [innerWidth, innerHeight].map(n => Math.round(n * devicePixelRatio)));
      if (png.readUInt32BE(16) === expected[0] && png.readUInt32BE(20) === expected[1]) return 'native window';
    } catch { /* A background Space may withhold WindowServer capture. The main renderer contains the entire workbench. */ }
  }
  await page.screenshot({ path: target, animations:'disabled' });
  return 'Electron main renderer';
}

let app;
try {
  await Promise.all([prepareAtlasWorkspace(mainTree, feature), mkdir(profile), mkdir(output, { recursive:true })]);
  const { app: desktop, page } = await launchTestDesktop(mainTree, profile, 1440, 920);
  app = desktop;
  const button = name => page.getByRole('button', {name, exact:true});
  const tab = name => page.getByRole('tab', {name, exact:true});
  const sidebar = page.getByRole('complementary', {name:'工作区侧栏'});
  await page.emulateMedia({ reducedMotion:'reduce' });
  await configureTestModel(page, mainTree, 'http://127.0.0.1:9');
  const id = await page.evaluate(async ({mainTree, feature, title}) => {
    localStorage.setItem('pi-studio:preferences', JSON.stringify({theme:'dark'}));
    await window.piApi.createConversation({cwd:mainTree, title:'整理 Markdown 导出格式'});
    return (await window.piApi.createConversation({cwd:feature, title})).id;
  }, {mainTree, feature, title});
  await page.reload();
  await selectTestSession(page, feature, id);
  const opener = button('打开右侧面板'), closer = button('收起右侧面板');
  await opener.waitFor();
  assert.equal(await opener.getAttribute('aria-expanded'), 'false');
  assert.equal(await opener.getAttribute('aria-controls'), null);
  const closedButton = await opener.boundingBox();
  const viewport = await page.evaluate(() => innerWidth);
  assert.ok(viewport - closedButton.x - closedButton.width < 56 && closedButton.y < 40, 'Right sidebar has an upper-right titlebar control');
  assert.equal(await page.evaluate(() => window.piApi.toolWindowVisible()), false);
  await verifyFrame(page, false);
  await verifyPanelToggles(page);
  await button('收起侧边栏').click();
  await button('展开侧边栏').waitFor();
  await verifyPanelToggles(page);
  await button('展开侧边栏').click();
  await opener.click();
  await sidebar.waitFor();
  assert.equal(await sidebar.getAttribute('id'), 'workspace-side-panel');
  assert.equal(await closer.getAttribute('aria-expanded'), 'true');
  assert.equal(await closer.getAttribute('aria-controls'), 'workspace-side-panel');
  assert.deepEqual(await closer.boundingBox(), closedButton, 'Toggle stays in its original titlebar position');
  await verifyFrame(page, true);
  await verifyTitlebar(page);
  await closer.press('Space');
  await sidebar.waitFor({ state: 'detached' });
  await opener.press('Enter');
  await sidebar.waitFor();
  const file = name => sidebar.locator('button.file-row').filter({ has: page.getByText(name, {exact:true}) });
  const folderIcon = file('src').locator('[data-file-icon]');
  const closedIcon = await folderIcon.getAttribute('data-file-icon');
  assert.equal((await folderIcon.boundingBox()).width, 17);
  assert.equal((await file('src').locator('.explorer-disclosure svg').boundingBox()).width, 13);
  await file('src').click();
  assert.notEqual(await folderIcon.getAttribute('data-file-icon'), closedIcon);
  await file('search.mjs').waitFor();
  await sidebar.getByRole('tree').press('ArrowRight');
  assert.equal(await file('search.mjs').getAttribute('data-focused'), 'true');
  assert.notEqual(await file('README.md').locator('img').getAttribute('src'), await file('search.mjs').locator('img').getAttribute('src'));
  // Hold the first editor import so the actual pane can be inspected while it waits.
  const releaseEditor = await app.evaluateHandle(({ session }) => {
    const { promise, resolve } = Promise.withResolvers();
    const requests = session.defaultSession.webRequest;
    requests.onBeforeRequest({ urls: ['file://*/*/SourceEditor-*.js'] }, (_request, allow) => {
      void promise.then(() => allow({}));
    });
    return () => { requests.onBeforeRequest(null); resolve(); };
  });
  try {
    await file('search.mjs').dblclick();
    const status = page.locator('.file-preview-body').getByRole('status').filter({ hasText: '正在加载源码编辑器' });
    await status.locator('.loading-pi').waitFor();
    assert.ok(await status.evaluate(node => {
      const pane = node.closest('.file-preview-body').getBoundingClientRect();
      const mark = node.querySelector('.loading-pi').getBoundingClientRect();
      const label = node.querySelector('.loading-state-label').getBoundingClientRect();
      return Math.abs(mark.left + mark.right - pane.left - pane.right) <= 2 &&
        Math.abs(mark.top + label.bottom - pane.top - pane.bottom) <= 2;
    }), 'The Pi mark and loading label are centered together in the file body');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(output, 'file-loading.png'), scale: 'css', animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  } finally {
    await releaseEditor.evaluate(release => release());
    await releaseEditor.dispose();
  }
  await page.locator('.session-document .monaco-editor .view-line').first().waitFor();
  await file('README.md').dblclick();
  await page.getByRole('heading', {name:'Atlas Notes', exact:true}).waitFor();
  await verifyFrame(page, true);
  console.log('Expanded README:', await screenshot(app,page,'expanded.png'));
  const fileModes = sidebar.getByRole('navigation', {name:'文件搜索范围'});
  async function verifyContentSearchRow() {
    const [tabs, field, filter] = await Promise.all([
      fileModes.boundingBox(), sidebar.locator('.explorer-search').boundingBox(),
      sidebar.getByRole('button', {name:'筛选文件范围'}).boundingBox(),
    ]);
    assert.ok(field.y >= tabs.y + tabs.height && filter.x >= field.x + field.width);
    assert.deepEqual([field.y, field.height, filter.width], [filter.y, filter.height, filter.height]);
    assert.ok(Math.abs(tabs.x + tabs.width - filter.x - filter.width) <= 1);
  }
  const fileModesBox = await fileModes.boundingBox();
  await verifySwitcherWidth(fileModes);
  await fileModes.getByRole('button', {name:'内容', exact:true}).click();
  await verifySwitcherWidth(fileModes);
  await verifyContentSearchRow();
  const query = sidebar.getByRole('searchbox');
  await query.fill('normalizetag');
  const matches = sidebar.locator('.explorer-match-group');
  await matches.nth(1).waitFor();
  assert.equal(await sidebar.locator('.explorer-hit mark').count(), 3);
  await matches.first().getByRole('button', {expanded:true}).click();
  assert.equal(await matches.first().locator('.explorer-hit').count(), 0);
  await matches.first().getByRole('button', {expanded:false}).click();
  await sidebar.getByRole('button', {name:'区分大小写'}).click();
  await sidebar.getByText('没有匹配结果').waitFor();
  await query.fill('normalizeTag');
  await matches.nth(1).waitFor();
  console.log('Content search:', await screenshot(app, page, 'content-search.png'));
  await sidebar.getByRole('button', {name:'筛选文件范围'}).click();
  await sidebar.getByLabel('包含文件', {exact:true}).fill('tests/**');
  await matches.getByText('search.test.mjs', {exact:true}).waitFor();
  assert.equal(await matches.count(), 1);
  await sidebar.locator('.explorer-hit[title$=":3"]').click();
  await page.getByRole('tab', {name:'search.test.mjs', exact:true}).waitFor();
  await page.locator('.session-document .monaco-editor .active-line-number').filter({hasText:/^3$/}).waitFor();
  await sidebar.getByRole('button', {name:'正则表达式'}).click();
  await query.fill('[');
  await sidebar.getByRole('alert').waitFor();
  await query.fill('');
  await fileModes.getByRole('button', {name:'名称', exact:true}).click();
  await file('README.md').dblclick();
  await sidebar.getByRole('button', {name:'Git', exact:true}).click();
  await sidebar.getByRole('region', {name:'Git 工作台'}).waitFor();
  const gitModes = sidebar.getByRole('navigation', {name:'Git 视图'});
  const gitModesBox = await gitModes.boundingBox();
  await verifySwitcherWidth(gitModes);
  const refresh = sidebar.getByRole('button', {name:'刷新 Git'}), refreshBox = await refresh.boundingBox();
  assert.ok(Math.abs(gitModesBox.x - fileModesBox.x) < 1 && Math.abs(gitModesBox.y - fileModesBox.y) < 1);
  assert.ok(Math.abs(gitModesBox.y + gitModesBox.height/2 - refreshBox.y - refreshBox.height/2) < 1);
  assert.ok(refreshBox.x >= gitModesBox.x + gitModesBox.width);
  assert.equal(await sidebar.getByRole('heading', {name:'版本控制'}).count(), 0);
  await refresh.click();
  const fills = await page.evaluate(() => {
    function visibleFill(selector) {
      for (let node = document.querySelector(selector); node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') return color;
      }
      throw new Error(`No surface for ${selector}`);
    }
    return {
      sidebar: visibleFill('.shell-sidebar'), gitTabs: visibleFill('nav[aria-label="Git 视图"]'),
      editor: visibleFill('.session-document .file-preview-markdown'), toolbar: visibleFill('.session-document .file-preview-toolbar'),
      git: visibleFill('.git-workspace-page'),
    };
  });
  assert.equal(fills.editor, fills.git, 'The Markdown document and Git workspace share a canvas');
  assert.equal(fills.toolbar, fills.git);
  assert.equal(fills.gitTabs, fills.sidebar, 'Grouped controls share the sidebar fill');
  assert.notEqual(fills.sidebar, fills.git);
  console.log('Git titlebar:', await screenshot(app,page,'git.png'));
  await openSessionInspection(page);
  await tab('进展').waitFor();
  await sidebar.getByRole('region', {name:'Git 工作台'}).waitFor();
  assert.equal(await sidebar.locator('.inspection-card').count(), 0);
  await verifyTitlebar(page);
  assert.deepEqual(await closer.boundingBox(), closedButton);
  await closer.click();
  await sidebar.waitFor({state:'detached'});
  await opener.click();
  await tab('进展').waitFor();
  await button('关闭会话详情').click();
  await tab('README.md').click();
  await sidebar.getByRole('region', {name:'Git 工作台'}).waitFor();
  await closer.click();
  await sidebar.waitFor({state:'detached'});
  await page.reload();
  await page.getByRole('heading', {name:'Atlas Notes', exact:true}).waitFor();
  await opener.waitFor();
  assert.equal(await sidebar.count(), 0, 'Reload preserves the collapsed sidebar');
  await opener.click();
  await sidebar.getByRole('region', {name:'Git 工作台'}).waitFor();
  await sidebar.getByRole('button', {name:'文件',exact:true}).click();
  await file('README.md').waitFor();
  const before = (await sidebar.boundingBox()).width;
  const winBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getBounds() ?? BrowserWindow.getAllWindows()[0].getBounds());
  const beforeDrag = await winBounds();
  await dragSeparator(page, '调整右侧面板宽度', -54, true);
  assert.equal((await sidebar.boundingBox()).width, before + 54, 'Dragging the right titlebar line widens the sidebar');
  assert.deepEqual(await winBounds(), beforeDrag, 'Dragging the titlebar line leaves the native window in place');
  await dragSeparator(page, '调整右侧面板宽度', 54);
  assert.equal((await sidebar.boundingBox()).width, before, 'Dragging the body line narrows the sidebar');
  await verifyFrame(page, true);
  await verifyTitlebar(page);
  assert.deepEqual(await closer.boundingBox(), closedButton, 'Resizing leaves the titlebar toggle fixed');
  await closer.click();
  await sidebar.waitFor({state:'detached'});
  assert.deepEqual(await opener.boundingBox(), closedButton);
  await verifyFrame(page, false);
  console.log('Collapsed README:', await screenshot(app,page,'collapsed.png'));
  await tab(title).click();
  await verifyFrame(page, false);
  await dragSeparator(page, '调整侧边栏宽度', 90, true);
  const host = await app.browserWindow(page);
  try { await host.evaluate(win => win.setContentSize(980, 720)); } finally { await host.dispose(); }
  await page.waitForFunction(() => innerWidth === 980);
  const narrowButton = await opener.boundingBox();
  await opener.click();
  await page.locator('.file-panel.is-overlay').waitFor();
  await verifyTitlebar(page);
  const drawerWidth = (await sidebar.boundingBox()).width;
  await dragSeparator(page, '调整右侧面板宽度', -24, true);
  assert.equal((await sidebar.boundingBox()).width, drawerWidth + 24, 'The drawer resizes from its titlebar line');
  await sidebar.getByRole('button', {name:'Git', exact:true}).click();
  await sidebar.getByRole('region', {name:'Git 工作台'}).waitFor();
  await sidebar.getByRole('button', {name:'文件', exact:true}).click();
  await file('README.md').waitFor();
  assert.deepEqual(await closer.boundingBox(), narrowButton, 'Narrow drawer uses the same upper-right control');
  console.log('Narrow sidebar:', await screenshot(app,page,'narrow.png'));
  await verifySwitcherWidth(fileModes);
  await fileModes.getByRole('button', {name:'内容', exact:true}).click();
  await verifyContentSearchRow();
  await fileModes.getByRole('button', {name:'名称', exact:true}).click();
  await closer.click();
  await sidebar.waitFor({state:'detached'});
  await verifyFrame(page, false);
  await Promise.all(Array.from({ length: 180 }, (_, index) =>
    writeFile(path.join(feature, 'virtual-' + String(index).padStart(3, '0') + '.txt'), '')));
  await opener.click();
  const tree = sidebar.getByRole('tree', {name:'工作区文件'});
  await file('README.md').waitFor();
  await tree.press('End');
  await sidebar.getByRole('treeitem', {name:'virtual-179.txt', exact:true}).waitFor();
  assert.equal(await file('virtual-179.txt').getAttribute('data-focused'), 'true');
  assert.ok(await tree.getByRole('treeitem').count() < 64, 'Only the visible rows and overscan are mounted');
  await tree.press('Home');
  await file('notes').waitFor();
  console.log('Verified titlebar geometry, matching separators, fixed toggle, file/Git navigation, inspector, resize, narrow drawer and saved state.');
} finally {
  await app?.close();
  await rm(scratch,{recursive:true,force:true});
}
