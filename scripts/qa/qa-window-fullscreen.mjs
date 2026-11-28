/**
 * Native fullscreen chrome regression check.
 *
 * Native fullscreen hides the macOS window buttons, so the shell must stop
 * reserving their gutter. The sidebar, conversation, and workspace controls
 * share the top row above the document and workspace content.
 *
 * Run after `pnpm run build`: node scripts/qa/qa-window-fullscreen.mjs
 * Uses only a fresh temporary Studio profile and writes screenshots to
 * .qa/window-fullscreen/, which stays ignored by Git.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
import { openToolPanel, hideToolPanel } from './fixtures/tool-panel.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'window-fullscreen');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-fullscreen-qa-'));
const workspace = path.join(profile, 'project');
await Promise.all([mkdir(workspace), mkdir(output, { recursive: true })]);
const env = {
  ...process.env,
  PI_WORKSPACE: workspace,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

/** Measure the shared top rows, their dividers and the native chrome flag. */
const topRows = (page) => page.evaluate(() => {
  const read = (selector) => {
    const node = document.querySelector(selector);
    if (!node?.checkVisibility()) return null;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      height: Math.round(box.height),
      left: Math.round(box.left),
      right: Math.round(box.right),
      paddingTop: style.paddingTop,
      paddingLeft: style.paddingLeft,
      borderBottomWidth: style.borderBottomWidth,
    };
  };
  function divider(selector, pseudo) {
    const style = getComputedStyle(document.querySelector(selector), pseudo);
    return { width: style.width, height: style.height, color: style.backgroundColor, content: style.content };
  }
  const leftToggle = document.querySelector('.app').classList.contains('is-sidebar-collapsed')
    ? '.shell-header .sidebar-expand' : '.sidebar-top-toggle';
  return {
    fullscreen: document.documentElement.dataset.windowFullscreen,
    headerHeight: parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--header-height')),
    sidebar: read('.sidebar'),
    brand: read('.brand'),
    header: read('.chat-header'),
    tabs: read('.session-content-tabs'),
    canvas: read('.main.shell-canvas'),
    panelBody: read('#workspace-side-panel .panel-body'),
    panelModes: read('#workspace-side-panel .workspace-side-modes'),
    toggle: read('.content-region > .workspace-panel-toggle'),
    leftDivider: divider(leftToggle, '::after'),
    rightDivider: document.querySelector('.workspace-side-modes') ? divider('.workspace-side-modes', '::before') : null,
  };
});

/** The fullscreen layout is driven by one data attribute on the document root. */
const setFullscreenAttribute = (page, fullscreen) => page.evaluate((value) => {
  document.documentElement.dataset.windowFullscreen = value;
}, fullscreen ? 'true' : 'false');

const waitForChrome = (page, fullscreen) => page.waitForFunction(
  (expected) => document.documentElement.dataset.windowFullscreen === expected,
  fullscreen ? 'true' : 'false',
);

const setNativeFullScreen = (app, fullscreen) => app.evaluate(({ BrowserWindow }, value) => {
  BrowserWindow.getAllWindows()[0].setFullScreen(value);
}, fullscreen);

/** The left title and center header share a row. File and Git controls are inside the right column. */
function assertSingleTitleRow(rows, label, { brandPadding = process.platform === 'win32' ? '12px' : '92px' } = {}) {
  assert.equal(rows.sidebar.paddingTop, '0px', `${label}: the title row owns the top edge`);
  assert.equal(rows.brand.top, 0, `${label}: the brand sits inside the title row`);
  assert.equal(rows.brand.height, rows.headerHeight, `${label}: the brand matches the shared title height`);
  assert.equal(rows.brand.paddingLeft, brandPadding, `${label}: the brand clears the window controls`);
  assert.equal(rows.header.bottom, rows.brand.bottom, `${label}: the conversation title stays inside the shared row`);
  assert.ok(Math.abs(rows.panelModes.top - rows.header.top) <= 1, `${label}: workspace controls begin in the shared title row`);
  assert.ok(Math.abs(rows.panelModes.bottom - rows.header.bottom) <= 1, `${label}: both title rows end together`);
  assert.ok(rows.panelBody.top >= rows.panelModes.bottom - 1, `${label}: workspace content begins below its controls`);
  assert.equal(rows.rightDivider.width, '1px');
  assert.equal(rows.rightDivider.height, '18px');
  assert.notEqual(rows.rightDivider.content, 'none');
  assert.deepEqual(rows.rightDivider, rows.leftDivider, `${label}: the title separators have the same dimensions and color`);
  assert.ok(rows.panelModes.left >= rows.canvas.right - 1, `${label}: workspace controls are separate from the center canvas`);
  assert.equal(rows.header.borderBottomWidth, '0px', `${label}: the conversation title meets the canvas without a border`);
  assert.equal(rows.panelModes.borderBottomWidth, '0px', `${label}: the workbench title meets the canvas without a border`);
  assert.ok(rows.tabs.top >= rows.header.top && rows.tabs.bottom <= rows.header.bottom,
    `${label}: the session tabs stay within the shared title row`);
}

