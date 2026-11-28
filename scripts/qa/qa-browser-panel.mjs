/** Real Electron guest QA; disposable userData and loopback HTTP only. Build first. */
import { hideToolPanel, openToolPanel } from './fixtures/tool-panel.mjs';
import { configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
const root = fileURLToPath(new URL('../..', import.meta.url)); const output = path.join(root, '.qa/browser-panel'); await mkdir(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'pi-studio-browser-qa-'));
const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-studio-browser-workspace-')));
const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') }; delete env.ELECTRON_RUN_AS_NODE; delete env.PI_STUDIO_DEV;
const result = { checks: [], errors: [], requests: [], assets: (await readFile(path.join(root, 'dist/renderer/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g) };
let heldResponse;
const server = createServer((request, response) => {
  result.requests.push(request.url);
  if (request.url === '/slow') { heldResponse = response; return; }
  if (request.url === '/missing-fixture.json') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const probe = request.url === '/first' ? '<script>console.warn("browser-qa warning"); console.error("browser-qa startup error"); fetch("/missing-fixture.json");</script>' : '';
  response.end(`<!doctype html><title>Pi Browser QA ${request.url}</title>${probe}<style>body{margin:16px;background:#fff;color:#222;font:14px system-ui}h1{font-size:18px;overflow-wrap:anywhere}iframe{display:block;box-sizing:border-box;width:100%;height:130px;margin-top:16px;border:1px solid #aaa}</style><h1 id="probe">Local browser lifecycle fixture</h1><a id="next" href="/second">Next</a>${request.url === '/frame' ? '' : '<iframe id="frame" src="/frame"></iframe>'}`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
let app; let page; let main;
const address = () => page.getByRole('textbox', { name: '浏览器地址', exact: true });
async function navigate(url) {
  const field = address();
  await field.focus();
  await field.fill(url);
  assert.equal(await field.inputValue(), url);
  await field.press('Enter');
}
async function loaded(url) { await page.waitForFunction(expected => { try { const view = document.querySelector('webview'); return view?.getURL() === expected && !view.isLoading(); } catch { return false; } }, url); }
function readBrowserTool(conversationId, name, args) {
  return app.evaluate(async ({ app }, { conversationId, name, args }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { getDurableRuntime } = require('./electron/main/runtime/durable-runtime.cjs');
    const runtime = await getDurableRuntime();
    const extension = runtime.builtinExtensions.get('builtin:studio-browser-tools');
    const tool = extension.tools.find(item => item.name === name);
    const result = await tool.execute(args, { conversationId }, runtime.context);
    return result.details;
  }, { conversationId, name, args });
}
try {
  app = await _electron.launch({ args: [root, '--use-mock-keychain'], env }); main = await app.firstWindow();
  await main.getByRole('button', {name:'打开工具面板', exact:true}).waitFor();
  await configureTestModel(main, workspace, origin + '/v1');
  const sessionId = await main.evaluate(async cwd => (await window.piApi.createConversation({ cwd, title: '网页控制台验收' })).id, workspace);
  await selectTestSession(main, workspace, sessionId);
  await main.evaluate(() => window.piApi.browserSetPreferences({showFullUrl:true}));
  page = await openToolPanel(app, main); await page.emulateMedia({ reducedMotion: 'reduce' }); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(error.message));
  await page.getByRole('button', { name: '新浏览器标签页', exact: true }).click();
  await page.locator('webview').waitFor();
  const attributes = await page.locator('webview').evaluate(view => ({ partition: view.getAttribute('partition'), prefs: view.getAttribute('webpreferences'), popups: view.getAttribute('allowpopups') }));
  assert.equal(attributes.partition, 'persist:pi-browser'); assert.match(attributes.prefs, /nodeIntegration=no/); assert.equal(attributes.popups, 'false');
  await loaded('about:blank');
  await navigate(`${origin}/first`); await loaded(`${origin}/first`); assert.equal(await address().inputValue(), `${origin}/first`);
  const guestId = await page.locator('webview').evaluate(view => view.getWebContentsId());
  const consoleLogs = await readBrowserTool(sessionId, 'browser_console', { level: 'error', search: 'browser-qa' });
  assert.equal(consoleLogs.url, origin + '/first');
  assert.deepEqual(consoleLogs.entries.map(entry => entry.message), ['browser-qa startup error']);
  assert.ok(consoleLogs.entries[0].line > 0);
  assert.ok(consoleLogs.summary.warnings > 0);
  const failures = await readBrowserTool(sessionId, 'browser_network', { failedOnly: true, urlIncludes: '/missing-fixture.json' });
  assert.equal(failures.entries[0]?.statusCode, 404);
  result.checks.push('registered Agent tools capture early page errors and failed HTTP requests with DevTools closed');
  const devTools = pressed => page.getByRole('button', { name: '网页开发者工具', pressed });
  await devTools(false).click();
  await devTools(true).waitFor();
  const target = await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id);
    return { url: guest.devToolsWebContents.getURL(), hostOpen: guest.hostWebContents.isDevToolsOpened() };
  }, guestId);
  assert.match(target.url, /^devtools:/);
  assert.equal(target.hostOpen, false);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).closeDevTools(), guestId);
  await devTools(false).waitFor();
  await devTools(false).click();
  await devTools(true).click();
  await devTools(false).waitFor();
  result.checks.push('toolbar opens only the current guest’s native DevTools and tracks both native and toolbar close');
  assert.equal(await main.locator('webview').count(), 0);
  assert.equal(await page.locator('webview').evaluate(view => view.executeJavaScript('typeof window.piApi')), 'undefined');
  await page.getByRole('button', {name:'新建工具标签页'}).click();
  await page.getByRole('menuitem', {name:'新终端', exact:true}).click();
  await page.locator('.terminal-panel').waitFor();
  await page.getByRole('button', {name:/^Pi Browser QA/}).first().click();
  await loaded(origin + '/first');
  assert.equal(await page.locator('webview').evaluate(view => view.getWebContentsId()), guestId);
  result.checks.push('terminal and sandboxed browser tabs share an embedded floating panel and reuse the same guest');
  const initialOwner = await page.evaluate(async () => {
    const state = await window.toolWindowApi.state();
    return state.groups.find(group => group.context.key === state.key).context;
  });
  await main.evaluate(() => window.piApi.setToolWindowContext({key:'temporary:browser-qa', title:'QA 临时对话'}));
  await page.getByRole('button', {name:'新终端', exact:true}).waitFor();
  assert.equal(await page.locator('.tool-group:visible .tool-tab').count(), 0);
  await main.evaluate(initial => window.piApi.setToolWindowContext(initial), initialOwner);
  await page.locator('webview').waitFor();
  assert.equal(await page.locator('webview').evaluate(view => view.getWebContentsId()), guestId);
  result.checks.push('changing conversation hides every previous tool tab and restores the original guest when returning');
  await page.locator('webview').evaluate(view => view.executeJavaScript("document.getElementById('next').click()", true)); await loaded(`${origin}/second`); assert.equal(await address().inputValue(), `${origin}/second`);
  assert.equal((await readBrowserTool(sessionId, 'browser_console', { search: 'browser-qa' })).entries.length, 0);
  await page.locator('webview').evaluate(view => view.executeJavaScript("document.getElementById('frame').contentWindow.location.hash = 'frame-only'"));
  await page.waitForFunction(expected => document.querySelector('webview')?.getURL() === expected, `${origin}/second`);
  assert.equal(await address().inputValue(), `${origin}/second`, 'iframe in-page navigation cannot replace main URL');
  result.historyProbe = await page.locator('webview').evaluate(view => {
    const read = method => { try { return view[method](); } catch (cause) { return { error: String(cause) }; } };
    return { url: read('getURL'), back: read('canGoBack'), forward: read('canGoForward'), id: read('getWebContentsId'), src: view.getAttribute('src') };
  });
  result.mainHistory = await app.evaluate(({ webContents }, id) => { const guest = webContents.fromId(id); return { back: guest.navigationHistory.canGoBack(), activeIndex: guest.navigationHistory.getActiveIndex(), entries: guest.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title })) }; }, result.historyProbe.id);
  const back = page.getByRole('button', { name: '后退', exact: true });
  let index = result.mainHistory.activeIndex;
  while (result.mainHistory.entries[index]?.url === `${origin}/second`) {
    await back.click();
    // A same-document iframe entry has the same top-level URL. Let Chromium
    // commit that entry before issuing the next Back action.
    index = await app.evaluate(async ({ webContents }, { id, before }) => {
      const history = webContents.fromId(id).navigationHistory;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const current = history.getActiveIndex();
        if (current < before) return current;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Browser history did not move back from entry ${before}`);
    }, { id: guestId, before: index });
  }
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
  await hideToolPanel(main, page);
  assert.equal(await openToolPanel(app, main), page);
  assert.equal(await page.locator('webview').evaluate(view => view.getWebContentsId()), guestId);
  await loaded(`${origin}/recovered`);
  await address().focus();
  assert.equal(await address().inputValue(), `${origin}/recovered`);
  await address().blur();
  result.checks.push('collapse/reopen preserves stored browser tab URL; main-process guard refuses non-http guest request');
  await page.screenshot({ path: path.join(output, 'browser-light.png'), animations: 'disabled' }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: path.join(output, 'browser-dark.png'), animations: 'disabled' });
  await app.close(); app = await _electron.launch({ args: [root, '--use-mock-keychain'], env }); main = await app.firstWindow();
  page = await openToolPanel(app, main);
  await loaded(origin + '/recovered');
  assert.equal(await page.locator('.tool-tab').count(), 2);
  assert.equal(await page.locator('.terminal-panel').count(), 0);
  result.checks.push('restart restores both tool tabs and last browser URL without starting the inactive terminal');
  assert.deepEqual(result.errors, []); await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) { result.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`); heldResponse?.end(); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
console.log(JSON.stringify({ output, checks: result.checks, errors: result.errors }, null, 2));
