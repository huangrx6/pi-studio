/** Install the released plugin shape and exercise the native canvas through Electron and Durable. */
import { checkPluginTheme, getToolPanel, hideToolPanel, openPluginCatalog, openPluginTool } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop, configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
import { composerValue } from './fixtures/composer-editor.mjs';

const output = fileURLToPath(new URL('../../.qa/excalidraw-plugin/', import.meta.url));
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-excalidraw-qa-')));
const profile = path.join(scratch, 'profile');
const workspace = path.join(scratch, 'workspace');
const sourceId = 'user:studio.excalidraw/scene';
const packagedApp = process.env.PI_STUDIO_PACKAGED_APP;
const archive = process.env.PI_STUDIO_QA_PLUGIN_ARCHIVE;
const development = !packagedApp && process.env.PI_STUDIO_QA_DEV === '1';
const executablePath = packagedApp?.endsWith('.app') ? path.join(packagedApp, 'Contents', 'MacOS', 'Pi Studio') : packagedApp;
const launch = () => launchTestDesktop(workspace, profile, 1450, 950, {
  executablePath,
  development,
  extraArgs: packagedApp ? ['--proxy-server=http://127.0.0.1:9'] : [],
});
await Promise.all([output, profile, workspace].map(directory => mkdir(directory, { recursive: true })));

