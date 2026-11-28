/** Exercise the floating tools view in an isolated Git project and capture the complete workbench. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';
import { getToolPanel } from './fixtures/tool-panel.mjs';
import { prepareAtlasWorkspace } from './fixtures/atlas-workspace.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.qa', 'floating-tool-panel');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-floating-tools-')));
const mainTree = path.join(directory, 'Atlas Notes');
const tagTree = path.join(directory, 'tag-search');
const profile = path.join(directory, 'profile');

async function checkWelcomePosition(app, main) {
  const welcome = main.locator('.new-conversation-welcome');
  await welcome.waitFor();
  await main.locator('#launch-screen').waitFor({ state: 'hidden' });
  await main.evaluate(async () => {
    document.documentElement.dataset.theme = 'dark';
    await document.fonts.ready;
    await Promise.all(document.querySelector('.new-conversation-welcome h1').getAnimations().map(animation => animation.finished));
  });
  const samples = await main.evaluateHandle(() => {
    const welcome = document.querySelector('.new-conversation-welcome');
    const composer = document.querySelector('.composer-wrap');
    const samples = [];
    const record = () => samples.push([welcome.querySelector('h1').getBoundingClientRect().y, composer.getBoundingClientRect().y]);
    const observer = new MutationObserver(record);
    observer.observe(welcome, { childList: true, subtree: true });
    let frame;
    function tick() { record(); frame = requestAnimationFrame(tick); }
    tick();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); record(); return samples; };
  });
  const launcher = main.locator('.tools-window-entry');
  const openHint = main.getByRole('tooltip').filter({ hasText: /^打开工具面板$/ });
  await launcher.hover();
  await openHint.waitFor();
  const button = await launcher.boundingBox();
  const hint = await openHint.boundingBox();
  const viewport = await main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const rightOffset = hint.x + hint.width - (button.x + button.width);
  assert.ok(hint.y + hint.height <= button.y && hint.x >= 0 && Math.abs(rightOffset) <= 1,
    'The open hint aligns with the right edge of the launcher above the status bar');
  await main.screenshot({ path: path.join(output, 'launcher-hint.png'), animations: 'disabled', clip: {
    x: viewport.width - 270, y: viewport.height - 76, width: 270, height: 76,
  } });
  await launcher.click();
  const panel = await getToolPanel(app, main);
  await panel.getByRole('button', { name: '收起工具面板', exact: true }).click();
  await main.getByRole('button', { name: '打开工具面板', exact: true }).waitFor();
  await main.mouse.move(12, 12);
  await openHint.waitFor({ state: 'hidden' });
  await main.locator('.runtime-status-trigger').focus();
  await main.keyboard.press('Tab');
  await openHint.waitFor();
  await main.keyboard.press('Escape');
  await openHint.waitFor({ state: 'hidden' });
  assert.ok(await launcher.evaluate(node => node === document.activeElement), 'Escape keeps focus on the launcher');
  await main.keyboard.press('Enter');
  const closeButton = main.getByRole('button', { name: '收起工具面板', exact: true });
  await closeButton.hover();
  const closeHint = main.getByRole('tooltip').filter({ hasText: /^收起工具面板$/ });
  await closeHint.waitFor();
  const closeBox = await closeHint.boundingBox();
  const footer = await main.locator('.studio-statusbar').boundingBox();
  assert.ok(closeBox.x + closeBox.width <= button.x && closeBox.y >= footer.y,
    'The close hint stays in the status bar next to the native tools view');
  await closeButton.click();
  await main.getByRole('button', { name: '打开工具面板', exact: true }).waitFor();
  // The window manager may keep another window active during QA. Exercise the
  // same focus refresh that runs when a user returns from the tool renderer.
  await main.evaluate(async () => {
    window.dispatchEvent(new FocusEvent('focus'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const positions = await samples.evaluate(finish => finish());
  await samples.dispose();
  for (const [index, label] of ['greeting', 'composer'].entries()) {
    const values = positions.map(position => position[index]);
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(spread <= 1, `Toggling tools moved the ${label} by ${spread}px`);
    console.log(`Welcome ${label} displacement: ${spread}px`);
  }
}

function panelGeometry(app, main) {
  return app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
    const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url);
    const panel = host.contentView.children.find(child => child instanceof WebContentsView
      && child.webContents.getURL().split('?')[0].endsWith('/tools.html'));
    return { view: panel.getBounds(), sourceId: host.getMediaSourceId() };
  }, main.url());
}

async function verifyGeometry(app, main, panel) {
  const native = await panelGeometry(app, main);
  const rect = selector => main.locator(selector).boundingBox();
  const [region, right, rightHeader, header, tabs, bar, services, button, window] = await Promise.all([
    rect('.app > .content-region'), rect('#workspace-side-panel'), rect('#workspace-side-panel .workspace-side-modes'),
    rect('.chat-header'), rect('.session-content-tabs'), rect('.studio-statusbar'), rect('.runtime-status-trigger'),
    rect('.studio-statusbar .tools-window-entry'),
    main.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  const { view } = native;
  assert.ok(Math.abs((view.x + view.width / 2) - (region.x + region.width / 2)) <= 2,
    'The floating panel is horizontally centered across the editor and the docked workspace panel');
  const surface = await panel.locator('.tool-window').boundingBox();
  assert.ok(surface.width / surface.height >= 1.55, 'The picker keeps its landscape proportions');
  const panelRight = view.x + surface.x + surface.width;
  assert.ok(view.x > region.x && panelRight > right.x && panelRight < right.x + right.width,
    'The default panel overlaps the file pane while the left navigation stays accessible');
  assert.ok(Math.abs(rightHeader.y - header.y) <= 1 && Math.abs(rightHeader.height - header.height) <= 1,
    'The workspace navigation and the document tabs share the title row');
  assert.ok(view.y > tabs.y + tabs.height && view.y > rightHeader.y + rightHeader.height &&
    view.y + view.height < region.y + region.height,
    'The session tabs and a portion of the document remain visible');
  assert.ok(button.x >= services.x + services.width && window.width - button.x - button.width <= 16,
    'The launcher sits to the right of the services button at the window edge');
  assert.ok(button.y >= bar.y && button.y + button.height <= bar.y + bar.height,
    'The launcher fits inside the bottom status bar');
  return { ...native, window };
}

async function verifyResizeAndTabs(app, main, panel) {
  const bounds = async () => (await panelGeometry(app, main)).view;
  async function waitForBounds(expected) {
    const deadline = Date.now() + 3000;
    let actual = await bounds();
    while (Object.keys(expected).some(key => actual[key] !== expected[key]) && Date.now() < deadline) {
      await delay(16);
      actual = await bounds();
    }
    assert.deepEqual(actual, expected);
  }
  async function drag(handle, dx, dy, expected) {
    const before = await bounds();
    const grip = panel.locator(`[data-tool-drag="${handle}"]:visible`);
    const { x, y, width, height } = await grip.boundingBox();
    const startX = x + width / 2, startY = y + height / 2;
    await panel.mouse.move(startX, startY);
    await panel.mouse.down();
    await panel.locator('.tool-window-frame[data-dragging]').waitFor();
    await panel.mouse.move(startX + dx, startY + dy);
    await waitForBounds(expected);
    // Playwright addresses the child viewport. After moving its origin, release
    // at the same physical screen position as the previous pointer event.
    if (before.x !== expected.x || before.y !== expected.y) {
      await panel.mouse.move(startX + dx + before.x - expected.x, startY + dy + before.y - expected.y);
    }
    await panel.mouse.up();
    await waitForBounds(expected);
  }
  const original = await bounds();
  const dock = main.locator('#workspace-side-panel');
  await main.getByRole('button', { name: '收起右侧面板', exact: true }).click();
  await dock.waitFor({ state: 'hidden' });
  await waitForBounds(original);
  await main.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  const divider = dock.getByRole('separator', { name: '调整右侧面板宽度' });
  const dockWidth = (await dock.boundingBox()).width;
  await divider.press('ArrowLeft');
  await main.waitForFunction(width => document.getElementById('workspace-side-panel').offsetWidth > width, dockWidth);
  await waitForBounds(original);
  await divider.press('ArrowRight');
  await main.getByRole('button', { name: '在右侧打开', exact: true }).click();
  await main.locator('.session-side-group').waitFor();
  await waitForBounds(original);

  const region = await main.locator('.app > .content-region').boundingBox();
  const full = {
    x: Math.round(region.x), y: Math.round(region.y),
    width: Math.round(region.width), height: Math.round(region.height),
  };
  const smaller = { ...original, width: original.width - 92, height: original.height - 61 };
  await drag('se', -92, -61, smaller);
  const inset = { x: smaller.x + 27, y: smaller.y + 19, width: smaller.width - 27, height: smaller.height - 19 };
  await drag('nw', 27, 19, inset);
  const custom = { ...inset, x: full.x + full.width - inset.width, y: inset.y + 24 };
  await drag('move', custom.x - inset.x, 24, custom);
  await panel.getByRole('button', { name: '放大工具面板' }).click();
  await waitForBounds(full);
  await panel.getByRole('button', { name: '还原面板大小' }).click();
  assert.deepEqual(await bounds(), custom, 'Restore returns to the manual size and position');
  await panel.getByRole('button', { name: '收起工具面板', exact: true }).click();
  await main.getByRole('button', { name: '打开工具面板', exact: true }).click();
  await getToolPanel(app, main);
  assert.deepEqual(await bounds(), custom, 'Reopening retains the chosen size');
  await panel.getByRole('button', { name: '放大工具面板' }).click();
  await panel.getByRole('button', { name: '还原面板大小' }).waitFor();
  await waitForBounds(full);
  await drag('e', -77, 0, { ...full, width: full.width - 77 });
  await panel.getByRole('button', { name: '放大工具面板' }).waitFor();

  const group = panel.locator('.tool-group:visible');
  const add = group.getByRole('button', { name: '新建工具标签页', exact: true });
  const menu = panel.getByRole('menu', { name: '新建工具标签页', exact: true });
  const start = group.getByRole('region', { name: '工具起始页' });
  await add.click();
  await menu.waitFor();
  assert.ok(await start.isVisible(), 'An empty panel can open the menu over its start page');
  await panel.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await start.getByRole('button', { name: '新浏览器标签页', exact: true }).click();
  const browserTab = group.locator('.tool-tab:has(.lucide-globe) > button:first-child');
  await browserTab.waitFor();
  const guest = group.locator('webview');
  await guest.waitFor();
  await panel.waitForFunction(() => {
    try { return document.querySelector('webview').getWebContentsId() > 0; } catch { return false; }
  });
  const guestId = await guest.evaluate(view => view.getWebContentsId());
  await add.press('ArrowDown');
  await menu.getByRole('menuitem', { name: 'Excalidraw', exact: true }).waitFor();
  assert.equal(await browserTab.getAttribute('aria-current'), 'page');
  assert.ok(await guest.isVisible() && !await start.isVisible(), 'Adding leaves the current page on screen');
  const anchor = await add.boundingBox(), overlay = await menu.boundingBox();
  assert.ok(overlay.y >= anchor.y + anchor.height && overlay.y <= anchor.y + anchor.height + 8);
  await panel.keyboard.press('End');
  assert.equal(await panel.evaluate(() => document.activeElement.textContent), '打开起始页');
  await panel.keyboard.press('Enter');
  await start.waitFor();
  assert.equal(await group.locator('.tool-tab').count(), 1);
  await panel.keyboard.press('Escape');
  await guest.waitFor();
  assert.equal(await guest.evaluate(view => view.getWebContentsId()), guestId);

  await add.click();
  const stage = await guest.boundingBox();
  await panel.mouse.click(stage.x + stage.width - 12, stage.y + stage.height - 12);
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await browserTab.getAttribute('aria-current'), 'page');
  await panel.emulateMedia({ reducedMotion: 'no-preference' });
  await add.click();
  const trace = await group.evaluateHandle(group => {
    let sawStartPage = false;
    let displacement = 0;
    const entries = [];
    const firstTab = group.querySelector('.tool-tab');
    const before = firstTab.getBoundingClientRect();
    const record = () => {
      sawStartPage ||= Boolean(group.querySelector('.tool-picker'));
      const rect = firstTab.getBoundingClientRect();
      displacement = Math.max(displacement, Math.abs(rect.x - before.x), Math.abs(rect.y - before.y), Math.abs(rect.width - before.width));
    };
    let frame;
    const sample = () => { record(); frame = requestAnimationFrame(sample); };
    sample();
    const animation = event => entries.push(event.animationName);
    const observer = new MutationObserver(record);
    observer.observe(group, { childList: true, subtree: true });
    group.addEventListener('animationstart', animation);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      group.removeEventListener('animationstart', animation);
      return { sawStartPage, displacement, entries };
    };
  });
  const initialTab = await browserTab.boundingBox();
  await menu.getByRole('menuitem', { name: '新终端', exact: true }).click();
  const terminalTab = group.locator('.tool-tab:has(.lucide-square-terminal) > button:first-child');
  await terminalTab.waitFor();
  await group.locator('.terminal-panel').waitFor();
  await panel.waitForFunction(() => !document.querySelector('.tool-tab-slot.is-entering'));
  const motion = await trace.evaluate(finish => finish());
  await trace.dispose();
  assert.equal(motion.sawStartPage, false);
  assert.ok(motion.displacement < 1, `Existing tab shifted by ${motion.displacement}px during insertion`);
  assert.ok(motion.entries.includes('tool-tab-enter'), 'The new tab expands into place');
  assert.deepEqual(await browserTab.boundingBox(), initialTab, 'The existing tab stays in place');
  for (const theme of ['light', 'dark']) {
    await panel.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await panel.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    for (const tab of [browserTab, terminalTab]) {
      await tab.click();
      await tab.and(group.locator('[aria-current=page]')).waitFor();
      const styles = await group.locator('.tool-tab').evaluateAll(tabs => tabs.map(node => {
        const css = getComputedStyle(node);
        return { fill: css.backgroundColor, radius: parseFloat(css.borderRadius), underline: parseFloat(css.borderBottomWidth) };
      }));
      assert.notEqual(styles[0].fill, styles[1].fill);
      assert.ok(styles.every(style => style.radius > 0 && style.underline === 0));
    }
    await group.locator('.tool-tabs').screenshot({ path: path.join(output, 'tabs-' + theme + '.png') });
    await add.click();
    const area = await menu.boundingBox(), header = await group.locator('.tool-tabs').boundingBox();
    await panel.screenshot({ path: path.join(output, 'add-menu-' + theme + '.png'), clip: {
      x: header.x, y: header.y, width: Math.ceil(area.x + area.width - header.x + 12), height: Math.ceil(area.y + area.height - header.y + 12),
    } });
    await panel.keyboard.press('Escape');
  }
  await add.click();
  await menu.getByRole('menuitem', { name: '任务看板', exact: true }).click();
  const board = group.getByRole('button', { name: '任务看板', exact: true });
  await board.and(group.locator('[aria-current=page]')).waitFor();
  await add.click();
  await menu.getByRole('menuitem', { name: '打开起始页' }).click();
  await start.getByRole('button', { name: '任务看板', exact: true }).click();
  await board.and(group.locator('[aria-current=page]')).waitFor();
  assert.equal(await group.locator('.tool-tab').count(), 3, 'The start page reuses an open extension tab');
  const wide = await bounds();
  await drag('e', 390 - wide.width, 0, { ...wide, width: 390 });
  await add.click();
  const compactMenu = await menu.boundingBox();
  assert.ok(compactMenu.x >= 0 && compactMenu.x + compactMenu.width <= 390, 'The menu fits a narrow panel');
  await menu.getByRole('menuitem', { name: '新终端', exact: true }).click();
  await panel.waitForFunction(() => {
    const list = document.querySelector('.tool-group:not([hidden]) .tool-tab-list');
    const tab = list.querySelector('.tool-tab-slot:last-child [aria-current=page]');
    return list.children.length === 4 && list.scrollLeft > 0 && tab && tab.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1;
  });
  assert.equal(await group.locator('.tool-tab-slot.is-entering').count(), 0, 'Reduced motion reveals the tab immediately');
  await verifyTabManagement(panel, guestId);
}

async function verifyTabManagement(panel, originalGuestId) {
  const group = panel.locator('.tool-group:visible');
  const list = group.locator('.tool-tab-list');
  const tabs = list.locator('.tool-tab > button:first-child');
  const left = group.getByRole('button', { name: '向左滚动标签页' });
  const right = group.getByRole('button', { name: '向右滚动标签页' });
  const actions = panel.getByRole('menu', { name: '标签页操作' });
  const addBrowser = async () => {
    await group.getByRole('button', { name: '新建工具标签页' }).click();
    await panel.getByRole('menuitem', { name: '新浏览器标签页' }).click();
  };
  const state = () => panel.evaluate(async () => {
    const { key, groups } = await window.toolWindowApi.state();
    return groups.find(group => group.context.key === key);
  });
  for (let i = 0; i < 3; i++) await addBrowser();
  await tabs.nth(6).waitFor();
  const initial = await state();
  const ids = initial.tabs.map(tab => tab.id);
  assert.equal(initial.active, ids.at(-1));
  await right.and(group.locator(':disabled')).waitFor();

  await list.hover();
  await panel.mouse.wheel(0, -2000);
  await left.and(group.locator(':disabled')).waitFor();
  assert.ok(await list.evaluate(list => list.firstElementChild.getBoundingClientRect().left >= list.getBoundingClientRect().left));
  await right.click();
  await left.and(group.locator(':enabled')).waitFor();
  await left.click();
  await left.and(group.locator(':disabled')).waitFor();
  await list.hover();
  await panel.mouse.wheel(2000, 0);
  await right.and(group.locator(':disabled')).waitFor();
  assert.equal((await state()).active, initial.active, 'Browsing hidden tabs keeps the selected tool active');

  await tabs.nth(1).click({ button: 'middle' });
  await tabs.nth(6).waitFor({ state: 'detached' });
  // A queued "close others" must not clear the group if the tab to keep has since closed.
  await panel.evaluate(({ key, ids }) => window.toolWindowApi.command(key, { kind: 'close-tabs', ids, keepId: ids[1] }),
    { key: initial.context.key, ids });
  assert.deepEqual((await state()).tabs.map(tab => tab.id), ids.filter(id => id !== ids[1]));
  assert.equal((await state()).active, initial.active);
  await tabs.nth(1).click({ button: 'right' }); // The background task board now follows the first browser.
  await actions.waitFor();
  assert.equal((await state()).active, initial.active);
  const header = await group.locator('.tool-tabs').boundingBox(), overlay = await actions.boundingBox();
  await panel.screenshot({ path: path.join(output, 'tab-actions.png'), animations: 'disabled',
    clip: { ...header, height: Math.ceil(overlay.y + overlay.height + 10 - header.y) } });
  await actions.getByRole('menuitem', { name: '关闭右侧标签页' }).click();
  await tabs.nth(2).waitFor({ state: 'detached' });
  assert.deepEqual((await state()).tabs.map(tab => tab.id), [ids[0], ids[2]]);
  assert.equal((await state()).active, ids[2]);
  await left.waitFor({ state: 'detached' });

  await tabs.first().press('Shift+F10');
  await actions.getByRole('menuitem', { name: '关闭其他标签页' }).click();
  await tabs.nth(1).waitFor({ state: 'detached' });
  assert.equal((await state()).active, ids[0]);
  assert.equal(await group.locator('webview:visible').evaluate(view => view.getWebContentsId()), originalGuestId);
  await addBrowser();
  await group.getByRole('button', { name: '标签页操作' }).press('ArrowDown');
  assert.ok(await actions.getByRole('menuitem', { name: '关闭右侧标签页' }).isDisabled());
  await actions.getByRole('menuitem', { name: '关闭全部标签页' }).click();
  await group.getByRole('region', { name: '工具起始页' }).waitFor();
  assert.equal(await tabs.count(), 0);
  const db = new DatabaseSync(path.join(profile, 'studio.sqlite'), { readOnly: true });
  try {
    const { layout } = db.prepare("SELECT layout FROM session_layouts WHERE owner = ? AND surface = 'tools'").get(initial.context.key);
    assert.deepEqual(JSON.parse(layout), { tabs: [], active: '' });
  } finally { db.close(); }
}

// WebContents screenshots omit sibling native child views. Prefer a single capture of this exact OS window.
async function screenshot(main, panel, geometry, target) {
  const id = /^window:(\d+):/.exec(geometry.sourceId)?.[1];
  if (process.platform === 'darwin' && id) {
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', id, target], { stdio: 'pipe' });
      return 'native window capture';
    } catch (error) {
      console.warn('Window capture unavailable:', error.stderr?.toString().trim() || error.message);
    }
  }
  const [background, foreground] = await Promise.all([
    main.screenshot({ animations: 'disabled' }), panel.screenshot({ animations: 'disabled', omitBackground: true }),
  ]);
  const png = await main.evaluate(async ({ background, foreground, view, cssWidth }) => {
    const bitmap = async base64 => createImageBitmap(new Blob([Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))], { type:'image/png' }));
    const [host, tool] = await Promise.all([bitmap(background), bitmap(foreground)]);
    const canvas = document.createElement('canvas');
    canvas.width = host.width;
    canvas.height = host.height;
    const ctx = canvas.getContext('2d');
    const scale = host.width / cssWidth;
    ctx.drawImage(host, 0, 0);
    ctx.drawImage(tool, view.x * scale, view.y * scale, view.width * scale, view.height * scale);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { background: background.toString('base64'), foreground: foreground.toString('base64'),
    view: geometry.view, cssWidth: geometry.window.width });
  await writeFile(target, Buffer.from(png, 'base64'));
  return 'composite of the two actual renderers at native view bounds';
}

let app;
async function checkFloatingToolPanel() {
  await Promise.all([prepareAtlasWorkspace(mainTree, tagTree), mkdir(profile), mkdir(output, { recursive: true })]);
  const desktop = await launchTestDesktop(mainTree, profile, 1440, 920);
  app = desktop.app;
  const main = desktop.page;
  const dimensions = await app.evaluate(({ BrowserWindow, screen }, url) => {
    const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url);
    const area = screen.getDisplayMatching(host.getBounds()).workAreaSize;
    host.setContentSize(1874, 1056);
    const [width, height] = host.getContentSize();
    if (width < 1874 || height < 1056) host.setContentSize(Math.min(area.width, 1874), Math.min(area.height, 1056));
    host.center();
    return { requestedViewport: [1874, 1056], available: area, actual: host.getContentSize() };
  }, main.url());
  console.log('Logical window size:', dimensions);
  await checkWelcomePosition(app, main);
  if (process.argv.includes('--launcher-only')) return;
  await configureTestModel(main, mainTree, 'http://127.0.0.1:9');
  const id = await main.evaluate(async ({ mainTree, tagTree, packages }) => {
    localStorage.setItem('pi-studio:preferences', JSON.stringify({theme:'system'}));
    const api = window.piApi;
    for (const source of packages) {
      const preview = await api.preparePluginInstall({ source });
      await api.installPlugin({ cwd: tagTree, token: preview.token });
    }
    await api.createConversation({ cwd: mainTree, title: '整理 Markdown 导出格式' });
    await api.createConversation({ cwd: tagTree, title: '核对标签搜索测试' });
    return (await api.createConversation({cwd: tagTree, title: '为笔记添加标签搜索'})).id;
  }, { mainTree, tagTree, packages: ['excalidraw','notes-library','task-board'].map(name => path.join(root, 'assets/official-plugins/packages', name)) });
  await main.reload();
  await selectTestSession(main, tagTree, id);
  const toggle = main.locator('.content-region > .workspace-panel-toggle');
  const closedToggleBounds = await toggle.boundingBox();
  await main.getByRole('button', {name:'打开右侧面板', exact:true}).click();
  const file = name => main.locator('button.file-row').filter({ has: main.getByText(name, {exact:true}) });
  for (const dir of ['src', 'tests', 'notes']) await file(dir).click();
  await file('search.mjs').dblclick();
  await main.getByRole('tab', {name:'search.mjs', exact:true}).waitFor();
  await file('README.md').dblclick();
  await main.getByRole('heading', {name:'Atlas Notes', exact:true}).waitFor();
  const launcher = main.locator('.tools-window-entry');
  await launcher.click();
  const panel = await getToolPanel(app, main);
  const picker = panel.locator('.tool-group:visible .tool-picker');
  for (const name of ['新终端','新浏览器标签页','知识库','任务看板','Excalidraw']) {
    await picker.getByRole('button', {name, exact:true}).waitFor();
  }
  await main.mouse.move(16, 14);
  for (const theme of ['dark', 'light']) {
    for (const page of [main, panel]) {
      await page.emulateMedia({colorScheme:theme, reducedMotion:'reduce'});
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await page.evaluate(() => document.fonts.ready);
    }
    const focus = await app.evaluate(({ BrowserWindow }, url) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url);
      host.focus();
      return { visible: host.isVisible(), focusable: host.isFocusable(), focused: host.isFocused() };
    }, main.url());
    assert.ok(focus.visible && focus.focusable, 'The native workbench is visible and accepts focus');
    assert.equal(await main.getByRole('tab', {name:'README.md', exact:true}).getAttribute('aria-selected'), 'true');
    if (!focus.focused) console.log('The window manager kept another window in front; capturing only the QA host.');
    assert.deepEqual(await toggle.boundingBox(), closedToggleBounds, 'The workspace toggle keeps its position while the tool picker is visible');
    const geometry = await verifyGeometry(app, main, panel);
    const method = await screenshot(main, panel, geometry, path.join(output, theme + '.png'));
    console.log(theme, method, geometry.view);
  }
  await launcher.click();
  await main.waitForFunction(async () => !await window.piApi.toolWindowVisible());
  await launcher.click();
  await getToolPanel(app, main);
  await picker.getByRole('button',{name:'新终端',exact:true}).waitFor();
  await verifyResizeAndTabs(app, main, panel);
  console.log('Verified native panel geometry, horizontal scrolling, tab selection and persisted bulk closures in the desktop app.');
}

try {
  await checkFloatingToolPanel();
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
