/**
 * Native fullscreen chrome regression check.
 *
 * Native fullscreen hides the macOS window buttons, so the shell must stop
 * reserving their gutter: the sidebar brand, the conversation title and the
 * right panel title share one row above the rounded content area.
 *
 * Run after `pnpm run build`: node tools/qa/qa-window-fullscreen.mjs
 * Uses only a fresh temporary Studio profile and writes screenshots to
 * .qa/window-fullscreen/, which stays ignored by Git.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'window-fullscreen');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-fullscreen-qa-'));
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

/** Measure the shared top rows, their dividers and the native chrome flag. */
const topRows = (page) => page.evaluate(() => {
  const read = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
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
  return {
    fullscreen: document.documentElement.dataset.windowFullscreen,
    headerHeight: parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--header-height')),
    sidebar: read('.sidebar'),
    brand: read('.brand'),
    header: read('.chat-header'),
    tabs: read('.chat-tabs'),
    panelTabbar: read('.panel-tabbar'),
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

/** The three column titles align above the canvas in both window modes. */
function assertSingleTitleRow(rows, label, { brandPadding = '92px' } = {}) {
  assert.equal(rows.sidebar.paddingTop, '0px', `${label}: the title row owns the top edge`);
  assert.equal(rows.brand.top, 0, `${label}: the brand sits inside the title row`);
  assert.equal(rows.brand.height, rows.headerHeight, `${label}: the brand matches the shared title height`);
  assert.equal(rows.brand.paddingLeft, brandPadding, `${label}: the brand clears the window controls`);
  assert.equal(rows.header.bottom, rows.brand.bottom, `${label}: the conversation title stays inside the shared row`);
  assert.equal(rows.panelTabbar.bottom, rows.brand.bottom, `${label}: the workbench title stays inside the shared row`);
  assert.equal(rows.header.borderBottomWidth, '0px', `${label}: the conversation title meets the canvas without a border`);
  assert.equal(rows.panelTabbar.borderBottomWidth, '0px', `${label}: the workbench title meets the canvas without a border`);
  assert.equal(rows.tabs, null, `${label}: the empty state keeps a single row instead of a placeholder tab bar`);
}

let app;
try {
  app = await _electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.locator('.app').waitFor();
  await waitForChrome(page, false);

  // The workbench shares the same title row as the sidebar and the conversation.
  await page.getByRole('button', { name: '打开右侧面板' }).click();
  await page.locator('.panel-tabbar').waitFor();

  assertSingleTitleRow(await topRows(page), 'windowed');
  await page.screenshot({ path: path.join(output, '01-windowed.png') });

  // Layout contract: the attribute alone switches every shared row.
  await setFullscreenAttribute(page, true);
  const attributeRows = await topRows(page);
  assertSingleTitleRow(attributeRows, 'fullscreen', { brandPadding: '12px' });
  await page.screenshot({ path: path.join(output, '02-fullscreen.png') });

  // The update badge lives in the brand row; the collapse toggle owns the right edge.
  const badge = await page.evaluate(() => {
    const node = document.createElement('button');
    node.className = 'brand-update is-available';
    document.querySelector('.brand').append(node);
    const update = node.getBoundingClientRect();
    const toggle = document.querySelector('.sidebar-top-toggle').getBoundingClientRect();
    node.remove();
    return {
      update: { left: update.left, right: update.right, top: update.top, bottom: update.bottom },
      toggle: { left: toggle.left, right: toggle.right, top: toggle.top, bottom: toggle.bottom },
    };
  });
  const badgeOverlapsToggle = badge.update.right > badge.toggle.left
    && badge.update.left < badge.toggle.right
    && badge.update.bottom > badge.toggle.top
    && badge.update.top < badge.toggle.bottom;
  assert.equal(badgeOverlapsToggle, false, 'the update badge must not cover the collapse toggle');

  // A whole-window workbench drops the same safe area.
  const panelFullscreenPadding = await page.evaluate(() => {
    const panel = document.querySelector('.file-panel');
    panel.classList.add('is-fullscreen');
    const padding = getComputedStyle(document.querySelector('.panel-tabbar')).paddingLeft;
    panel.classList.remove('is-fullscreen');
    return padding;
  });
  assert.equal(panelFullscreenPadding, '10px', 'a whole-window workbench keeps the normal title row padding');

  // With the sidebar collapsed there are no window buttons to steer around either.
  await page.locator('.sidebar-top-toggle').click();
  await page.waitForFunction(() => document.querySelector('.app').classList.contains('is-sidebar-collapsed'));
  const collapsed = await topRows(page);
  assert.equal(collapsed.header.paddingLeft, '24px', 'collapsed sidebar keeps the normal title row padding');
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width <= 1);
  await page.screenshot({ path: path.join(output, '03-collapsed.png') });
  await page.locator('.sidebar-expand').click();
  await page.waitForFunction(() => !document.querySelector('.app').classList.contains('is-sidebar-collapsed'));

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
