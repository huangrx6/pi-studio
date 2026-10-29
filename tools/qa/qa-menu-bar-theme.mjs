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
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/menu-bar/', import.meta.url).pathname;
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 720, height: 440 } });
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
    openSession: () => {},
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
  assert.ok(panel && panel.width > 690 && panel.height > 410);
  const columns = await page.locator('.popover-content').evaluate(
    element => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean),
  );
  assert.equal(columns.length, 2);
  assert.equal(await page.locator('#activity-state').getAttribute('class'), 'activity-state is-running');
  await page.screenshot({ path: `${output}dark-active.png`, animations: 'disabled' });
  await appearance('rgb(29, 78, 216)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'amber',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'amber');
  await appearance('rgb(146, 64, 14)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'berry',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'berry');
  await appearance('rgb(157, 23, 77)');

  await page.evaluate(() => window.__emitMenuBarState({
    running: [],
    recent: [],
    unreadCount: 0,
    theme: 'dark',
    palette: 'lime',
  }));
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'lime');
  await appearance('rgb(40, 107, 89)');

  assert.deepEqual(errors, []);
  console.log('Menu-bar theme QA passed: palette changes update the isolated popover immediately.');
} finally {
  await browser.close();
}
