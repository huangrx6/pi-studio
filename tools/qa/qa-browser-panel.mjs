/** Real Electron guest QA; disposable userData and loopback HTTP only. Build first. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
const root = fileURLToPath(new URL('../..', import.meta.url)); const output = path.join(root, '.qa/browser-panel'); await mkdir(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'pi-studio-browser-qa-'));
const workspace = mkdtempSync(path.join(tmpdir(), 'pi-studio-browser-workspace-'));
const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') }; delete env.ELECTRON_RUN_AS_NODE; delete env.PI_STUDIO_DEV;
const result = { checks: [], errors: [], requests: [], assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
let heldResponse;
const server = createServer((request, response) => {
  result.requests.push(request.url);
  if (request.url === '/slow') { heldResponse = response; return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Pi Browser QA ${request.url}</title><style>body{margin:16px;background:#fff;color:#222;font:14px system-ui}h1{font-size:18px;overflow-wrap:anywhere}iframe{display:block;box-sizing:border-box;width:100%;height:130px;margin-top:16px;border:1px solid #aaa}</style><h1 id="probe">Local browser lifecycle fixture</h1><a id="next" href="/second">Next</a>${request.url === '/frame' ? '' : '<iframe id="frame" src="/frame"></iframe>'}`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
let app; let page;
const address = () => page.getByRole('textbox', { name: '浏览器地址', exact: true });
async function navigate(url) { await address().fill(url); await address().press('Enter'); }
async function loaded(url) { await page.waitForFunction(expected => { try { const view = document.querySelector('webview'); return view?.getURL() === expected && !view.isLoading(); } catch { return false; } }, url); }
try {
  app = await _electron.launch({ args: [root], env }); page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(980, 640); });
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click(); await page.locator('.panel-start-tools').getByRole('button', { name: '浏览器', exact: true }).click(); await page.locator('webview').waitFor();
  const attributes = await page.locator('webview').evaluate(view => ({ partition: view.getAttribute('partition'), prefs: view.getAttribute('webpreferences'), popups: view.getAttribute('allowpopups') }));
  assert.equal(attributes.partition, 'persist:pi-browser'); assert.match(attributes.prefs, /nodeIntegration=no/); assert.equal(attributes.popups, 'false');
  await navigate(`${origin}/first`); await loaded(`${origin}/first`); assert.equal(await address().inputValue(), `${origin}/first`);
  await page.locator('webview').evaluate(view => view.executeJavaScript("document.getElementById('next').click()", true)); await loaded(`${origin}/second`); assert.equal(await address().inputValue(), `${origin}/second`);
  await page.locator('webview').evaluate(view => view.executeJavaScript("document.getElementById('frame').contentWindow.location.hash = 'frame-only'"));
  await page.waitForFunction(expected => document.querySelector('webview')?.getURL() === expected, `${origin}/second`);
  assert.equal(await address().inputValue(), `${origin}/second`, 'iframe in-page navigation cannot replace main URL');
  result.historyProbe = await page.locator('webview').evaluate(view => {
    const read = method => { try { return view[method](); } catch (cause) { return { error: String(cause) }; } };
    return { url: read('getURL'), back: read('canGoBack'), forward: read('canGoForward'), id: read('getWebContentsId'), src: view.getAttribute('src') };
  });
  result.mainHistory = await app.evaluate(({ webContents }, id) => { const guest = webContents.fromId(id); return { back: guest.navigationHistory.canGoBack(), activeIndex: guest.navigationHistory.getActiveIndex(), entries: guest.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title })) }; }, result.historyProbe.id);
  await page.getByRole('button', { name: '后退', exact: true }).click();
  // The frame hash can consume one history entry. A second Back reaches /first.
  await page.waitForTimeout(150); if (await address().inputValue() === `${origin}/second`) await page.getByRole('button', { name: '后退', exact: true }).click();
  await loaded(`${origin}/first`); await page.getByRole('button', { name: '前进', exact: true }).click(); await loaded(`${origin}/second`);
  result.checks.push('real isolated webview main navigation/back/forward and iframe hash cannot corrupt main address');
  await navigate(`${origin}/slow`); await page.waitForFunction(() => document.querySelector('webview')?.isLoading());
  await navigate(`${origin}/fast`); await loaded(`${origin}/fast`); heldResponse?.end('late response');
  assert.equal(await page.locator('.browser-failure').count(), 0, 'superseded ERR_ABORTED is not a page failure');
  await navigate(`https://127.0.0.1:${server.address().port}/expected-tls-failure`); await page.locator('.browser-failure').waitFor();
  await navigate(`${origin}/recovered`); await loaded(`${origin}/recovered`); assert.equal(await page.locator('.browser-failure').count(), 0);
  for (let index = 0; index < 3; index++) { await page.getByRole('button', { name: '刷新', exact: true }).click(); await loaded(`${origin}/recovered`); }
  result.checks.push('slow navigation superseded without aborted warning; real TLS rejection is handled and retry clears visible failure');
  await page.locator('webview').evaluate(async view => { try { await view.loadURL('file:///qa/synthetic-forbidden-browser-target.txt'); } catch {} });
  assert.equal(await page.locator('webview').evaluate(view => view.getURL()), `${origin}/recovered`, 'non-http request refused');
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click(); await page.locator('webview').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click(); await loaded(`${origin}/recovered`); assert.equal(await address().inputValue(), `${origin}/recovered`);
  result.checks.push('collapse/reopen preserves stored browser tab URL; main-process guard refuses non-http guest request');
  await page.screenshot({ path: path.join(output, 'browser-light.png'), animations: 'disabled' }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: path.join(output, 'browser-dark.png'), animations: 'disabled' });
  assert.deepEqual(result.errors, []); await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`); heldResponse?.end(); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
console.log(JSON.stringify({ output, checks: result.checks, errors: result.errors }, null, 2));