let app;
try {
  app = await _electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.locator('.app').waitFor();
  await configureTestModel(page, workspace, 'http://127.0.0.1:9');
  const session = await page.evaluate(cwd => window.piApi.createConversation({ cwd, title: '窗口标题栏验收' }), workspace);
  await page.reload();
  await selectTestSession(page, workspace, session.id);
  await waitForChrome(page, false);

  const openWorkbench = page.getByRole('button', { name: '打开右侧面板', exact: true });
  await openWorkbench.waitFor();
  const closedToggle = (await topRows(page)).toggle;
  await openWorkbench.click();
  await page.locator('.file-panel.is-open .workspace-side-modes').waitFor();

  const windowed = await topRows(page);
  assertSingleTitleRow(windowed, 'windowed');
  assert.deepEqual(windowed.toggle, closedToggle, 'the right toggle stays in place when the sidebar opens');
  await page.screenshot({ path: path.join(output, '01-windowed.png') });

  const divider = await page.getByRole('separator', { name: '调整右侧面板宽度' }).boundingBox();
  const x = divider.x + divider.width / 2;
  const y = divider.y + divider.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y, { steps: 4 });
  await page.mouse.up();
  const resized = await topRows(page);
  assert.ok(resized.panelModes.left > windowed.panelModes.left, 'dragging moves the workbench divider');
  assertSingleTitleRow(resized, 'resized workbench');
  assert.deepEqual(resized.toggle, closedToggle, 'resizing the workspace column keeps the toggle fixed');
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click();
  await page.locator('.file-panel').waitFor({ state: 'detached' });
  await openWorkbench.click();
  await page.locator('.file-panel.is-open .workspace-side-modes').waitFor();

  // Layout contract: the attribute alone switches every shared row.
  await setFullscreenAttribute(page, true);
  const attributeRows = await topRows(page);
  assertSingleTitleRow(attributeRows, 'fullscreen', { brandPadding: '12px' });
  await page.screenshot({ path: path.join(output, '02-fullscreen.png') });

  // With the sidebar collapsed there are no window buttons to steer around either.
  await page.locator('.sidebar-top-toggle').click();
  await page.waitForFunction(() => document.querySelector('.app').classList.contains('is-sidebar-collapsed'));
  const collapsed = await topRows(page);
  assert.deepEqual(collapsed.rightDivider, collapsed.leftDivider, 'the collapsed left sidebar uses the same title separator');
  assert.equal(collapsed.header.paddingLeft, '24px', 'collapsed sidebar keeps the normal title row padding');
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width <= 1);
  await page.screenshot({ path: path.join(output, '03-collapsed.png') });
  await page.locator('.sidebar-expand').click();
  await page.waitForFunction(() => !document.querySelector('.app').classList.contains('is-sidebar-collapsed'));

  // Settings has its own header while the right panel is open.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const settings = page.getByRole('region', { name: '设置', exact: true });
  const settingsNav = page.getByRole('navigation', { name: '设置导航' });
  await settings.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.ok(await settingsNav.isVisible());
  assert.ok(await page.getByRole('separator', { name: '调整侧边栏宽度' }).isVisible());
  const title = await settings.locator('.settings-header').boundingBox();
  const canvas = await settings.locator('.settings-content').boundingBox();
  assert.equal(title.y + title.height, canvas.y);
  await settings.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'
    && !document.querySelector('.settings-toast-stack .settings-toast'));
  await page.screenshot({ path: path.join(output, '04-settings-fullscreen.png') });
  const footer = page.getByRole('contentinfo', { name: '状态栏' });
  const toolView = await openToolPanel(app, page, () => footer.getByRole('button', { name: '打开工具面板' }).click());
  await hideToolPanel(page, toolView);
  assert.ok(await settings.getByRole('heading', { name: '通用', exact: true }).isVisible());
  await page.locator('[data-sidebar-section="conversations"]').click();

  await setFullscreenAttribute(page, false);
  assertSingleTitleRow(await topRows(page), 'attribute reset');

  // Native wiring: the main process must report the transition the CSS reacts to.
  await setNativeFullScreen(app, true);
  let native = false;
  for (let attempt = 0; attempt < 24 && !native; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  }
  if (native) {
    await waitForChrome(page, true);
    assertSingleTitleRow(await topRows(page), 'native fullscreen', { brandPadding: '12px' });
    await setNativeFullScreen(app, false);
    await waitForChrome(page, false);
    assertSingleTitleRow(await topRows(page), 'native fullscreen exit');
  } else {
    await setNativeFullScreen(app, false);
    console.log('note: the OS did not grant a fullscreen space, so the native transition check was skipped');
  }

  assert.deepEqual(pageErrors, []);
  console.log('window fullscreen chrome ok');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