const spec = JSON.parse(await readFile(new URL(
  '../../assets/official-plugins/packages/excalidraw/extension/skills/diagram-authoring/examples/flow/source.diagram.json',
  import.meta.url,
), 'utf8'));
let offeredTools = [];
let receivedPluginContext = false;
let drawResult;
const model = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  offeredTools = input.tools?.map(tool => tool.function?.name) || [];
  const userText = input.messages.filter(message => message.role === 'user')
    .flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content || []).map(part => part.text || ''))
    .join('\n');
  receivedPluginContext ||= userText.includes('"plugin":"Excalidraw"')
    && userText.includes('"tool":"excalidraw_draw"') && userText.includes('excalidraw_draw');
  drawResult = input.messages.findLast(message => message.role === 'tool')?.content ?? drawResult;
  const calls = !input.messages.some(message => message.role === 'tool') && offeredTools.includes('excalidraw_draw') && receivedPluginContext;
  const delta = calls ? {
    tool_calls: [{ index: 0, id: 'qa-draw', type: 'function',
      function: { name: 'excalidraw_draw', arguments: JSON.stringify({ spec }) } }],
  } : { content: '绘图验收结束。' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish_reason) => response.write('data: ' + JSON.stringify({
    id: 'qa-excalidraw', object: 'chat.completion.chunk', created: 1, model: 'check',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n');
  event({ role: 'assistant', ...delta }, null);
  event({}, calls ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => model.once('error', reject).listen(0, '127.0.0.1', resolve));

let app;
let page;
const errors = [];

async function downloadTo(app, button, filename) {
  await app.evaluate(({ BrowserWindow }, destination) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session;
    globalThis.canvasDownload = new Promise(resolve => session.once('will-download', (_event, item) => {
      item.setSavePath(destination);
      item.once('done', (_event, status) => resolve(status));
    }));
  }, filename);
  await button.click();
  const status = await app.evaluate(() => Promise.race([
    globalThis.canvasDownload,
    new Promise(resolve => setTimeout(() => resolve('timeout'), 5_000)),
  ]));
  assert.equal(status, 'completed');
}

async function readScene(id) {
  return page.evaluate(async ({ id, cwd, sourceId }) => {
    const api = window.piApi;
    const view = await api.openExtensionDataView({ sourceId, cwd, sessionId: id });
    try { return view.snapshot.viewData; }
    finally { await api.closeExtensionDataView(view.subscriptionId); }
  }, { id, cwd: workspace, sourceId });
}

try {
  ({ app, page } = await launch());
  if (packagedApp) {
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.version);
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Excalidraw|excalidraw-assets|mermaid|Content Security Policy/i.test(message.text())) {
      errors.push(message.text().split('\n')[0]);
    }
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.piApi.waitForStartup());
  await configureTestModel(page, workspace, `http://127.0.0.1:${model.address().port}/v1`);
  const market = await page.evaluate(() => window.piApi.pluginMarket());
  assert.ok(market.plugins.some(plugin => plugin.id === 'studio.excalidraw'));
  if (archive) {
    const installed = await page.evaluate(async ({ source, cwd }) => {
      const preview = await window.piApi.preparePluginInstall({ source });
      return window.piApi.installPlugin({ cwd, token: preview.token });
    }, { source: path.resolve(archive), cwd: workspace });
    assert.equal(installed.plugin.id, 'studio.excalidraw');
    assert.deepEqual(installed.installed.skills.map(skill => skill.name), ['diagram-authoring']);
  } else {
    await openPluginCatalog(page);
    await page.getByRole('button', { name: '安装 Excalidraw', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '安装预览', exact: true });
    await preview.getByRole('heading', { name: 'Excalidraw', exact: true }).waitFor();
    await preview.getByText('diagram-authoring', { exact: true }).waitFor();
    await preview.getByRole('button', { name: '确认安装', exact: true }).click();
    await preview.waitFor({ state: 'detached' });
    await page.getByRole('dialog', { name: '插件 Excalidraw', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '对话', exact: true }).click();
    await page.locator('.composer-editor:visible').waitFor();
  }

  const ids = await page.evaluate(async cwd => {
    const api = window.piApi;
    const first = await api.createConversation({ cwd, title: '绘图会话' });
    const second = await api.createConversation({ cwd, title: '独立画布' });
    return { first: first.id, second: second.id };
  }, workspace);
  await page.reload();
  await selectTestSession(page, workspace, ids.first);
  const tool = await openPluginTool(app, page, 'Excalidraw');
  await tool.frame.locator('.ex-empty').waitFor();
  await checkPluginTheme(tool.page, tool.frame, [
    ['body', '--surface-canvas'], ['.ex-toolbar', '--surface-chrome'], ['.excalidraw .Island', '--surface-raised'],
  ], output);
  await tool.page.getByRole('button', { name: '关闭 Excalidraw' }).click();
  await hideToolPanel(page, tool.page);
  await page.evaluate(() => {
    window.piApi.onExtensionPanelRequested(event => { window.canvasReveal = event; });
  });
  const input = page.locator('.composer-editor');
  await input.fill('$');
  const categories = page.getByRole('listbox', { name: '引用类别' });
  assert.deepEqual(await categories.getByRole('option').allTextContents(), ['技能', 'MCP', '插件']);
  await categories.getByRole('option', { name: '插件', exact: true }).click();
  const candidate = page.getByRole('option').filter({ hasText: 'Excalidraw' });
  await candidate.locator('img').waitFor();
  await page.locator('.composer-picker').screenshot({ path: path.join(output, 'plugin-reference.png') });
  await candidate.click();
  await input.locator('.ref-chip.is-plugin').filter({ hasText: 'Excalidraw' }).waitFor();
  const request = '在工具面板画一个库存校验流程图，沿用示例配色和图标。';
  const reference = '$[plugin:studio.excalidraw|Excalidraw] ';
  assert.equal(await composerValue(input), reference);
  await page.keyboard.insertText(request);
  assert.equal(await composerValue(input), reference + request);
  await input.press('Enter');

  await page.getByRole('dialog', { name: '工具调用', exact: true })
    .getByRole('button', { name: '允许', exact: true }).click();
  const submitted = page.locator('.user-message .user-text').filter({ hasText: request });
  await submitted.locator('.ref-chip.is-plugin').filter({ hasText: 'Excalidraw' }).waitFor();
  assert.equal(await submitted.textContent(), 'Excalidraw ' + request);
  await tool.frame.locator('button[aria-label=适应画布]:enabled').waitFor({ timeout: 20000 });
  const scene = await readScene(ids.first);
  assert.ok(scene.scene.elements.length > 0);
  assert.equal(scene.revision, 1);
  assert.equal(scene.drawing, false);
  assert.equal(scene.playback, undefined);
  assert.equal((await readScene(ids.second)).scene.elements.length, 0);
  assert.ok(offeredTools.includes('excalidraw_draw') && receivedPluginContext);
  await tool.page.screenshot({ path: path.join(output, 'tool-window.png'), scale: 'css' });
  const destination = path.join(scratch, 'exported.excalidraw');
  await downloadTo(app, tool.frame.getByRole('button', { name: '导出 Excalidraw 文件' }), destination);
  const exported = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(exported.type, 'excalidraw');
  assert.equal(exported.elements.length, scene.scene.elements.length);
  await tool.frame.getByRole('button', { name: '切换画板外观' }).click();
  await tool.frame.getByRole('button', { name: '从 Mermaid 导入' }).click();
  const conversion = tool.frame.locator('.ttd-dialog');
  await conversion.getByRole('textbox').filter({ visible: true }).fill('flowchart LR\n A[稿件] --> B[校对]');
  await conversion.locator('.ttd-dialog-output-canvas-container canvas').waitFor();
  await conversion.getByRole('button', { name: /插入|Insert/ }).first().click();
  await tool.frame.getByRole('button', { name: '新建空白画布' }).click();
  await tool.frame.locator('.ex-empty').waitFor();
  await tool.frame.locator('input[type=file]').setInputFiles(process.env.PI_STUDIO_QA_DIAGRAM || destination);
  await tool.frame.locator('.ex-empty').waitFor({ state: 'detached' });
  await tool.frame.locator('button[aria-label=适应画布]:enabled').waitFor();
  const restored = await readScene(ids.first);
  assert.ok(restored.scene.elements.length > 0);
  assert.ok(restored.boards.length >= 2);
  await hideToolPanel(page, tool.page);
  await selectTestSession(page, workspace, ids.second);
  const second = await openPluginTool(app, page, 'Excalidraw');
  await second.frame.locator('.ex-empty').waitFor();
  assert.equal((await readScene(ids.second)).scene.elements.length, 0);
  await app.close();
  ({ app, page } = await launch());
  await selectTestSession(page, workspace, ids.first);
  const reopened = await openPluginTool(app, page, 'Excalidraw');
  await reopened.frame.locator('.excalidraw canvas').first().waitFor();
  assert.equal((await readScene(ids.first)).boardId, restored.boardId);
  assert.deepEqual(errors, []);
  console.log('Verified plugin install, live drawing, embedded tool panel, Mermaid, import/export, isolated sessions and restart.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error('Tool result:', JSON.stringify(drawResult)?.slice(0, 700), 'Reveal:', await page?.evaluate(() => window.canvasReveal));
  const pane = app && page && await page.evaluate(() => window.piApi.toolWindowVisible()).catch(() => false)
    ? await getToolPanel(app, page).catch(() => null) : null;
  if (pane) {
    console.error('Tool window:', (await pane.locator('body').innerText()).slice(0, 500), pane.frames().map(frame => frame.url()));
    await pane.screenshot({ path: path.join(output, 'tool-window-failure.png') }).catch(() => {});
  }
  console.error('Model offered:', offeredTools, 'Received plugin context:', receivedPluginContext);
  if (errors.length) console.error('Renderer errors:', [...new Set(errors)].slice(0, 6));
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  await rm(scratch, { recursive: true, force: true });
}
