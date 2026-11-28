import { checkPluginTheme, hideToolPanel, openPluginCatalog, openPluginTool, resizeToolHost } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/task-board/', import.meta.url));
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-task-board-qa-')));
const profile = path.join(scratch, 'profile');
const workspaceA = path.join(scratch, 'workspace-a');
const workspaceB = path.join(scratch, 'workspace-b');
await Promise.all([output, profile, workspaceA, workspaceB].map(folder => mkdir(folder, { recursive: true })));

const pluginId = 'studio.task-board';
const title = '核对接口交付';
const editorTitle = '移动端报表导出：核对访客与项目成员的权限，并补齐跨项目导出的验收用例';
const editorDetails = [
  '访客反馈可以看到导出入口，需要与服务端核对权限范围。',
  '',
  '复现步骤',
  '1. 使用访客账号打开共享项目。',
  '2. 在移动端进入月度报表，查看导出菜单。',
  '3. 切换到另一个项目，再次检查可导出的数据。',
  '',
  '验收范围',
  '访客只能查看已分享的报表。',
  '项目成员可以导出当前项目的数据。',
  '同一账号加入多个项目时，导出文件只应包含所选项目。',
  '',
  '回归检查',
  '核对导出入口、文件内容和权限不足时的提示。',
  '补充权限变更后重新打开页面的用例。',
].join('\n');
const localDay = date => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
  .map(value => String(value).padStart(2, '0')).join('-');
