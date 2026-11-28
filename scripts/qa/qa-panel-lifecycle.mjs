/** Source-level lifecycle QA. Browser guest is a test element; real guest QA is separate. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../..', import.meta.url)); const output = path.join(root, '.qa/panel-lifecycle'); await mkdir(output, { recursive: true });
const result = { checks: [], errors: [] }; let browser;
const server = await createServer({ configFile: false, root, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'qa-panel-fixture', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<html data-theme="light"><div id="root"></div><script type="module" src="/scripts/qa/fixtures/panel-lifecycle.tsx"></script></html>'); }); } }] }); await server.listen();
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 980, height: 640 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(8000); page.on('pageerror', error => result.errors.push(error.message));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const focusIs = async locator => assert.equal(await locator.evaluate(node => node === document.activeElement), true);
  await page.goto(server.resolvedUrls.local[0], { timeout: 60000, waitUntil: 'domcontentloaded' }); await page.locator('webview').waitFor({state:'attached'});
  const emit = (type, properties = {}) => page.locator('webview').evaluate((node, { type, properties }) => { const event = new Event(type); Object.assign(event, properties); node.dispatchEvent(event); }, { type, properties });
  assert.equal(await page.getByRole('button', { name: '刷新', exact: true }).isDisabled(), true); await emit('dom-ready');
  await emit('did-navigate', { url: 'http://127.0.0.1:9999/internal' }); await settle(); assert.deepEqual(await page.evaluate(() => window.__panelQa.loads), []);
  await emit('did-navigate-in-page', { url: 'http://127.0.0.1:9999/frame#ignored', isMainFrame: false }); assert.equal(await page.getByRole('textbox', { name: '浏览器地址', exact: true }).inputValue(), 'http://127.0.0.1:9999/internal');
  await emit('did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true }); assert.equal(await page.locator('.browser-failure').count(), 0);
  const address = page.getByRole('textbox', {name: '浏览器地址'});
  await address.fill('http://127.0.0.1:9999/external'); await address.press('Enter'); await settle(); assert.deepEqual(await page.evaluate(() => window.__panelQa.loads), ['http://127.0.0.1:9999/external']);
  const adds = await page.evaluate(() => window.__panelQa.additions); await page.getByRole('button', { name: '刷新父组件', exact: true }).click(); assert.equal(await page.evaluate(() => window.__panelQa.additions), adds);
  await emit('did-fail-load', { errorCode: -2, errorDescription: 'QA failure', isMainFrame: true }); await page.getByText('QA failure', { exact: true }).waitFor();
  await page.getByRole('button', { name: '切换浏览器挂载', exact: true }).click(); assert.equal(await page.evaluate(() => window.__panelQa.additions - window.__panelQa.removals), 0);
  result.checks.push('guest internal navigation stays internal, iframe and aborted events ignored, async load rejection consumed, parent rerender never reattaches listeners, unmount removes all listeners');
  await page.getByRole('button', { name: '切换终端挂载', exact: true }).click(); await page.waitForFunction(() => window.__panelQa.terminalPending.length === 1);
  assert.equal(await page.evaluate(() => window.__panelQa.terminalResizes.length), 0, 'no resize before synthetic terminal exists');
  await page.evaluate(() => window.__panelQa.rejectTerminal()); await page.locator('.terminal-error').waitFor();
  await page.getByRole('button', { name: '重新连接终端', exact: true }).click(); await page.waitForFunction(() => window.__panelQa.terminalPending.length === 1); await page.locator('.terminal-error').waitFor({ state: 'detached' });
  const typing = page.getByRole('textbox', { name: '其他输入', exact: true }); await typing.fill('保留我正在输入的内容'); await page.evaluate(() => window.__panelQa.resolveTerminal());
  await page.waitForFunction(() => document.querySelector('.terminal-live-state')?.textContent === '运行中'); await focusIs(typing); assert.equal(await typing.inputValue(), '保留我正在输入的内容');
  await page.waitForFunction(() => window.__panelQa.terminalResizes.length > 0);
  await page.getByRole('button', { name: '切换终端挂载', exact: true }).click(); assert.equal(await page.evaluate(() => window.__panelQa.terminalEvents.size), 0); assert.equal(await page.evaluate(() => window.__panelQa.terminalClosed), 0, 'renderer unmount must not kill PTY');
  result.checks.push('real xterm: pending creation never resizes nonexistent terminal, header retry clears old error, late create preserves active typing focus, unmount unsubscribes without closing PTY');
  assert.deepEqual(result.errors, []); await page.screenshot({ path: path.join(output, 'panel.png') });
} finally { await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); await browser?.close(); await server.close(); }
console.log(JSON.stringify(result, null, 2));
