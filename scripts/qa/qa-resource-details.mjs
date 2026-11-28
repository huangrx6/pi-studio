import { composerValue } from './fixtures/composer-editor.mjs';
/** Built production renderer with in-memory resource DTOs; no real resource reads or writes. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { installResourceDetailsFixture } from './fixtures/resource-details.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/resource-details'); await mkdir(output, { recursive: true });
const result = { scope: 'Production renderer, isolated Chromium context, deterministic memory-only resource DTOs and held promises; no Electron/file/network/model side effects. IME key guards use synthetic composing/229 events because this read-only detail has no editable field; ordinary Escape and Tab are native keyboard events.', assets: (await readFile(path.join(root, 'dist/renderer/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g), checks: [], screenshots: [], geometry: [], pageErrors: [], blockedRequests: [] };
const server = await serveProductionRenderer(root); let browser, page;
const dialog = () => page.locator('.skill-detail-dialog');
const tree = () => dialog().locator('.skill-file-tree');
const preview = () => dialog().locator('.skill-file-preview');
const treeError = () => tree().locator('.skill-detail-read-error');
const fileError = () => preview().locator('.skill-detail-read-error');
const composer = () => page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function qa(method, ...args) { await page.evaluate(({ method, args }) => window.__resourceDetailsQa[method](...args), { method, args }); await settle(); }
async function pending(method, scope, target = '') { await page.waitForFunction(({ method, scope, target }) => window.__resourceDetailsQa.pending(method, scope, target) > 0, { method, scope, target }); }
async function opener(scope) { const name = await page.evaluate(scope => window.__resourceDetailsQa.names[scope], scope); return page.getByRole('button', { name: `查看技能 ${name}`, exact: true }); }
async function open(scope) {
  await (await opener(scope)).click();
  await dialog().waitFor();
  assert.equal(await dialog().evaluate(node => getComputedStyle(node.closest('dialog'), '::backdrop').backdropFilter), 'blur(3px)');
}
async function close() { await dialog().getByRole('button', { name: '关闭技能详情', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); }
async function content(scope, target = 'SKILL.md') { await preview().getByRole('heading', { name: `${scope} ${target}`, exact: true }).waitFor(); }
async function capture(name, theme, viewport, selector) {
  await page.setViewportSize(viewport); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle();
  const geometry = await page.locator(selector).evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height, left: box.left, right: box.right, viewportWidth: innerWidth, overflow: node.scrollWidth > node.clientWidth + 1, rootOverflow: document.documentElement.scrollWidth > innerWidth + 1 }; });
  assert.equal(geometry.overflow, false, `${name}: detail horizontal overflow`); assert.equal(geometry.rootOverflow, false, `${name}: viewport overflow`); assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewportWidth + 1, `${name}: dialog stays in viewport`);
  result.geometry.push({ name, ...geometry }); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); result.screenshots.push(name);
}
async function checkResourceDialogs(draft) {
  await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tablist', { name: '插件与资源' }).getByRole('tab', { name: '技能', exact: true }).click();
  await (await opener('A')).waitFor();
  // Closing a resource must invalidate both successful and rejected old reads.
  for (const [method, target] of [['files', ''], ['filePreview', 'SKILL.md']]) {
    for (const rejected of [false, true]) {
      await qa('hold', method, 'A', target); if (rejected) await qa('fail', method, 'A', target);
      await open('A'); await pending(method, 'A', target); await close(); await open('B'); await content('B');
      await qa('release', method, 'A', target); await content('B');
      assert.equal(await dialog().locator('[role="alert"]').count(), 0, 'late A failure cannot surface on B');
      assert.equal(await tree().getByRole('button', { name: /A-only/ }).count(), 0, 'late A directory cannot replace B tree');
      assert.match(await tree().innerText(), /B-only/); assert.doesNotMatch(await preview().innerText(), /A_ONLY_CONTENT/);
      await close(); result.checks.push(`${method} ${rejected ? 'rejection' : 'success'} after A close/B open cannot contaminate B`);
    }
  }
  await open('B'); await content('B');
  await qa('fail', 'filePreview', 'B', 'notes.md'); await tree().getByRole('button', { name: /notes\.md/ }).click(); await fileError().waitFor();
  await qa('fail', 'files', 'B', ''); await tree().getByRole('button', { name: '刷新技能文件', exact: true }).click(); await treeError().waitFor(); assert.equal(await fileError().count(), 1, 'directory failure must not clear file error');
  await preview().getByRole('button', { name: '重试读取技能文件', exact: true }).click(); await content('B', 'notes.md'); assert.equal(await treeError().count(), 1, 'successful file retry must not erase directory error');
  await tree().getByRole('button', { name: '重试读取技能目录', exact: true }).click(); await treeError().waitFor({ state: 'detached' }); await content('B', 'notes.md');
  result.checks.push('directory and file errors remain independent; retry repeats the failed scoped read and preserves selected notes');
  const locationSummary = dialog().locator('.skill-detail-location summary');
  await dialog().getByRole('button', { name: '关闭技能详情', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await locationSummary.evaluate(node => node === document.activeElement), true, 'header close Tab reaches native location summary');
  await page.keyboard.press('Enter'); assert.notEqual(await dialog().locator('.skill-detail-location').getAttribute('open'), null);
  await page.keyboard.press('Tab'); assert.equal(await tree().getByRole('button', { name: '刷新技能文件', exact: true }).evaluate(node => node === document.activeElement), true, 'Tab from summary continues to next enabled directory action');
  await page.keyboard.press('Shift+Tab'); assert.equal(await locationSummary.evaluate(node => node === document.activeElement), true);
  await capture('01-skill-wide-light', 'light', { width: 1440, height: 900 }, '.skill-detail-dialog');
  await capture('02-skill-wide-dark', 'dark', { width: 1440, height: 900 }, '.skill-detail-dialog');
  await capture('03-skill-narrow-light', 'light', { width: 600, height: 760 }, '.skill-detail-dialog');
  await capture('04-skill-narrow-dark', 'dark', { width: 600, height: 760 }, '.skill-detail-dialog');
  const closeButton = dialog().getByRole('button', { name: '关闭技能详情', exact: true }); await closeButton.focus();
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) { await closeButton.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...properties }); assert.equal(await dialog().count(), 1); }
  for (let index = 0; index < 18; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]'))), true, 'Tab stays in native detail'); }
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' }); await settle(); assert.equal(await (await opener('B')).evaluate(node => node === document.activeElement), true);
  result.checks.push('native location summary close→Tab→summary→Tab→directory and reverse order, composing/229 Escape guard, real Tab containment, ordinary Escape restores exact skill opener');
  await page.setViewportSize({ width: 980, height: 760 });
  await open('A'); await content('A'); await tree().getByRole('button', { name: /artifact\.bin/ }).click();
  await preview().getByRole('button', { name: '用系统应用打开文件', exact: true }).waitFor();
  await qa('hold', 'openWith', 'A', 'artifact.bin'); await qa('fail', 'openWith', 'A', 'artifact.bin');
  await preview().getByRole('button', { name: '用系统应用打开文件', exact: true }).click(); await pending('openWith', 'A', 'artifact.bin'); await close(); await open('B'); await content('B');
  await qa('release', 'openWith', 'A', 'artifact.bin'); assert.equal(await dialog().locator('[role="alert"]').count(), 0); await close();
  result.checks.push('late external-open failure from A does not leak into B');

  await page.getByRole('tablist', { name: '插件与资源' }).getByRole('tab', { name: '扩展', exact: true }).click();
  const extensionName = await page.evaluate(() => window.__resourceDetailsQa.extensionName);
  const extensionOpener = page.getByRole('button', { name: `打开 ${extensionName} 设置`, exact: true });
  await extensionOpener.click(); const extension = page.locator('.extension-detail-dialog'); await extension.waitFor();
  const source = extension.locator('details.extension-detail-source');
  assert.equal(await source.getAttribute('open'), null);
  await source.locator('summary').press('Enter');
  await source.getByText('未声明扩展权限', { exact: true }).waitFor(); assert.doesNotMatch(await source.innerText(), /仅声明式界面/); assert.match(await source.innerText(), /Electron 主进程/);
  await source.locator('summary').press('Enter');
  const technical = extension.locator('details.extension-detail-technical'); assert.equal(await technical.getAttribute('open'), null); const summary = technical.locator('summary'); await summary.focus(); await page.keyboard.press('Enter'); await technical.getByText('qa.permissionless-runtime', { exact: true }).first().waitFor(); assert.notEqual(await technical.getAttribute('open'), null);
  await technical.getByText('abcdef0123456789'.repeat(4), { exact: true }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await extension.getByRole('button', { name: '回滚版本', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await extension.getByRole('button', { name: `卸载 ${extensionName}`, exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await extension.locator('.extension-version-list').getByText('v1.0.0', { exact: true }).count(), 1);
  assert.equal(await extension.getByRole('button', { name: '回滚版本', exact: true }).isEnabled(), true);
  await capture('05-extension-wide-light', 'light', { width: 1440, height: 900 }, '.extension-detail-dialog');
  await capture('06-extension-980-dark', 'dark', { width: 980, height: 760 }, '.extension-detail-dialog');
  await capture('07-extension-980-light', 'light', { width: 980, height: 760 }, '.extension-detail-dialog');
  await source.locator('summary').click();
  const headingAppearance = () => summary.evaluate(trigger => {
    const body = trigger.closest('.extension-detail-body');
    const edge = body.querySelector('.extension-enable-row').getBoundingClientRect();
    const label = trigger.querySelector('.pi-accordion-label');
    const arrow = trigger.querySelector('.pi-accordion-chevron');
    const labels = [label, body.querySelector('.extension-detail-source h3')];
    if (trigger.parentElement.open) labels.push(body.querySelector('.extension-detail-technical dt'));
    return {
      offsets: [...labels.map(node => node.getBoundingClientRect().left - edge.left), arrow.getBoundingClientRect().right - edge.right],
      background: getComputedStyle(trigger).backgroundColor, title: getComputedStyle(label).color, arrow: getComputedStyle(arrow).color,
    };
  });
  for (const [theme, width] of [['dark', 600], ['light', 980]]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.mouse.move(0, 0);
    const idle = await headingAppearance();
    assert.ok(idle.offsets.every(offset => Math.abs(offset) < 1), JSON.stringify(idle));
    await summary.hover();
    const hovered = await headingAppearance();
    assert.deepEqual(hovered.offsets, idle.offsets);
    assert.equal(hovered.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(hovered.title, idle.title);
    assert.equal(hovered.arrow, hovered.title);
    const name = `technical-heading-${theme}`;
    await extension.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
    result.screenshots.push(name);
  }
  await summary.press('Space');
  assert.equal(await technical.getAttribute('open'), null);
  assert.ok((await headingAppearance()).offsets.every(offset => Math.abs(offset) < 1));
  assert.ok(await summary.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'));
  result.checks.push('technical and permission headings align with facts in both themes; hover highlights text and chevron, and keyboard collapse preserves focus');
  await page.keyboard.press('Escape'); await extension.waitFor({ state: 'detached' }); await settle(); assert.equal(await extensionOpener.evaluate(node => node === document.activeElement), true);
  result.checks.push('source and technical disclosures open by keyboard, preserve execution and version information, and Tab reaches rollback then uninstall; Escape restores opener');
  await page.locator('[data-sidebar-section="conversations"]').click(); assert.equal(await composerValue(composer()), draft);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 980, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (url.startsWith(server.origin) || /^(data|blob):/.test(url)) return route.continue(); result.blockedRequests.push(url); return route.abort(); });
  await page.addInitScript({ content: `(${installPerformanceFixture.toString()})({sessionCount:2,turnCount:4});(${installResourceDetailsFixture.toString()})();` });
  await page.goto(server.origin); await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click(); await page.locator('.assistant-response').first().waitFor();
  const draft = '查看资源详情时保留的会话草稿'; await composer().fill(draft);
  if (!process.argv.includes('--services')) await checkResourceDialogs(draft);
  // Service scope lifecycle uses only the fixture's synthetic process identities.
  const trigger = page.getByRole('button', { name: /^运行服务(?:，|$)/ });
  const services = () => page.getByRole('dialog', { name: '运行服务', exact: true });
  const switchScope = async id => {
    await qa('open', id);
    await services().waitFor({ state: 'detached' });
    await trigger.click();
  };
  const serviceRow = port => services().locator('.runtime-service-row').filter({ has: page.locator('.runtime-service-port', { hasText: new RegExp(`^${port}$`) }) });
  const stop = port => serviceRow(port).locator('.runtime-service-stop');
  const confirm = () => page.getByRole('alertdialog');
  const scanCount = scope => page.evaluate(scope => window.__resourceDetailsQa.calls.filter(call => call.method === 'runtimeServices' && call.scope === scope).length, scope);
  const stopCount = () => page.evaluate(() => window.__resourceDetailsQa.calls.filter(call => call.method === 'runtimeServiceStop').length);
  await qa('failUntilClear', 'runtimeServices', 'A');
  await trigger.focus();
  await trigger.press('Enter'); await services().getByRole('alert').waitFor();
  await page.keyboard.press('Escape'); await services().waitFor({ state: 'detached' });
  assert.ok(await trigger.evaluate(node => node === document.activeElement));
  await trigger.click(); await services().waitFor();
  await composer().click({ position: { x: 5, y: 5 } }); await services().waitFor({ state: 'detached' });
  assert.ok(await composer().evaluate(node => node.contains(document.activeElement)));
  await trigger.click(); await services().getByRole('alert').waitFor();
  assert.equal(await services().getByText('暂无相关服务', { exact: true }).count(), 0, 'first scan failure is not a successful empty result');
  const anchor = await trigger.boundingBox();
  const popup = await services().boundingBox();
  assert.ok(popup.y + popup.height <= anchor.y, 'service list opens above the status bar');
  await qa('clearFailure', 'runtimeServices', 'A'); await services().getByRole('button', { name: '重试', exact: true }).click(); await serviceRow(43001).waitFor();
  assert.equal(await services().locator('.runtime-service-row').count(), 2);
  await services().getByRole('button', { name: /^本机全部/ }).click(); assert.equal(await services().locator('.runtime-service-row').count(), 3);
  await stop(45001).click(); await confirm().getByText(/当前工作区以外的本机服务/).waitFor(); await confirm().getByRole('button', { name: '取消', exact: true }).click();
  await services().getByRole('button', { name: /^相关服务/ }).click();
  await qa('fail', 'runtimeServices', 'A'); await services().getByRole('button', { name: '刷新运行服务', exact: true }).click(); await services().getByText('以下显示上次扫描结果', { exact: true }).waitFor(); assert.equal(await serviceRow(43001).count(), 1);
  await services().getByRole('button', { name: '重试', exact: true }).click(); await services().getByRole('alert').waitFor({ state: 'detached' });
  await capture('08-services-light', 'light', { width: 980, height: 760 }, '.runtime-status-popover'); await capture('09-services-dark', 'dark', { width: 980, height: 760 }, '.runtime-status-popover');
  const liveStatus = services().locator('.runtime-services-live');
  assert.equal(await liveStatus.innerText(), '自动刷新');
  const statusBounds = await liveStatus.boundingBox();
  await qa('hold', 'runtimeServices', 'A'); await services().getByRole('button', { name: '刷新运行服务', exact: true }).click(); await pending('runtimeServices', 'A');
  assert.equal(await liveStatus.innerText(), '自动刷新');
  assert.deepEqual(await liveStatus.boundingBox(), statusBounds);
  assert.equal(await serviceRow(43001).count(), 1);
  assert.equal(await services().getByRole('button', { name: '刷新运行服务' }).getAttribute('aria-busy'), 'true');
  await switchScope('perf-1'); await serviceRow(44001).waitFor(); await qa('release', 'runtimeServices', 'A'); assert.equal(await serviceRow(43001).count(), 0); assert.equal(await serviceRow(44001).count(), 1);
  await stop(44001).click(); await confirm().waitFor(); const beforeConfirmSwitch = await stopCount(); await switchScope('perf-0'); await serviceRow(43001).waitFor(); await confirm().waitFor({ state: 'detached' }); assert.equal(await stopCount(), beforeConfirmSwitch, 'unconfirmed old scope never sends stop');
  await qa('hold', 'runtimeServiceStop', 'A', '41001'); await qa('fail', 'runtimeServiceStop', 'A', '41001'); await stop(43001).click();
  assert.match(await confirm().innerText(), /43001、43002/); await confirm().getByRole('button', { name: '终止服务', exact: true }).click(); await pending('runtimeServiceStop', 'A', '41001');
  await switchScope('perf-1'); await serviceRow(44001).waitFor(); const bScans = await scanCount('B'); await qa('release', 'runtimeServiceStop', 'A', '41001'); assert.equal(await services().getByRole('alert').count(), 0); assert.equal(await scanCount('B'), bScans, 'old stop rejection must not refresh new scope');
  await qa('fail', 'runtimeServiceStop', 'B', '42001'); await stop(44001).click(); await confirm().getByRole('button', { name: '终止服务', exact: true }).click(); await services().getByRole('button', { name: '重新终止', exact: true }).waitFor();
  await services().getByRole('button', { name: '刷新运行服务', exact: true }).click(); await serviceRow(44001).waitFor(); await settle(); assert.equal(await services().getByRole('button', { name: '重新终止', exact: true }).count(), 1, 'successful scan cannot erase stop error');
  await switchScope('perf-0'); await serviceRow(43001).waitFor();
  await qa('hold', 'runtimeServices', 'A'); await services().getByRole('button', { name: '刷新运行服务', exact: true }).click(); await pending('runtimeServices', 'A');
  await stop(43001).click(); await confirm().getByRole('button', { name: '终止服务', exact: true }).click();
  await page.waitForFunction(() => window.__resourceDetailsQa.pending('runtimeServices', 'A') >= 2); await qa('release', 'runtimeServices', 'A');
  await serviceRow(43001).waitFor({ state: 'detached' }); assert.equal(await serviceRow(43002).count(), 0, 'pre-stop scan cannot resurrect either port owned by stopped PID');
  await qa('visibility', true); const hiddenCount = await scanCount('A'); await page.waitForTimeout(2700); assert.equal(await scanCount('A'), hiddenCount, 'hidden document stops polling');
  await qa('visibility', false); await page.waitForFunction(count => window.__resourceDetailsQa.calls.filter(call => call.method === 'runtimeServices' && call.scope === 'A').length > count, hiddenCount);
  const payloads = await page.evaluate(() => window.__resourceDetailsQa.calls.filter(call => call.method === 'runtimeServiceStopPayload'));
  assert.ok(payloads.length >= 3 && payloads.every(payload => payload.startedAt === 1780000000000 + payload.pid), 'stop always retains captured PID identity timestamp');
  // Fill the popup with fixture-only listeners and verify actions at the end of
  // the list without opening external pages or writing to the system clipboard.
  await page.evaluate(() => {
    const scan = window.piApi.runtimeServices;
    const actions = window.__serviceActionsQa = { opened: [], copied: [] };
    window.piApi.openExternal = async url => { actions.opened.push(url); };
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async url => { actions.copied.push(url); } });
    window.piApi.runtimeServices = async input => {
      const snapshot = await scan(input);
      const sample = snapshot.services[0];
      const services = Array.from({ length: 32 }, (_, index) => {
        const port = 47000 + index;
        return { ...sample, id: String(port), port, url: `http://localhost:${port}`, ownership: 'other' };
      });
      return { ...snapshot, services, summary: { agent: 0, workspace: 0, related: 0, other: services.length, total: services.length } };
    };
  });
  await services().getByRole('button', { name: '刷新运行服务' }).click();
  const allServices = services().getByRole('button', { name: /^本机全部/ });
  await allServices.getByText('32').waitFor();
  await allServices.click();
  const list = services().locator('.runtime-services-list');
  assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight), 'long service list scrolls inside the popup');
  const last = serviceRow(47031);
  await last.getByRole('button', { name: '在浏览器打开 http://localhost:47031' }).click();
  await last.getByRole('button', { name: '复制 http://localhost:47031' }).click();
  assert.deepEqual(await page.evaluate(() => window.__serviceActionsQa), {
    opened: ['http://localhost:47031'], copied: ['http://localhost:47031'],
  });
  assert.equal(await composerValue(composer()), draft);
  const desktop = { width: 980, height: 760 };
  const short = { width: 980, height: 480 };
  const longListBounds = await services().boundingBox();
  assert.ok(longListBounds.height >= 448, 'preserve the expanded long-list height');
  await qa('hold', 'runtimeServices', 'B');
  await switchScope('perf-1');
  const loading = services().getByRole('status').filter({ hasText: '正在读取运行服务…' });
  await loading.locator('.loading-pi').waitFor();
  assert.deepEqual(await services().boundingBox(), longListBounds, 'initial scan keeps the full panel bounds');
  await qa('release', 'runtimeServices', 'B');
  const empty = services().getByText('暂无相关服务', { exact: true });
  await empty.waitFor();
  assert.deepEqual(await services().boundingBox(), longListBounds, 'empty filter keeps the full panel bounds');
  await capture('10-services-empty', 'dark', desktop, '.runtime-status-popover');
  await allServices.click();
  await last.waitFor();
  assert.deepEqual(await services().boundingBox(), longListBounds, 'switching to all services leaves heading and filter in place');
  await capture('11-services-all', 'dark', desktop, '.runtime-status-popover');
  await capture('12-services-short', 'light', short, '.runtime-status-popover');
  const shortBounds = await services().boundingBox();
  assert.ok(shortBounds.y >= 8 && shortBounds.height < longListBounds.height);
  assert.ok(shortBounds.y + shortBounds.height <= (await trigger.boundingBox()).y);
  const toolbar = services().locator('.runtime-services-toolbar');
  const toolbarBounds = await toolbar.boundingBox();
  await last.scrollIntoViewIfNeeded();
  assert.ok(await list.evaluate(node => node.scrollTop > 0));
  assert.deepEqual(await toolbar.boundingBox(), toolbarBounds, 'short-window scrolling keeps filter controls visible');
  await services().getByRole('button', { name: /^相关服务/ }).click();
  await empty.waitFor();
  assert.deepEqual(await services().boundingBox(), shortBounds, 'short-window empty and full bounds match');
  result.checks.push('initial scan, empty filter, and 32 services share the same anchored bounds; short windows shrink the popover and scroll only the list');
  result.checks.push('synthetic runtime scope A/B held scan isolation, first failure vs stale projection retry, filters, outside/multiport confirmation, pre-confirm scope invalidation, late stop rejection isolation, stop error survives scans, pre-stop read cannot resurrect rows, hidden poll pauses/visible refresh, PID timestamp contract');
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedRequests, []);
  result.calls = await page.evaluate(() => window.__resourceDetailsQa.calls); assert.equal(result.calls.some(call => call.method === 'conversationSubmit'), false);
  result.passed = true; await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.failure = String(error.stack || error); if (page) { result.calls = await page.evaluate(() => window.__resourceDetailsQa?.calls).catch(() => []); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); } throw error; }
finally { await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); await browser?.close(); await server.close(); }
console.log(JSON.stringify({ output, checks: result.checks, screenshots: result.screenshots }, null, 2));
