/** Install the released plugin shape and exercise the native canvas through Electron and Durable. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  '../../assets/official-plugins/packages/excalidraw/extension/skills/excalidraw-live-canvas/examples/flow/source.diagram.json',
  import.meta.url,
), 'utf8'));
let offeredTools = [];
let receivedPluginContext = false;
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
    && userText.includes('"tool":"excalidraw_draw"') && userText.includes('## 在 Pi Studio 侧栏绘制');
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

async function openCanvasFromMenu(page) {
  await page.getByRole('button', { name: '扩展', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '扩展', exact: true });
  await picker.getByText('实时画布', { exact: true }).waitFor();
  await picker.getByRole('button', { name: '查看 Excalidraw 详情', exact: true }).click();
}

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

async function checkPenMotion(page) {
  return page.evaluate(() => new Promise(resolve => {
    const positions = new Map();
    const observed = new Set();
    const diagnostics = {};
    const deadline = performance.now() + 9_000;
    function sample() {
      const pen = document.querySelector('.extension-canvas-pen:not([hidden])');
      const ink = document.querySelector('canvas.extension-canvas-ink');
      if (pen && ink) {
        const type = pen.dataset.elementType;
        const category = type === 'text' || type === 'arrow' ? type : 'outline';
        const last = positions.get(type);
        if (!observed.has(category) && last && last !== pen.style.transform) {
          const image = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height);
          if (image.data.some((value, index) => index % 4 === 3 && value > 0)) observed.add(category);
        }
        diagnostics[type] = [pen.style.transform, ink.width, ink.height, pen.getBoundingClientRect().left, pen.getBoundingClientRect().top];
        positions.set(type, pen.style.transform);
      }
      if (observed.size === 3 || performance.now() > deadline) resolve({ observed: [...observed].sort(), diagnostics });
      else requestAnimationFrame(sample);
    }
    sample();
  }));
}

async function checkImageExport(app, page, editor) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await editor.getByTestId('main-menu-trigger').click();
    await editor.getByTestId('image-export-button').click();
    const dialog = page.locator('.excalidraw-modal-container .Dialog').filter({ has: page.locator('.ImageExportModal') });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    await close.locator('svg').waitFor();
    assert.equal(await dialog.evaluate(node => node.closest('.excalidraw-modal-container').classList.contains('theme--dark')), theme === 'dark');
    const content = dialog.locator('.Modal__content');
    assert.equal(await content.evaluate(node => getComputedStyle(node).opacity), '1');
    const controls = await dialog.locator('.Switch input, .RadioGroup input').evaluateAll(inputs => inputs.map(input => ({
      background: getComputedStyle(input).backgroundColor,
      border: getComputedStyle(input).borderTopWidth,
      checkmark: getComputedStyle(input, '::after').content,
    })));
    assert.equal(controls.length, 6);
    assert.ok(controls.every(({ background, border, checkmark }) =>
      background === 'rgba(0, 0, 0, 0)' && border === '0px' && checkmark === 'none'), JSON.stringify(controls));
    const background = dialog.locator('#exportBackgroundSwitch');
    const wasChecked = await background.isChecked();
    await background.click();
    assert.equal(await background.isChecked(), !wasChecked);
    await dialog.locator('.RadioGroup__choice').filter({ hasText: /^2×$/ }).locator('input').check();
    await dialog.locator('.RadioGroup__choice.active').getByText('2×', { exact: true }).waitFor();
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.ok(await close.evaluate(button => {
      const { top, bottom } = button.getBoundingClientRect();
      const viewport = button.closest('.Modal__content').getBoundingClientRect();
      return top >= viewport.top && bottom <= viewport.bottom;
    }), 'the close button remains visible when the export settings are scrolled into view');
    await content.screenshot({
      path: path.join(output, `image-export-${theme}.png`), scale: 'css', animations: 'disabled',
    });
    if (theme === 'dark') {
      const destination = path.join(scratch, 'exported.png');
      await downloadTo(app, dialog.getByRole('button', { name: '导出为 PNG', exact: true }), destination);
      assert.deepEqual((await readFile(destination)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    await close.click();
    await dialog.waitFor({ state: 'hidden' });
  }
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
    assert.equal(installed.plugin.version, '1.1.0');
    assert.deepEqual(installed.installed.skills.map(skill => skill.name), ['excalidraw-live-canvas']);
  } else {
    await page.locator('.sidebar-bottom button[title="设置"]').click();
    await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('tab', { name: '插件', exact: true }).click();
    await page.getByRole('button', { name: '安装 Excalidraw', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '安装预览', exact: true });
    await preview.getByRole('heading', { name: 'Excalidraw', exact: true }).waitFor();
    await preview.getByText('excalidraw-live-canvas', { exact: true }).waitFor();
    await preview.getByRole('button', { name: '确认安装', exact: true }).click();
    await preview.waitFor({ state: 'detached' });
  }

  const ids = await page.evaluate(async cwd => {
    const api = window.piApi;
    const first = await api.createConversation({ cwd, title: '绘图会话' });
    const second = await api.createConversation({ cwd, title: '独立画布' });
    return { first: first.id, second: second.id };
  }, workspace);
  // Use the file download path in QA so the platform save picker stays closed.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker');
    Reflect.deleteProperty(Window.prototype, 'showOpenFilePicker');
  });
  await page.reload();
  await selectTestSession(page, workspace, ids.first);
  const layer = page.getByRole('tabpanel', { name: 'Excalidraw', exact: true });
  const surface = layer.locator('.extension-drawing-board');
  const editor = surface.locator('.excalidraw');
  const tab = page.locator('.panel-tabbar').getByRole('tab', { name: 'Excalidraw', exact: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  if (!archive) {
    await openCanvasFromMenu(page);
    await editor.locator('canvas').first().waitFor({ timeout: 20000 });
    await surface.getByText('画布是空的', { exact: true }).waitFor();
    await tab.locator('.panel-tab-close').click();
  }
  await page.locator('.composer-editor').waitFor();
  await layer.waitFor({ state: 'hidden' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const samples = await page.evaluate(async ({ sourceId, cwd, id, second }) => {
    const api = window.piApi;
    window.excalidrawUpdates = [];
    window.excalidrawUnsubscribe = api.onExtensionDataView(event => {
      if (event.snapshot.sourceId === sourceId) window.excalidrawUpdates.push(event);
    });
    const one = await api.openExtensionDataView({ sourceId, cwd, sessionId: id });
    const two = await api.openExtensionDataView({ sourceId, cwd, sessionId: second });
    return { one: one.subscriptionId, two: two.subscriptionId };
  }, { sourceId, cwd: workspace, id: ids.first, second: ids.second });

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
  const request = '在侧栏画一个库存校验流程图，沿用示例配色和图标。';
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
  await surface.locator('.extension-canvas-status').getByText('正在绘制', { exact: true }).waitFor({ timeout: 15000 });
  await editor.locator('canvas').first().waitFor();
  await tab.locator('img').waitFor();
  assert.equal(await tab.locator('img').evaluate(image => image.naturalWidth), 128);
  const motions = checkPenMotion(page);
  await surface.locator('.extension-canvas-pen[data-element-type="text"]').waitFor();
  await surface.screenshot({ path: path.join(output, 'drawing.png'), scale: 'css' });
  const motion = await motions;
  assert.deepEqual(motion.observed, ['arrow', 'outline', 'text'], JSON.stringify(motion.diagnostics));
  await surface.locator('.extension-canvas-status').getByText('已保存到当前聊天', { exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const boardDirectory = path.join(profile, 'plugin-data', 'studio.excalidraw', 'studio.excalidraw');
  const boardFiles = await readdir(boardDirectory);
  assert.equal(boardFiles.length, 1);
  assert.match(boardFiles[0], /^\d+\.excalidraw\.json$/);
  const savedBoard = JSON.parse(await readFile(path.join(boardDirectory, boardFiles[0]), 'utf8'));
  assert.equal(savedBoard.revision, 1);
  assert.equal(savedBoard.scene.elements.length, 15);
  assert.equal(savedBoard.title, spec.title);
  assert.equal(savedBoard.playback, undefined);
  assert.ok(offeredTools.includes('excalidraw_draw'));
  const updates = await page.evaluate(({ one, two }) => {
    const series = id => window.excalidrawUpdates.filter(update => update.subscriptionId === id && update.snapshot.canvas)
      .map(({ snapshot: { canvas } }) => ({
        drawing: canvas.drawing, revision: canvas.revision, elements: canvas.scene.elements.length, playback: canvas.playback,
      }));
    return { one: series(one), two: series(two) };
  }, samples);
  const playback = updates.one.find(update => update.playback);
  assert.equal(playback?.playback.firstElement, 0, JSON.stringify(updates));
  assert.equal(playback.elements, savedBoard.scene.elements.length);
  assert.equal(updates.one.at(-1).revision, 1);
  assert.equal(updates.one.at(-1).drawing, false);
  assert.equal(updates.one.at(-1).elements, savedBoard.scene.elements.length);
  assert.ok(updates.two.every(update => update.elements === 0));
  await page.screenshot({ path: path.join(output, 'workspace.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const toolsInView = await editor.locator('.App-toolbar--mobile').evaluate(toolbar => {
    const width = toolbar.closest('.extension-canvas-editor').getBoundingClientRect();
    return [...toolbar.querySelectorAll('.ToolIcon__icon')].every(tool => {
      const bounds = tool.getBoundingClientRect();
      return bounds.width === 0 || (bounds.left >= width.left - .5 && bounds.right <= width.right + .5);
    });
  });
  assert.ok(toolsInView, 'native drawing tools fit in the narrow sidebar');
  await page.screenshot({ path: path.join(output, 'workspace-dark.png'), scale: 'css' });
  await checkImageExport(app, page, editor);

  await surface.getByRole('button', { name: '从 Mermaid 导入' }).click();
  const conversion = page.locator('.excalidraw-modal-container .ttd-dialog');
  const mermaid = conversion.getByRole('textbox').filter({ visible: true });
  await mermaid.fill('flowchart LR\n  A[稿件] --> B[校对]');
  await conversion.locator('.ttd-dialog-output-canvas-container canvas').waitFor();
  const insert = conversion.getByRole('button', { name: /插入|Insert/ }).first();
  await insert.click();
  await page.waitForFunction(({ id, count }) => window.excalidrawUpdates.some(update => update.subscriptionId === id
    && update.snapshot.canvas?.revision === 2 && update.snapshot.canvas.scene.elements.length > count),
  { id: samples.one, count: savedBoard.scene.elements.length });
  const raw = await page.evaluate(id => window.excalidrawUpdates.filter(update => update.subscriptionId === id && update.snapshot.canvas).at(-1).snapshot.canvas, samples.one);
  const localFile = process.env.PI_STUDIO_QA_DIAGRAM || path.join(scratch, 'native.excalidraw');
  if (!process.env.PI_STUDIO_QA_DIAGRAM) {
    await writeFile(localFile, JSON.stringify({ type: 'excalidraw', version: 2, ...raw.scene }));
  }
  const file = JSON.parse(await readFile(localFile, 'utf8'));
  await surface.locator('input[type=file]').setInputFiles(localFile);
  await page.getByRole('button', { name: '替换画布', exact: true }).click();
  await page.waitForFunction(({ id, count }) => window.excalidrawUpdates.some(update => update.subscriptionId === id
    && update.snapshot.canvas?.revision === 3 && update.snapshot.canvas.scene.elements.length === count),
  { id: samples.one, count: file.elements.length });
  await editor.locator('label').filter({ has: page.getByTestId('toolbar-rectangle') }).click();
  const drawingArea = await editor.locator('canvas').first().boundingBox();
  const start = { x: drawingArea.x + 42, y: drawingArea.y + 150 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 78, start.y + 36, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(({ id, count }) => window.excalidrawUpdates.some(update => update.subscriptionId === id
    && update.snapshot.canvas?.revision === 4 && update.snapshot.canvas.scene.elements.length === count),
  { id: samples.one, count: file.elements.length + 1 });

  await page.evaluate(async ({ one, two }) => {
    window.excalidrawUnsubscribe();
    await Promise.all([one, two].map(id => window.piApi.closeExtensionDataView(id)));
  }, samples);
  await tab.locator('.panel-tab-close').click();
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  const launcher = page.locator('.panel-launcher');
  await launcher.getByRole('region', { name: '系统工具', exact: true }).waitFor();
  const pluginTile = launcher.getByRole('region', { name: '插件', exact: true }).getByRole('button', { name: 'Excalidraw', exact: true });
  await pluginTile.locator('img').waitFor();
  await launcher.screenshot({ path: path.join(output, 'launcher.png'), scale: 'css' });
  await pluginTile.click();
  const exportButton = surface.getByRole('button', { name: '导出 Excalidraw 文件' });
  await surface.getByRole('button', { name: '适应画布' }).and(page.locator(':enabled')).waitFor();
  const destination = path.join(scratch, 'exported.excalidraw');
  await downloadTo(app, exportButton, destination);
  const exported = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(exported.type, 'excalidraw');
  assert.equal(exported.elements.length, file.elements.length + 1);

  await app.close();
  ({ app, page } = await launch());
  await selectTestSession(page, workspace, ids.first);
  const reopened = await page.evaluate(async ({ sourceId, cwd, sessionId }) => {
    const api = window.piApi;
    const view = await api.openExtensionDataView({ sourceId, cwd, sessionId });
    await api.closeExtensionDataView(view.subscriptionId);
    return view.snapshot.canvas;
  }, { sourceId, cwd: workspace, sessionId: ids.first });
  assert.equal(reopened.revision, 4);
  assert.equal(reopened.scene.elements.length, file.elements.length + 1);
  if (development) {
    const editorModule = /\/src\/features\/extensions\/ExcalidrawCanvas\.tsx(?:\?|$)/;
    await page.route(editorModule, route => route.abort('failed'));
    await page.reload();
    await selectTestSession(page, workspace, ids.first);
    const composer = page.locator('.composer-editor');
    const draft = '画布加载失败时保留这条草稿';
    await composer.fill(draft);
    await openCanvasFromMenu(page);
    await page.getByRole('tabpanel', { name: 'Excalidraw', exact: true })
      .getByRole('alert').getByText('画布暂时无法打开', { exact: true }).waitFor();
    await page.locator('.panel-tabbar').getByRole('tab', { name: 'Excalidraw', exact: true }).locator('.panel-tab-close').click();
    assert.equal(await composer.innerText(), draft);
    await page.unroute(editorModule);
    console.log('Canvas module failure leaves the chat and draft available');
  }
  await page.evaluate(async ({ sourceId, cwd, sessionId, scene }) => {
    const api = window.piApi;
    const view = await api.openExtensionDataView({ sourceId, cwd, sessionId });
    try {
      await api.writeExtensionCanvas({ subscriptionId: view.subscriptionId, revision: 0, scene });
    } finally {
      await api.closeExtensionDataView(view.subscriptionId);
    }
  }, { sourceId, cwd: workspace, sessionId: ids.second, scene: reopened.scene });
  const otherBoardFile = (await readdir(boardDirectory)).find(name => name !== boardFiles[0]);
  assert.ok(otherBoardFile);
  await selectTestSession(page, workspace, ids.second);
  await openCanvasFromMenu(page);
  const secondPanel = page.getByRole('tabpanel', { name: 'Excalidraw', exact: true });
  await secondPanel.getByRole('button', { name: '适应画布' }).and(page.locator(':enabled')).waitFor();
  await secondPanel.getByTestId('main-menu-trigger').click();
  await secondPanel.getByTestId('clear-canvas-button').click();
  const clearDialog = page.locator('.excalidraw-modal-container .confirm-dialog').filter({ hasText: '清除画布' });
  await clearDialog.getByRole('button', { name: '确定', exact: true }).click();
  await secondPanel.getByText('画布是空的', { exact: true }).waitFor();
  await secondPanel.getByText('已保存到当前聊天', { exact: true }).waitFor();
  const cleared = JSON.parse(await readFile(path.join(boardDirectory, otherBoardFile), 'utf8'));
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.scene.elements.length, 0);

  const action = (id, action) => page.evaluate(({ id, action }) => (
    window.piApi.conversationAction({ kind: 'session', id, action })
  ), { id, action });
  await action(ids.first, 'archive');
  assert.ok((await readdir(boardDirectory)).includes(boardFiles[0]));
  await page.evaluate(cwd => window.piApi.setPluginEnabled({ id: 'studio.excalidraw', enabled: false, cwd }), workspace);
  const capabilities = await page.evaluate(cwd => window.piApi.composerResources({ cwd, includeCapabilities: true }), workspace);
  assert.ok(!capabilities.capabilities.some(item => item.type === 'plugin' && item.id === 'studio.excalidraw'));
  await assert.rejects(page.evaluate(id => window.piApi.conversationSubmit({
    id, text: '$[plugin:studio.excalidraw|Excalidraw] 继续绘图', requestId: 'qa-disabled-plugin',
  }), ids.first), /插件当前不可用/);
  const removed = await action(ids.first, 'remove');
  assert.equal(removed.pendingFileCleanups, 0);
  assert.deepEqual(removed.deletedSessionIds, [ids.first]);
  assert.deepEqual(await readdir(boardDirectory), [otherBoardFile]);
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).elements.length, exported.elements.length);
  assert.equal(errors.length, 0, [...new Set(errors)].slice(0, 4).join('\n'));
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ updates, reopenedRevision: reopened.revision }, null, 2));
  console.log('Excalidraw installation, editing, persistence, reset, archive and permanent deletion passed');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  const canvasUpdates = await page?.evaluate(() => window.excalidrawUpdates?.slice(-6).map(({ snapshot: { canvas } }) =>
    canvas && { revision: canvas.revision, elements: canvas.scene.elements.length })).catch(() => {});
  if (canvasUpdates?.length) console.error('Recent canvas updates:', canvasUpdates);
  console.error('Model offered:', offeredTools, 'Received plugin context:', receivedPluginContext);
  if (errors.length) console.error('Renderer errors:', [...new Set(errors)].slice(0, 6));
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  await rm(scratch, { recursive: true, force: true });
}
