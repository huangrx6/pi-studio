/**
 * Menu-bar popover visual and interaction regression.
 *
 * The popover owns an isolated BrowserWindow, so this loads the same local HTML
 * with a small preload bridge and checks density, states and primary actions.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const { menuBarPopoverHeight } = createRequire(import.meta.url)('../../electron/menu-bar-state.cjs');
const output = new URL('../../.qa/screenshots/menu-bar/', import.meta.url).pathname;
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 360, height: 366 } });
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));

await page.addInitScript(() => {
  let listener = null;
  const standardRadii = { tag: 4, control: 8, card: 12, panel: 16, round: 999 };
  window.piMenuBarApi = {
    state: async () => ({
      attention: [{
        id: 'attention-a',
        title: '允许修改项目文件',
        cwd: '/workspace/pi-studio',
        requestId: 'run-a',
        startedAt: Date.now() - 65_000,
        attention: { kind: 'approval', label: '等待授权' },
      }],
      running: [{
        id: 'attention-a',
        title: '允许修改项目文件',
        cwd: '/workspace/pi-studio',
        requestId: 'run-a',
        startedAt: Date.now() - 65_000,
        attention: { kind: 'approval', label: '等待授权' },
      }, {
        id: 'active-b',
        title: '检查扩展安装与升级流程',
        cwd: '/workspace/extensions',
        requestId: 'run-b',
        startedAt: Date.now() - 18_000,
      }],
      recent: [{
        id: 'recent-a',
        title: '修复设置页面样式',
        cwd: '/workspace/pi-studio',
        startedAt: Date.now() - 305_000,
        completedAt: Date.now() - 45_000,
        status: 'success',
        unread: true,
      }],
      unreadCount: 1,
      theme: 'dark',
      palette: 'ocean',
      radii: standardRadii,
    }),
    onState: next => {
      listener = next;
      return () => { listener = null; };
    },
    openMain: () => { window.__mainOpened = true; },
    openSession: session => { window.__openedSession = session; },
    stopSession: async session => { window.__stoppedSession = session; return { ok: true }; },
    openSettings: () => { window.__settingsOpened = true; },
    checkUpdates: () => { window.__updatesOpened = true; },
    quit: () => { window.__quitRequested = true; },
    clearRecent: () => { window.__recentCleared = true; },
    hide: () => {},
  };
  window.__emitMenuBarState = state => listener?.({ ...state, radii: state.radii || standardRadii });
});

try {
  await page.goto(pathToFileURL(path.resolve('electron/menu-bar.html')).href);
  await page.locator('.session-row').first().waitFor();

  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'ocean');
  assert.equal(await page.locator('.header-label, #summary').count(), 0);
  assert.equal(await page.locator('.session-row').count(), 3);
  assert.equal(await page.locator('#attention-section .session-row').count(), 1);
  assert.equal(await page.locator('#running-section .session-row').count(), 1);
  assert.equal(await page.locator('#recent-section .session-row').count(), 1);

  const panel = await page.locator('.popover-panel').boundingBox();
  const shell = await page.locator('.popover-shell').boundingBox();
  assert.ok(panel && shell);
  assert.equal(Math.round(panel.width), Math.round(shell.width - 12));
  assert.equal(Math.round(panel.x - shell.x), 6);

  const mark = await page.locator('.brand-mark').boundingBox();
  const title = await page.locator('.brand-lockup strong').boundingBox();
  assert.ok(mark && title);
  assert.equal(mark.width, 22);
  assert.equal(mark.height, 22);
  assert.ok(Math.abs((mark.y + mark.height / 2) - (title.y + title.height / 2)) <= 1);

  await page.locator('.session-open').first().click();
  assert.equal(await page.evaluate(() => window.__openedSession.id), 'attention-a');
  await page.locator('.session-stop').first().click();
  assert.equal(await page.evaluate(() => window.__stoppedSession.requestId), 'run-a');
  assert.match(await page.locator('#status').textContent(), /已停止/);

  await page.locator('#more').click();
  assert.equal(await page.locator('#more').getAttribute('aria-expanded'), 'true');
  await page.locator('#settings').click();
  assert.equal(await page.evaluate(() => window.__settingsOpened), true);
  await page.locator('#more').click();
  await page.locator('#check-updates').click();
  assert.equal(await page.evaluate(() => window.__updatesOpened), true);
  await page.screenshot({ path: `${output}dark-active.png`, animations: 'disabled' });

  const emptyState = {
    attention: [], running: [], recent: [], unreadCount: 0,
    theme: 'dark', palette: 'ocean',
    radii: { tag: 0, control: 0, card: 0, panel: 0, round: 0 },
  };
  await page.setViewportSize({ width: 360, height: menuBarPopoverHeight(emptyState) });
  await page.evaluate(state => window.__emitMenuBarState(state), emptyState);
  assert.equal(await page.locator('.menu-section:visible').count(), 0);
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await page.locator('.popover-panel').evaluate(node => getComputedStyle(node).borderRadius), '0px');
  assert.equal(await page.locator('#open-main').evaluate(node => getComputedStyle(node).borderRadius), '0px');
  const footer = await page.locator('.popover-footer').boundingBox();
  assert.ok(footer && footer.y + footer.height <= 148);
  await page.screenshot({ path: `${output}dark-idle.png`, animations: 'disabled' });

  const singleResult = {
    attention: [], running: [],
    recent: [{
      id: 'recent-only', title: '检查完成记录', cwd: '/workspace/pi-studio',
      startedAt: Date.now() - 92_000, completedAt: Date.now(), status: 'success', unread: true,
    }],
    unreadCount: 1, theme: 'dark', palette: 'berry',
  };
  await page.setViewportSize({ width: 360, height: menuBarPopoverHeight(singleResult) });
  await page.evaluate(state => window.__emitMenuBarState(state), singleResult);
  const overflow = await page.locator('.popover-content').evaluate(el => ({
    vertical: el.scrollHeight > el.clientHeight,
    horizontal: el.scrollWidth > el.clientWidth,
  }));
  assert.deepEqual(overflow, { vertical: false, horizontal: false });
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'berry');
  await page.screenshot({ path: `${output}dark-single-result.png`, animations: 'disabled' });

  const crowded = {
    attention: [],
    running: Array.from({ length: 12 }, (_, index) => ({
      id: String(index), title: '验证长会话名称不会挤压停止按钮'.repeat(3),
      cwd: '/workspace/pi-studio', requestId: `run-${index}`, startedAt: Date.now() - 3_700_000,
    })),
    recent: [{ id: 'failed', title: '检查模型连接', status: 'error', startedAt: Date.now() - 40_000, completedAt: Date.now() }],
    theme: 'light', palette: 'ocean',
  };
  await page.setViewportSize({ width: 360, height: menuBarPopoverHeight(crowded) });
  await page.evaluate(state => window.__emitMenuBarState(state), crowded);
  assert.equal(await page.locator('.is-error').count(), 1);
  const busyOverflow = await page.locator('.popover-content').evaluate(el => ({
    vertical: el.scrollHeight > el.clientHeight,
    horizontal: el.scrollWidth > el.clientWidth,
  }));
  assert.deepEqual(busyOverflow, { vertical: true, horizontal: false });
  assert.equal(await page.locator('#open-main').isVisible(), true);
  await page.screenshot({ path: `${output}light-busy.png`, animations: 'disabled' });

  await page.locator('#more').click();
  await page.locator('#quit').click();
  assert.equal(await page.evaluate(() => window.__quitRequested), true);
  assert.deepEqual(errors, []);
  console.log('Menu-bar appearance QA passed: compact states, per-session actions, overflow, palette and radii.');
} finally {
  await browser.close();
}
