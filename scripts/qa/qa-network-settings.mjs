/** Real Electron networking and settings UI; isolated data, synthetic model traffic. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop, configureTestModel } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/network-settings');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace);
const result = { checks: [], pageErrors: [], publicProbe: null };
const requests = [];
const proxy = http.createServer(async (request, response) => {
  let body = '';
  for await (const part of request) body += part;
  requests.push({ url: request.url, method: request.method, hasAuthorization: Boolean(request.headers.authorization), bodyLength: body.length });
  if (request.url.endsWith('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ id: 'proxy-qa', object: 'chat.completion.chunk', model: 'check', choices: [{ index: 0, delta: { role: 'assistant', content: '代理连接成功' }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'proxy-qa', object: 'chat.completion.chunk', model: 'check', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  } else if (request.url.endsWith('/slow')) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first');
    const timer = setTimeout(() => response.end('second'), 400);
    response.on('close', () => clearTimeout(timer));
  } else {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'check' }] }));
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
let app, page;
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(await page.locator('.network-settings, .network-card').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 2).map(node => node.className)), []);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
async function openNetwork() {
  if (!await page.locator('.settings-navigation').count()) await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '网络代理', exact: true }).click();
  await page.getByRole('button', { name: '重新识别', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.network-mode-fieldset')?.disabled);
}
try {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1180, 900));
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.evaluate(() => window.piApi.waitForStartup());
  await openNetwork();
  assert.equal(await page.getByRole('radio', { name: /跟随系统/ }).isChecked(), true);
  const detected = await page.locator('.network-route').innerText();
  result.checks.push('system proxy is detected: ' + detected);

  // Optional public endpoint check uses the user's system proxy, never a key.
  if (process.env.PI_STUDIO_QA_NETWORK_LIVE === '1') {
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor({ timeout: 20_000 });
    result.publicProbe = await page.getByRole('status').filter({ hasText: '连接成功' }).innerText();
  }
  await capture('system-light');
  await page.locator('.network-mode').filter({ hasText: '手动配置' }).click();
  assert.equal(await page.getByRole('radio', { name: /手动配置/ }).isChecked(), true);
  const address = page.getByRole('textbox', { name: '代理地址', exact: true });
  await address.fill('http://user:secret@localhost:7897');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '用户名或密码' }).waitFor();
  assert.equal((await page.evaluate(() => window.piApi.networkSettings())).mode, 'system');
  await address.fill(proxyUrl);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await page.evaluate(() => window.piApi.networkSettings())).proxyUrl, proxyUrl);
  result.checks.push('manual configuration validates credentials, saves and applies immediately');

  await configureTestModel(page, workspace, 'http://proxy-qa.invalid/v1');
  const completion = await app.evaluate(async (_electron, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const runtime = await require(`${root}/electron/main/core/studio-models.cjs`).getStudioModelsRuntime();
    const model = runtime.models.getModel('desktop-qa', 'check');
    const result = await runtime.models.completeSimple(model, { messages: [{ role: 'user', content: 'Synthetic QA request', timestamp: Date.now() }] }, { maxRetries: 0, timeoutMs: 5000 });
    return { stopReason: result.stopReason, errorMessage: result.errorMessage, text: result.content.filter(part => part.type === 'text').map(part => part.text).join('') };
  }, root);
  assert.equal(completion.stopReason, 'stop', completion.errorMessage);
  assert.equal(completion.text, '代理连接成功');
  assert.equal(requests.some(request => request.url === 'http://proxy-qa.invalid/v1/chat/completions' && request.hasAuthorization), true);
  result.checks.push('real pi-ai SDK streams through the configured HTTP proxy to an otherwise unresolvable model host');

  const streaming = await app.evaluate(async (_electron, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const network = require(`${root}/electron/main/services/network.cjs`).networkService();
    const response = await fetch('http://proxy-qa.invalid/slow');
    const body = response.text();
    await network.save({ mode: 'direct', proxyUrl: '', bypassRules: '' });
    return { text: await body, mode: (await network.snapshot()).mode };
  }, root);
  assert.deepEqual(streaming, { text: 'firstsecond', mode: 'direct' });
  result.checks.push('saving direct mode preserves an in-flight real Chromium response');

  await page.evaluate(proxyUrl => window.piApi.saveNetworkSettings({ mode: 'manual', proxyUrl, bypassRules: '' }), proxyUrl);
  const aborted = await app.evaluate(async () => {
    const controller = new AbortController();
    const response = await fetch('http://proxy-qa.invalid/slow', { signal: controller.signal });
    const body = response.text();
    controller.abort();
    try { await body; return false; } catch { return true; }
  });
  assert.equal(aborted, true);
  result.checks.push('cancellation interrupts the real response stream');

  await page.getByRole('textbox', { name: '不使用代理的地址', exact: true }).fill('*.local');
  await page.locator('.settings-navigation').getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('alertdialog', { name: '丢弃未保存的设置更改？' }).getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '不使用代理的地址', exact: true }).inputValue(), '*.local');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  result.checks.push('leaving a dirty page requires explicit discard and cancellation preserves the draft');

  await page.locator('.settings-navigation').getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await openNetwork();
  await capture('manual-dark');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 740));
  await capture('manual-narrow');
  assert.equal(await address.inputValue(), proxyUrl);
  await page.locator('.network-mode').filter({ hasText: '直接连接' }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await page.evaluate(() => window.piApi.networkSettings())).mode, 'direct');
  await app.close(); app = undefined;
  ({ app, page } = await launchTestDesktop(workspace, profile, 1180, 900));
  await page.evaluate(() => window.piApi.waitForStartup());
  assert.equal((await page.evaluate(() => window.piApi.networkSettings())).mode, 'direct');
  result.checks.push('direct mode persists across a full application restart');
  assert.deepEqual(result.pageErrors, []);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
}