const day = localDay(new Date());
const expectedQuery = { status: 'in_progress', dateField: 'plannedEndAt', from: day, to: day };
let toolOffered = false;
let toolResult;
const model = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { messages, tools } = JSON.parse(Buffer.concat(chunks));
  const tool = messages.find(message => message.role === 'tool');
  if (tool) {
    const contents = typeof tool.content === 'string' ? tool.content : tool.content?.map(item => item.text).join('');
    try { toolResult = JSON.parse(contents); }
    catch { toolResult = { unexpected: contents }; }
  }
  toolOffered ||= tools?.some(item => item.function?.name === 'task_board_list') === true;
  const toolCall = tools?.some(item => item.function?.name === 'task_board_list') && !tool;
  const delta = toolCall ? {
    tool_calls: [{ index: 0, id: 'qa-task-list', type: 'function',
      function: { name: 'task_board_list', arguments: JSON.stringify(expectedQuery) } }],
  } : { content: tool ? '全局任务查询完成。' : '检查完成。' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish_reason) => response.write('data: ' + JSON.stringify({
    id: 'qa-task-board', object: 'chat.completion.chunk', created: 1, model: 'check',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n');
  event({ role: 'assistant', ...delta }, null);
  event({}, toolCall ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => model.once('error', reject).listen(0, '127.0.0.1', resolve));

let app;
let page;
const errors = [];
const rendererDiagnostics = [];
async function launch() {
  ({ app, page } = await launchTestDesktop(workspaceA, profile, 1500, 950));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') rendererDiagnostics.push(message.text());
  });
  page.on('requestfailed', request => rendererDiagnostics.push(request.failure()?.errorText + ' ' + request.url()));
  await page.evaluate(() => window.piApi.waitForStartup());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.app').waitFor({ timeout: 20000 });
}
let tool;
const board = () => tool.frame;
async function setTime(id, time) {
  await board().locator('#' + id).click();
  const popover = board().locator('.tb-date-popover');
  await popover.locator('.tb-date-day.is-today').click();
  await popover.locator('input[type=time]').fill(time);
  await popover.locator('.tb-date-confirm').click();
}
async function openBoard() {
  tool = await openPluginTool(app, page, '任务看板');
  await board().locator('[data-action="new-task"]:enabled').first().waitFor();
}
async function seedExamples() {
  const tasks = [
    { title: '整理下周发布清单', details: '汇总变更记录、截图和文档更新。', status: 'todo', priority: 'normal', projects: ['版本验收'] },
    { title: '准备版本验收环境', details: '确认测试账号、样例数据和回滚步骤。', status: 'todo', priority: 'high' },
    {
      title: editorTitle, details: editorDetails, type: 'bug', status: 'blocked', priority: 'urgent',
      projects: ['移动端', '报表'], plannedStartAt: new Date(day + 'T09:00:00').toISOString(),
      plannedEndAt: new Date(day + 'T18:00:00').toISOString(),
    },
    { title: '更新工作台交互说明', details: '已补充快捷入口和导航说明。', status: 'done', priority: 'low' },
  ];
  await page.evaluate(async list => {
    const api = window.piApi;
    const { subscriptionId } = await api.openExtensionDataView({ sourceId: 'user:studio.task-board/board-data' });
    try {
      for (const fields of list) {
        await api.invokeExtensionView({ subscriptionId, method: 'createTask', params: { id: crypto.randomUUID(), fields } });
      }
    } finally { await api.closeExtensionDataView(subscriptionId); }
  }, tasks);
  await board().getByRole('button', { name: tasks[0].title, exact: true }).waitFor();
}

async function checkEditorLayout(dialog, wide) {
  await dialog.evaluate(async (element, wide) => {
    const content = element.querySelector('.tb-editor-content');
    const meta = element.querySelector('.tb-editor-meta');
    const body = element.querySelector('.tb-dialog-body');
    const footer = element.querySelector('.tb-dialog-foot');
    const deadline = performance.now() + 5000;
    do {
      const left = content.getBoundingClientRect();
      const side = meta.getBoundingClientRect();
      const actions = footer.getBoundingClientRect();
      const positioned = wide
        ? side.left >= left.right && Math.abs(side.top - left.top) < 1 && element.clientWidth > 850
        : side.top >= left.bottom && Math.abs(side.left - left.left) < 1;
      if (positioned && body.scrollWidth === body.clientWidth && actions.bottom <= innerHeight) return;
      await new Promise(requestAnimationFrame);
    } while (performance.now() < deadline);
    throw Error('Unexpected task editor layout: ' + JSON.stringify({
      viewport: [innerWidth, innerHeight], dialog: element.getBoundingClientRect(),
      scroll: [body.scrollTop, body.clientWidth, body.scrollWidth], footer: footer.getBoundingClientRect(),
      content: content.getBoundingClientRect(), metadata: meta.getBoundingClientRect(),
    }));
  }, wide);
}

async function wheelDown(scrollArea, target = scrollArea) {
  await target.hover();
  await tool.page.mouse.wheel(0, 200);
  const offset = await scrollArea.evaluate(async el => {
    const deadline = performance.now() + 3000;
    while (el.scrollTop === 0 && performance.now() < deadline) await new Promise(requestAnimationFrame);
    return el.scrollTop;
  });
  assert.ok(offset > 0, 'The wheel scrolls the targeted area with its scrollbar hidden');
}

async function checkTaskEditor() {
  await resizeToolHost(app, page, 1550, 950);
  await board().getByRole('button', { name: editorTitle, exact: true }).click();
  const dialog = board().getByRole('dialog', { name: '编辑任务', exact: true });
  await dialog.locator('.tb-activity-list').waitFor();
  await checkEditorLayout(dialog, true);
  assert.equal(await dialog.getByLabel('任务描述', { exact: true }).inputValue(), editorDetails);
  const note = dialog.getByRole('textbox', { name: '新增进展' });
  const progress = '已复现访客导出问题。服务端已确认权限规则，等待移动端复测。';
  await note.fill(progress);
  const options = dialog.locator('.tb-project-options');
  assert.equal(await options.getAttribute('open'), null);
  await options.getByText('选择已有项目').click();
  await options.getByRole('button', { name: '+ 版本验收', exact: true }).click();
  await dialog.getByRole('button', { name: '移除项目 版本验收' }).waitFor();
  await options.getByText('选择已有项目').click();
  await dialog.getByRole('button', { name: '优先级', exact: true }).click();
  await dialog.getByRole('option', { name: '高', exact: true }).click();
  assert.equal(await note.inputValue(), progress);
  await note.press('Enter');
  await dialog.locator('.tb-activity-list').getByText(progress, { exact: true }).waitFor();
  const shots = path.join(output, 'editor');
  await mkdir(shots, { recursive: true });
  const body = dialog.locator('.tb-dialog-body');
  const sidebar = dialog.locator('.tb-editor-meta');
  const description = dialog.getByLabel('任务描述', { exact: true });
  await body.evaluate(el => { el.scrollTop = 0; });
  for (const area of [body, sidebar, description]) {
    assert.equal(await area.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none');
  }
  await checkPluginTheme(tool.page, board(), [
    ['.tb-dialog-body', '--surface-canvas'], ['.tb-editor-meta', '--surface-raised'],
    ['.tb-prop .tb-date-trigger', '--surface-canvas'],
  ], shots);
  await wheelDown(description);
  await description.evaluate(el => { el.scrollTop = 0; });
  const sidebarTop = (await sidebar.boundingBox()).y;
  await wheelDown(body, dialog.locator('.tb-title-label'));
  assert.ok(Math.abs((await sidebar.boundingBox()).y - sidebarTop) <= 1, 'The properties and dates stay pinned');
  await dialog.screenshot({ path: path.join(shots, 'scrolled.png'), scale: 'css' });
  await body.evaluate(el => { el.scrollTop = 0; });
  await resizeToolHost(app, page, 980, 780);
  await checkEditorLayout(dialog, false);
  assert.equal(await sidebar.evaluate(el => getComputedStyle(el).position), 'static');
  await dialog.screenshot({ path: path.join(shots, 'narrow.png'), scale: 'css' });
  const footer = dialog.locator('.tb-dialog-foot');
  const top = (await footer.boundingBox()).y;
  const scroll = await dialog.locator('.tb-dialog-body').evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  assert.ok(scroll > 0);
  assert.equal((await footer.boundingBox()).y, top);
  await dialog.getByRole('button', { name: '保存更改' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await resizeToolHost(app, page, 1550, 780);
  await tool.page.getByRole('button', { name: '还原面板大小' }).click();
  await tool.page.getByRole('button', { name: '放大工具面板' }).waitFor();
  await board().getByRole('button', { name: editorTitle, exact: true }).click();
  await dialog.getByRole('button', { name: '移除项目 版本验收' }).waitFor();
  await dialog.getByRole('button', { name: '优先级', exact: true }).getByText('高', { exact: true }).waitFor();
  await dialog.locator('.tb-activity-list').getByText(progress, { exact: true }).waitFor();
  await checkEditorLayout(dialog, true);
  await wheelDown(sidebar, dialog.getByRole('button', { name: '任务状态' }));
  const lastDate = dialog.getByRole('button', { name: '实际结束', exact: true });
  await lastDate.click();
  const dateMenu = dialog.locator('.tb-date-popover');
  await dateMenu.waitFor();
  assert.equal(await dateMenu.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none');
  await lastDate.press('Escape');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
}

try {
  await launch();
  await configureTestModel(page, workspaceA, 'http://127.0.0.1:' + model.address().port + '/v1');
  await openPluginCatalog(page);
  await page.getByRole('button', { name: '安装 任务看板', exact: true }).click();
  const install = page.getByRole('dialog', { name: '安装预览', exact: true });
  await install.getByRole('button', { name: '确认安装', exact: true }).click();
  await install.waitFor({ state: 'detached' });

  await page.reload();
  await openBoard();
  await board().getByText('还没有任务', { exact: true }).waitFor();
  await board().locator('[data-action="new-task"]').first().click();
  const newTask = board().getByRole('dialog', { name: '新增任务', exact: true });
  assert.equal(await newTask.getByLabel('任务标题').evaluate(el => el === document.activeElement), true);
  await newTask.locator('#tb-ed-save').click();
  await newTask.getByRole('alert').getByText('请输入任务标题').waitFor();
  await board().locator('#tb-ed-title').fill(title);
  await newTask.getByRole('alert').waitFor({ state: 'detached' });
  await checkPluginTheme(tool.page, board(), [
    ['body', '--surface-canvas'], ['dialog[open]', '--dialog-surface'], ['#tb-ed-title', '--composer-surface'],
  ], output);
  assert.equal(await board().locator('#tb-ed-title').inputValue(), title);
  await board().locator('#tb-ed-details').fill('准备验收说明和样例数据');
  await setTime('tb-ed-pe', '13:00');
  await setTime('tb-ed-as', '10:30');
  await setTime('tb-ed-ae', '12:15');
  await board().locator('#tb-ed-save').click();
  const card = board().locator('.tb-card').filter({ hasText: title });
  await card.dragTo(board().locator('.tb-column[data-status="in_progress"]'));
  await board().locator('[data-drop-status="in_progress"]').getByRole('button', { name: title, exact: true }).waitFor();
  await card.getByRole('button', { name: title }).click();
  await board().locator('#tb-ed-pe').getByText(/13:00/).waitFor();
  await board().locator('#tb-ed-close').click();
  const ids = await page.evaluate(async ([first, second]) => {
    const api = window.piApi;
    const a = await api.createConversation({ cwd: first, title: '工作区 A 会话' });
    const b = await api.createConversation({ cwd: second, title: '工作区 B 会话' });
    return [a.id, b.id];
  }, [workspaceA, workspaceB]);
  await hideToolPanel(page, tool.page);
  await selectTestSession(page, workspaceA, ids[0]);
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  await hideToolPanel(page, tool.page);
  await selectTestSession(page, workspaceB, ids[1]);
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  await seedExamples();
  for (const [width, columns] of [[980, 2], [1550, 4]]) {
    await resizeToolHost(app, page, width, 780);
    const grid = board().locator('.tb-columns');
    await grid.evaluate((element, columns) => new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      function check() {
        if (getComputedStyle(element).gridTemplateColumns.split(' ').length === columns) resolve();
        else if (performance.now() > deadline) reject(Error('Unexpected board column count'));
        else requestAnimationFrame(check);
      }
      check();
    }), columns);
    await tool.page.screenshot({ path: path.join(output, 'board-' + width + '.png'), scale: 'css' });
  }
  const canvasShots = path.join(output, 'canvas');
  await mkdir(canvasShots, { recursive: true });
  await tool.page.getByRole('button', { name: '放大工具面板' }).click();
  await tool.page.getByRole('button', { name: '还原面板大小' }).waitFor();
  const backdrop = await board().locator('body').evaluate(body => {
    const style = getComputedStyle(body, '::before');
    return { tile: style.backgroundImage, fade: style.maskImage, pointerEvents: style.pointerEvents };
  });
  assert.match(backdrop.tile, /radial-gradient/);
  assert.match(backdrop.fade, /radial-gradient/);
  assert.equal(backdrop.pointerEvents, 'none');
  await checkPluginTheme(tool.page, board(), [
    ['body', '--surface-canvas'], ['.tb-column', '--surface-canvas'], ['.tb-card', '--surface-raised'],
  ], canvasShots);
  await checkTaskEditor();

  await page.evaluate(async ({ id, day }) => {
    const api = window.piApi;
    await api.modeSet({ scope: 'session', sessionId: id, mode: 'full' });
    await api.conversationSubmit({
      id, requestId: 'qa-global-task-query',
      text: '$[plugin:studio.task-board|任务看板] 查一下 ' + day + ' 计划结束的进行中任务。',
    });
  }, { id: ids[1], day });
  await page.getByText('全局任务查询完成。', { exact: true }).waitFor({ timeout: 20000 });
  assert.ok(toolOffered);
  assert.equal(toolResult?.total, 1, JSON.stringify(toolResult));
  assert.equal(toolResult.tasks[0].title, title);
  assert.equal(toolResult.tasks[0].status, 'in_progress');
  assert.ok(toolResult.tasks[0].actualEndAt);

  await page.evaluate(id => window.piApi.conversationAction({ kind: 'session', id, action: 'remove' }), ids[0]);
  const data = path.join(profile, 'data', 'plugin-data', pluginId, pluginId, 'tasks.sqlite');
  assert.ok((await stat(data)).size > 0);
  await app.close();
  await launch();
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Task Board responsive editor, progress, project selection, date-time editing, board layouts, drag, global scope, AI query and restart passed.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await tool?.page.screenshot({ path: path.join(output, 'panel-failure.png') }).catch(() => {});
  if (tool) console.error('Board:', await board().locator('body').innerText({ timeout: 1000 }).then(text => text.slice(0, 1600)).catch(() => 'unavailable'));
  if (errors.length) console.error(errors);
  if (rendererDiagnostics.length) console.error(rendererDiagnostics.slice(-12));
  console.error(await page?.evaluate(() => ({
    url: location.href, ready: document.readyState, root: document.querySelector('#root')?.childElementCount,
    body: document.body?.innerText.slice(0, 180), scripts: [...document.scripts].map(script => script.src).filter(Boolean),
  })).catch(() => null));
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  await rm(scratch, { recursive: true, force: true });
}
