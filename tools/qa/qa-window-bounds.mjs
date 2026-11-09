/**
 * Main-window geometry persistence regression check.
 *
 * The window must reopen at the last saved position and size, stay inside a
 * connected display, remember the maximized state, and return to a centered
 * window when the user resets the position from the Window menu.
 *
 * Run after `pnpm run build`: node tools/qa/qa-window-bounds.mjs
 * Uses only a fresh temporary Studio profile.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-window-bounds-'));
const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The renderer window, ignoring the menu-bar popover. */
const readWindow = (app) => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()
    .find((item) => !item.isDestroyed() && item.webContents.getURL().includes('index.html'));
  if (!win) throw new Error('main window not found');
  return { bounds: win.getBounds(), normalBounds: win.getNormalBounds(), maximized: win.isMaximized() };
});

/** Run one action against the renderer window, never the menu-bar popover. */
const withWindow = (app, action) => app.evaluate(({ BrowserWindow }, request) => {
  const win = BrowserWindow.getAllWindows()
    .find((item) => !item.isDestroyed() && item.webContents.getURL().includes('index.html'));
  if (!win) throw new Error('main window not found');
  if (request.kind === 'setBounds') win.setBounds(request.bounds);
  else if (request.kind === 'maximize') win.maximize();
  else throw new Error(`unknown window action: ${request.kind}`);
}, action);

async function launch() {
  const app = await _electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  await page.locator('.app').waitFor();
  return { app, page };
}

let app;
try {
  // 1. First launch opens a centered default window inside the work area.
  ({ app } = await launch());
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const initial = await readWindow(app);
  assert.equal(initial.maximized, false);
  assert.ok(initial.bounds.width <= workArea.width, 'default width fits the display');
  assert.ok(initial.bounds.height <= workArea.height, 'default height fits the display');
  assert.ok(initial.bounds.x >= workArea.x && initial.bounds.y >= workArea.y, 'window starts inside the work area');
  const centered = initial.bounds;

  const target = {
    x: workArea.x + 48,
    y: workArea.y + 36,
    width: Math.min(1200, workArea.width - 96),
    height: Math.min(760, workArea.height - 72),
  };
  await withWindow(app, { kind: 'setBounds', bounds: target });
  await sleep(900);
  await app.close();

  // 2. Relaunch restores the exact rectangle.
  ({ app } = await launch());
  const restored = await readWindow(app);
  assert.deepEqual(restored.bounds, target, 'the saved rectangle is restored');
  assert.equal(restored.maximized, false);

  // 3. Maximized windows reopen maximized at the same normal rectangle.
  await withWindow(app, { kind: 'maximize' });
  await sleep(700);
  assert.equal((await readWindow(app)).maximized, true);
  await app.close();

  ({ app } = await launch());
  const maximized = await readWindow(app);
  assert.equal(maximized.maximized, true, 'the maximized state is restored');
  assert.deepEqual(maximized.normalBounds, target, 'the normal rectangle survives a maximized session');

  // 4. "重置窗口位置" centers the window and persists the new rectangle.
  const resetFound = await app.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()?.items
      .flatMap((entry) => entry.submenu?.items || [])
      .find((entry) => entry.label === '重置窗口位置');
    if (!item) return false;
    item.click();
    return true;
  });
  assert.equal(resetFound, true, 'the Window menu exposes the reset action');
  await sleep(900);
  const reset = await readWindow(app);
  assert.deepEqual(reset.bounds, centered, 'reset returns to the centered default window');
  assert.equal(reset.maximized, false);
  await app.close();

  ({ app } = await launch());
  const afterReset = await readWindow(app);
  assert.deepEqual(afterReset.bounds, centered, 'the reset rectangle is persisted');
  await app.close();
  app = null;

  console.log('window bounds persistence ok');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
