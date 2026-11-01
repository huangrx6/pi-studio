/**
 * Menu-bar popover theme regression.
 *
 * The popover runs in its own Electron BrowserWindow, so it cannot be covered by
 * the main-window Vite QA. This script loads the same local HTML directly in
 * Chromium, drives the preload state bridge, and verifies that palette changes
 * reach the popover tokens immediately.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { menuBarPopoverHeight } = createRequire(import.meta.url)('../../electron/menu-bar-state.cjs');
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/menu-bar/', import.meta.url).pathname;
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 520, height: 388 } });
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.addInitScript(() => {
  let listener = null;
  window.piMenuBarApi = {
    state: async () => ({
      running: [
        {
          id: 'active-a',
          title: '整理模型来源配置',
          cwd: '/workspace/pi-studio',
          startedAt: Date.now() - 65_000,
        },
        {
          id: 'active-b',
          title: '检查扩展安装与升级流程',
          cwd: '/workspace/extensions',
          startedAt: Date.now() - 18_000,
        },
      ],
      recent: [
        {
          id: 'recent-a',
          title: '修复设置页面样式',
          cwd: '/workspace/pi-studio',
          completedAt: Date.now() - 45_000,
          status: 'success',
          unread: true,
        },
      ],
      unreadCount: 1,
      theme: 'dark',
      palette: 'ocean',
    }),
    onState: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    openMain: () => {},
    openSession: (session) => { window.__openedSession = session; },
    quit: () => { window.__quitRequested = true; },
    clearRecent: () => {},
    hide: () => {},
  };
  window.__emitMenuBarState = (state) => listener?.(state);
});

async function appearance(buttonColor) {
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const actual = await page.locator('#open-main').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(actual, buttonColor);
  return actual;
}

try {
  await page.goto(pathToFileURL(path.resolve('electron/menu-bar.html')).href);
  await page.locator('#open-main').waitFor();
  await page.locator('.session-card').first().waitFor();

  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'ocean');
  const panel = await page.locator('.popover-panel').boundingBox();
  assert.ok(panel && panel.width === 504);
  assert.equal(await page.locator('.session-card').count(), 3);
  const first = await page.locator('.session-card').first().boundingBox();
  const second = await page.locator('.session-card').nth(1).boundingBox();
  assert.equal(first.x, second.x);
  assert.equal(first.width, second.width);
  await page.locator('.session-card').first().click();
  assert.equal(await page.evaluate(() => window.__openedSession.id), 'active-a');
  const arrows = await page.locator('.session-action').evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().right));
  assert.equal(new Set(arrows).size, 1);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${output}dark-active.png`, animations: 'disabled' });
  await appearance('rgb(59, 110, 211)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'amber',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'amber');
  await appearance('rgb(161, 101, 23)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'berry',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'berry');
  await appearance('rgb(185, 76, 126)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'lime',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'lime');
  await appearance('rgb(50, 127, 104)');

  await page.setViewportSize({ width: 520, height: menuBarPopoverHeight() });
  assert.equal(await page.locator('.menu-section:visible').count(), 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const footer = await page.locator('.popover-footer').boundingBox();
  assert.ok(footer.y + footer.height <= 188);
  await page.screenshot({ path: `${output}dark-idle.png`, animations: 'disabled' });
  await page.locator('#quit').click();
  assert.equal(await page.evaluate(() => window.__quitRequested), true);
  const crowded = {
    running: Array.from({ length: 12 }, (_, n) => ({ id: String(n), title: '验证长会话名称不会挤压状态与返回入口'.repeat(4), cwd: '/workspace/pi-studio', startedAt: Date.now() - 3_700_000 })),
    recent: [{ id: 'failed', title: '检查模型连接', status: 'error', completedAt: Date.now() }],
    theme: 'light', palette: 'ocean',
  };
  await page.setViewportSize({ width: 520, height: menuBarPopoverHeight(crowded) });
  await page.evaluate(state => window.__emitMenuBarState(state), crowded);
  assert.equal(await page.locator('.is-error').count(), 1);
  assert.match(await page.locator('#summary').textContent(), /异常/);
  const overflow = await page.locator('.popover-content').evaluate(el => ({ vertical: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth > el.clientWidth }));
  assert.deepEqual(overflow, { vertical: true, horizontal: false });
  assert.ok(await page.locator('#open-main').isVisible());
  await page.screenshot({ path: `${output}light-busy.png`, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Menu-bar theme QA passed: palette changes update the isolated popover immediately.');
} finally {
  await browser.close();
}
