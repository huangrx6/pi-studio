/** Production renderer + 1260 isolated synthetic sessions; no real data or model requests. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installSidebarVirtualizationFixture } from './fixtures/sidebar-virtualization.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/sidebar-virtualization');
await mkdir(output, { recursive: true });
const result = { fixtureSessions: 1260, checks: [], screenshots: [], pageErrors: [], blockedRequests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
const server = await serveProductionRenderer(root);
let browser;
let page;
const shell = (index) => page.locator(`[data-session-id="perf-${index}"]`);
const row = (index) => shell(index).locator('.session-row');
const trigger = (index) => shell(index).getByRole('button', { name: /的更多操作$/ });
async function settle() { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function scrollTo(position) {
  await page.locator('.workspace-list').evaluate((element, value) => { element.scrollTop = value === 'bottom' ? element.scrollHeight : value; }, position);
  await settle();
}
async function focused(locator) { await page.waitForFunction((element) => document.activeElement === element, await locator.elementHandle()); }
async function visibleInViewport(index) {
  await page.waitForFunction((id) => {
    const row = document.querySelector(`[data-session-id="perf-${id}"] .session-row`);
    const pane = document.querySelector('.workspace-list');
    if (!row || !pane) return false;
    const a = row.getBoundingClientRect(); const b = pane.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  }, index);
}
async function bounded(label) {
  const metrics = await page.locator('.workspace-list').evaluate((pane) => ({ mounted: pane.querySelectorAll('.session-row:not(.empty)').length, scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, viewportHeight: pane.clientHeight }));
  assert(metrics.mounted > 0 && metrics.mounted < 100, `${label}: bounded mounted rows (${metrics.mounted})`);
  result.checks.push({ label, ...metrics });
}
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push(name);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue();
    result.blockedRequests.push(url); return route.abort();
  });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:1260,turnCount:8});(${installSidebarVirtualizationFixture.toString()})();` });
  await page.goto(server.origin);
  await row(0).waitFor();
  await bounded('initial viewport');
  assert.equal(await shell(0).getAttribute('role'), 'listitem');
  assert.equal(await shell(0).getAttribute('aria-posinset'), '1');
  assert.equal(await shell(0).getAttribute('aria-setsize'), '1260');
  await scrollTo('bottom');
  await visibleInViewport(1259);
  await bounded('far end viewport');
  await row(1259).click();
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 1259' }).waitFor();
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const draft = '1260 条会话滚动和筛选时保留的草稿';
  await page.locator('.assistant-response').first().waitFor();
  await settle();
  await composer.fill(draft);
  await settle();
  assert.equal(await composer.inputValue(), draft);
  await scrollTo(0);
  await visibleInViewport(0);
  assert.equal(await shell(1259).count(), 0, 'active row does not stay mounted or snap scroll back during ordinary scrolling');
  await page.evaluate(() => window.__sidebarQa.open('perf-600'));
  await visibleInViewport(600);
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 0600' }).waitFor();
  await settle();
  await page.evaluate(() => window.__sidebarQa.open('perf-1259'));
  await visibleInViewport(1259);
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 1259' }).waitFor();
  await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="发送给 Pi 的消息"]').value === expected, draft);
  assert.equal(await composer.inputValue(), draft);
  result.checks.push('external active changes scroll into view; ordinary scrolling stays free; drafts survive navigation');

  await composer.focus();
  await page.keyboard.press('Meta+Shift+[');
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 1258' }).waitFor();
  const otherDraft = '键盘切换后另一个会话的独立草稿';
  await composer.fill(otherDraft);
  await page.keyboard.press('Meta+Shift+]');
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 1259' }).waitFor();
  await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="发送给 Pi 的消息"]').value === expected, draft);
  await page.keyboard.press('Meta+n');
  await page.getByRole('heading', { name: '开始一个新会话', exact: true }).waitFor();
  await page.evaluate(() => window.__sidebarQa.open('perf-1259'));
  await page.locator('.chat-heading h1').filter({ hasText: '性能会话 1259' }).waitFor();
  assert.equal(await composer.inputValue(), draft);
  result.checks.push('real previous/next/new-chat shortcuts retain independent drafts');

  const searchTrigger = page.getByRole('button', { name: '搜索工作区', exact: true });
  await searchTrigger.click();
  const search = page.getByRole('searchbox', { name: '搜索工作区或会话', exact: true });
  await search.fill('性能会话 1199');
  await row(1199).waitFor();
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 1, 'far unmounted sessions remain searchable');
  assert.equal(await shell(1199).getAttribute('aria-posinset'), '1');
  assert.equal(await shell(1199).getAttribute('aria-setsize'), '1', 'filtered list accessibility uses filtered size');
  assert.equal(await page.locator('.workspace-list').evaluate((element) => element.scrollTop), 0);
  await search.press('Escape');
  await search.press('Escape');
  await search.waitFor({ state: 'detached' });
  await page.locator('.workspace-row').click();
  await page.waitForFunction(() => document.querySelectorAll('.session-row:not(.empty)').length === 0);
  await page.locator('.workspace-row').click();
  await row(0).waitFor();
  await bounded('expanded after collapse');
  assert.equal(await composer.inputValue(), draft);
  result.checks.push('search covers unmounted history, filter scroll resets, workspace collapse/expand preserves draft');

  // Walk actual Tab order beyond the initial overscan window, not a synthetic focus shortcut.
  const initialLast = await page.locator('[data-session-index]').evaluateAll((nodes) => Math.max(...nodes.map((node) => Number(node.dataset.sessionIndex))));
  await page.evaluate(() => {
    window.__focusLog = [];
    const describe = (node) => node instanceof Element ? { tag: node.tagName, label: node.getAttribute('aria-label'), row: node.closest('[data-session-id]')?.getAttribute('data-session-id') } : null;
    for (const type of ['focusin', 'focusout', 'keydown']) document.addEventListener(type, (event) => { window.__focusLog.push({ type, key: event.key, target: describe(event.target), related: describe(event.relatedTarget) }); if (window.__focusLog.length > 200) window.__focusLog.shift(); }, true);
    window.__rowBeforeTab = document.querySelector('[data-session-id="perf-0"] .session-row');
  });
  await row(0).focus();
  await settle();
  await focused(row(0));
  const visited = new Set([0]);
  let last = 0;
  for (let step = 0; step < (initialLast + 5) * 5; step++) {
    const priorFocus = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250));
    await page.keyboard.press('Tab');
    await settle();
    const index = await page.evaluate(() => Number(document.activeElement?.closest('[data-session-index]')?.getAttribute('data-session-index') ?? -1));
    if (!(index >= last && index <= last + 1)) result.focusFailure = { step, priorFocus, detail: await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 250), log: window.__focusLog, connected: window.__rowBeforeTab.isConnected, moreVisibility: getComputedStyle(document.querySelector('[data-session-id="perf-0"] .sidebar-row-actions')).visibility, rows: [...document.querySelectorAll('[data-session-index]')].slice(0, 3).map((node) => node.outerHTML) })) };
    assert(index >= last && index <= last + 1, `Tab must not skip a logical row (${last} -> ${index})`);
    visited.add(index); last = index;
    if (index > initialLast + 1) break;
  }
  assert(last > initialLast + 1, 'Tab crossed the initial mounted boundary');
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-session-id]'))), 'reverse Tab remains in logical session order');
  await bounded('keyboard crossed virtual boundary');
  result.checks.push({ label: 'native Tab continuity', initialLast, last, visited: [...visited] });

  await scrollTo(0);
  await shell(5).hover();
  await trigger(5).press('Enter');
  await page.getByRole('menu', { name: '性能会话 0005的操作', exact: true }).waitFor();
  await page.keyboard.press('Shift+Tab');
  await focused(row(5));
  result.checks.push('menu reverse Tab returns to current logical row without jumping to list end');
  await page.evaluate(() => {
    window.__scrollFocusLog = [];
    const scrollProperty = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', { ...scrollProperty, set(value) {
      const entry = this.matches('.workspace-list') ? { method: 'scrollTop=', before: scrollProperty.get.call(this), value, stack: new Error().stack?.split('\n').slice(1, 6) } : null;
      scrollProperty.set.call(this, value);
      if (entry) { entry.after = scrollProperty.get.call(this); window.__scrollFocusLog.push(entry); }
    } });
    for (const [prototype, method] of [[HTMLElement.prototype, 'focus'], [Element.prototype, 'scrollIntoView']]) {
      const original = prototype[method];
      prototype[method] = function (...args) {
        const pane = document.querySelector('.workspace-list');
        const entry = { method, target: this.getAttribute('aria-label') || this.getAttribute('data-sidebar-key') || this.className, args, before: pane?.scrollTop, stack: new Error().stack?.split('\n').slice(1, 6) };
        const value = original.apply(this, args); entry.after = pane?.scrollTop;
        window.__scrollFocusLog.push(entry); if (window.__scrollFocusLog.length > 100) window.__scrollFocusLog.shift();
        return value;
      };
    }
  });
  await shell(0).hover();
  await trigger(0).press('Enter');
  const menu = page.getByRole('menu', { name: '性能会话 0000的操作', exact: true });
  await menu.waitFor();
  await scrollTo('bottom');
  await menu.waitFor({ state: 'detached' });
  await focused(trigger(0));
  const menuScroll = await page.locator('.workspace-list').evaluate((pane) => ({ top: pane.scrollTop, bottom: pane.scrollHeight - pane.clientHeight }));
  assert(Math.abs(menuScroll.top - menuScroll.bottom) < 2, `menu dismissal preserves scroll position (${menuScroll.top}/${menuScroll.bottom})`);
  assert.equal(await shell(0).count(), 1, 'scroll dismissal retains the focused owner');
  await bounded('menu owner retained');
  await scrollTo(0);
  await trigger(0).press('Enter');
  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await dialog.waitFor();
  await scrollTo('bottom');
  assert.equal(await dialog.count(), 1, 'scrolling does not dismiss a rename dialog');
  assert.equal(await shell(0).count(), 1, 'dialog owner remains mounted outside viewport');
  await bounded('dialog owner retained');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await focused(trigger(0));
  await composer.focus();
  await settle();
  assert.equal(await shell(0).count(), 0, 'owner releases after interaction and focus move away');
  result.checks.push('menu scrolling closes with focus restoration; modal survives scroll; owner retention releases');

  // Actual browser drag/drop between mounted rows checks persisted reorder callback.
  await scrollTo(0);
  await row(0).dragTo(row(2));
  await page.waitForFunction(() => {
    const order = JSON.parse(localStorage.getItem('pi-studio:session-order') || '{}')['/qa/synthetic/performance'];
    return order?.[0] === 'perf-1' && order?.[2] === 'perf-0';
  });
  result.checks.push('native drag/drop reorders sessions and persists logical order');
  await bounded('after reorder');

  // Deterministic HTML5 event path supplements native dragTo for a far target:
  // edge movement is real component rAF scrolling; the long jump is explicit.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(1).dispatchEvent('dragstart', { dataTransfer: transfer });
  const paneBox = await page.locator('.workspace-list').boundingBox();
  await page.locator('.workspace-list').dispatchEvent('dragover', { dataTransfer: transfer, clientX: paneBox.x + 40, clientY: paneBox.y + paneBox.height - 2 });
  await page.waitForFunction(() => document.querySelector('.workspace-list').scrollTop > 100);
  await page.locator('.workspace-list').dispatchEvent('dragover', { dataTransfer: transfer, clientX: paneBox.x + 40, clientY: paneBox.y + paneBox.height / 2 });
  await scrollTo('bottom');
  assert.equal(await shell(1).count(), 1, 'drag source remains mounted beyond viewport');
  await bounded('drag source retained');
  await row(1259).dispatchEvent('dragover', { dataTransfer: transfer });
  await row(1259).dispatchEvent('drop', { dataTransfer: transfer });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('pi-studio:session-order'))['/qa/synthetic/performance'].at(-1) === 'perf-1');
  await transfer.dispose();
  result.checks.push('HTML5 drag events: real edge auto-scroll, retained distant source, far drop persisted; keyboard navigation checked, no keyboard reorder feature claimed');

  // A removed row must hand focus to a surviving logical row, not a spacer/body.
  await composer.focus();
  await scrollTo(0);
  await shell(2).hover();
  await shell(2).getByRole('button', { name: '归档会话：性能会话 0002', exact: true }).click();
  const archiveDialog = page.getByRole('dialog', { name: '归档这个会话？', exact: true });
  await archiveDialog.waitFor();
  await scrollTo('bottom');
  assert.equal(await shell(2).count(), 1, 'confirmation owner stays mounted');
  await page.evaluate(() => { window.__sidebarQa.holdActions = true; });
  await archiveDialog.getByRole('button', { name: '归档会话', exact: true }).click();
  await page.waitForFunction(() => window.__sidebarQa.pendingActions() === 1);
  assert.equal(await shell(2).locator('[data-interaction-active="true"]').count(), 1, 'pending action retains owner');
  await page.evaluate(() => window.__sidebarQa.releaseActions());
  await archiveDialog.waitFor({ state: 'detached' });
  await shell(2).waitFor({ state: 'detached' });
  await page.waitForFunction(() => Boolean(document.activeElement?.closest('[data-sidebar-key]')));
  result.checks.push('confirmation and pending action retain owner; archived owner restores focus to surviving logical row');
  await composer.focus();
  await scrollTo(0);

  await capture('01-sidebar-light-980');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await capture('02-sidebar-dark-980');
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await page.evaluate(() => window.__performanceQa.submitCalls), 0);
  await page.context().close();
  page = await browser.newPage({ viewport: { width: 980, height: 640 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue();
    result.blockedRequests.push(url); return route.abort();
  });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:1260,turnCount:8});(${installSidebarVirtualizationFixture.toString()})({splitAt:630});` });
  await page.goto(server.origin);
  await row(0).waitFor();
  await bounded('two workspace initial viewport');
  await scrollTo('bottom');
  await visibleInViewport(1259);
  await page.evaluate(() => window.__sidebarQa.open('perf-900'));
  await visibleInViewport(900);
  const firstWorkspace = page.locator('[data-workspace-cwd="/qa/synthetic/performance"] > .workspace-row-shell > .workspace-row');
  await firstWorkspace.evaluate((node) => node.click());
  await page.waitForFunction(() => !document.querySelector('[data-workspace-cwd="/qa/synthetic/performance"] .sessions'));
  await page.evaluate(() => window.__sidebarQa.open('perf-901'));
  await visibleInViewport(901);
  await firstWorkspace.evaluate((node) => node.click());
  await page.waitForFunction(() => Boolean(document.querySelector('[data-workspace-cwd="/qa/synthetic/performance"] .sessions')));
  await page.evaluate(() => window.__sidebarQa.open('perf-902'));
  await visibleInViewport(902);
  await bounded('second group after preceding collapse and expansion');
  assert.equal(await shell(902).getAttribute('aria-setsize'), '630');
  assert.equal(await shell(902).getAttribute('aria-posinset'), '273');
  await page.evaluate(() => window.__sidebarQa.open('perf-629'));
  await visibleInViewport(629);
  await row(629).focus();
  await settle();
  const crossed = [];
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press('Tab'); await settle();
    const key = await page.evaluate(() => document.activeElement?.closest('[data-sidebar-key]')?.getAttribute('data-sidebar-key'));
    assert(key, 'Tab across workspace boundary never loses focus');
    crossed.push(key);
    if (key === 's:perf-630') break;
  }
  assert(crossed.includes('w:/qa/synthetic/performance-b'), 'Tab traverses the second workspace controls');
  assert.equal(crossed.at(-1), 's:perf-630', 'Tab reaches the first logical row in the second group');
  result.checks.push({ label: 'two 630-session workspaces: group geometry, preceding collapse/expand, selection locate, cross-group Tab', crossed });
  await capture('03-two-workspaces-980');
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.blockedRequests, []);
} catch (error) {
  result.error = error.stack;
  if (page) result.failureFocus = await page.evaluate(() => ({ scrollFocusLog: window.__scrollFocusLog, tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.tagName === 'BODY' ? null : document.activeElement?.textContent?.slice(0, 100), row: document.activeElement?.closest('[data-sidebar-key]')?.getAttribute('data-sidebar-key') })).catch(() => null);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
console.log(JSON.stringify(result, null, 2));
