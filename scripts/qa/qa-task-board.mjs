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
const board = () => page.getByRole('region', { name: '全局任务看板', exact: true });
const timeTrigger = (editor, label) => editor.getByRole('button', { name: new RegExp('^' + label + '(，|$)') });

async function openTime(editor, label) {
  await timeTrigger(editor, label).click();
  const calendar = page.getByRole('dialog', { name: '选择' + label, exact: true });
  await calendar.waitFor();
  return calendar;
}

async function setTime(editor, label, time) {
  const calendar = await openTime(editor, label);
  await calendar.locator('[data-date="' + day + '"]').click();
  const field = calendar.getByRole('textbox', { name: '时分', exact: true });
  await field.fill(time);
  await field.press('Enter');
  await calendar.waitFor({ state: 'detached' });
}

async function assertBoardLayout(columns) {
  const selector = '.task-board-columns .react-kanban-board';
  await page.waitForFunction(({ selector, columns }) => {
    const grid = document.querySelector(selector)?.firstElementChild;
    return grid && getComputedStyle(grid).gridTemplateColumns.split(' ').length === columns;
  }, { selector, columns });
  const overflow = await board().locator(selector).evaluate(element => element.scrollWidth - element.clientWidth);
  assert.ok(overflow <= 1, 'all columns fit the width of the panel');
}

async function seedExamples() {
  const tasks = [
    { title: '整理下周发布清单', details: '汇总变更记录、截图和文档更新。', status: 'todo', priority: 'normal' },
    { title: '准备版本验收环境', details: '确认测试账号、样例数据和回滚步骤。', status: 'todo', priority: 'high' },
    { title: '移动端权限确认', details: '等待产品确认访客是否可导出记录。', status: 'blocked', priority: 'urgent' },
    { title: '更新工作台交互说明', details: '已补充快捷入口和导航说明。', status: 'done', priority: 'low' },
  ];
  await page.evaluate(async list => {
    const api = window.piApi;
    const { subscriptionId } = await api.openExtensionDataView({ sourceId: 'user:studio.task-board/board-data' });
    try {
      for (const fields of list) {
        await api.writeExtensionTaskBoard({ subscriptionId, mutation: { action: 'create', id: crypto.randomUUID(), fields } });
      }
    } finally { await api.closeExtensionDataView(subscriptionId); }
  }, tasks);
  await board().getByRole('button', { name: tasks[0].title, exact: true }).waitFor();
}

async function openBoard() {
  const open = page.getByRole('button', { name: '打开右侧面板', exact: true });
  const tab = page.getByRole('tab', { name: '任务看板', exact: true });
  const tile = page.locator('.panel-launcher').getByRole('button', { name: '任务看板', exact: true });
  if (!(await board().isVisible())) {
    if (await open.isVisible()) await open.click();
    await tab.or(tile).first().click();
  }
  await board().getByRole('button', { name: '新增任务', exact: true }).and(page.locator(':enabled')).waitFor();
}

try {
  await launch();
  await configureTestModel(page, workspaceA, 'http://127.0.0.1:' + model.address().port + '/v1');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '安装 任务看板', exact: true }).click();
  const install = page.getByRole('dialog', { name: '安装预览', exact: true });
  await install.getByRole('button', { name: '确认安装', exact: true }).click();
  await install.waitFor({ state: 'detached' });

  await page.reload();
  await openBoard();
  await board().getByRole('heading', { name: '还没有任务', exact: true }).waitFor();
  assert.equal(await board().getByTestId('column-todo').count(), 0);
  await board().screenshot({ path: path.join(output, 'empty-sidebar.png'), scale: 'css' });
  await board().getByRole('button', { name: '新增任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新增任务', exact: true });
  assert.equal(await editor.locator('input[type="datetime-local"]').count(), 0);
  await editor.getByLabel('标题', { exact: true }).fill(title);
  await editor.getByLabel('详情', { exact: true }).fill('准备验收说明和样例数据');
  await editor.getByRole('button', { name: '优先级', exact: true }).click();
  await editor.getByRole('option', { name: '高', exact: true }).click();
  const calendar = await openTime(editor, '计划开始时间');
  const clock = calendar.getByRole('textbox', { name: '时分', exact: true });
  const confirmTime = calendar.getByRole('button', { name: '确定', exact: true });
  await clock.fill('24:15');
  assert.equal(await confirmTime.isDisabled(), true);
  await clock.fill('09:30');
  await page.screenshot({ path: path.join(output, 'editor-calendar.png'), scale: 'css' });
  await clock.press('Escape');
  await calendar.waitFor({ state: 'detached' });
  assert.equal(await timeTrigger(editor, '计划开始时间').getAttribute('aria-label'), '计划开始时间');
  await setTime(editor, '计划开始时间', '0930');
  await setTime(editor, '计划结束时间', '13:00');
  await setTime(editor, '实际开始时间', '10:00');
  await editor.screenshot({ path: path.join(output, 'editor.png'), scale: 'css' });
  await editor.getByRole('button', { name: '新增任务', exact: true }).click();
  await editor.waitFor({ state: 'detached' });

  await assertBoardLayout(1);
  const original = board().getByTestId('column-todo').locator('.task-board-card');
  const destination = board().getByTestId('column-in_progress').locator('[data-rfd-droppable-id="in_progress"]');
  await original.waitFor();
  const originBox = await original.boundingBox();
  const gripBox = await original.locator('.task-board-card-grip').boundingBox();
  const targetBox = await destination.boundingBox();
  const startX = gripBox.x + gripBox.width / 2;
  const startY = gripBox.y + gripBox.height / 2;
  const dx = targetBox.x + targetBox.width / 2 - originBox.x - originBox.width / 2;
  const dy = targetBox.y + targetBox.height / 2 - originBox.y - originBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 18 });
  await page.mouse.up();
  await board().getByTestId('column-in_progress').getByRole('button', { name: title, exact: true }).waitFor();

  await board().getByRole('button', { name: title, exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑任务', exact: true });
  await edit.getByRole('button', { name: '状态', exact: true }).getByText('进行中', { exact: true }).waitFor();
  assert.equal(await timeTrigger(edit, '计划结束时间').getAttribute('aria-label'),
    '计划结束时间，当前 ' + day.replace(/-/g, '/') + ' 13:00');
  await setTime(edit, '实际结束时间', '12:15');
  const clear = await openTime(edit, '实际结束时间');
  await clear.getByRole('button', { name: '清除', exact: true }).click();
  await clear.waitFor({ state: 'detached' });
  assert.equal(await timeTrigger(edit, '实际结束时间').getAttribute('aria-label'), '实际结束时间');
  await setTime(edit, '实际结束时间', '12:15');
  await edit.getByRole('button', { name: '保存更改', exact: true }).click();
  await edit.waitFor({ state: 'detached' });

  const ids = await page.evaluate(async ([first, second]) => {
    const api = window.piApi;
    const a = await api.createConversation({ cwd: first, title: '工作区 A 会话' });
    const b = await api.createConversation({ cwd: second, title: '工作区 B 会话' });
    return [a.id, b.id];
  }, [workspaceA, workspaceB]);
  await selectTestSession(page, workspaceA, ids[0]);
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  await selectTestSession(page, workspaceB, ids[1]);
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  const previousDay = new Date();
  previousDay.setDate(previousDay.getDate() - 1);
  const previousDate = localDay(previousDay);
  await board().getByRole('button', { name: '创建日期', exact: true }).click();
  await page.locator('[data-date="' + previousDate + '"]').click();
  await board().getByRole('heading', { name: '当天没有新增任务', exact: true }).waitFor();
  await board().getByRole('button', { name: '今天', exact: true }).click();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  await seedExamples();
  await board().screenshot({ path: path.join(output, 'board-sidebar.png'), scale: 'css' });

  const resize = await page.getByRole('separator', { name: '调整右侧面板宽度' }).boundingBox();
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x - 174, resize.y + resize.height / 2, { steps: 5 });
  await page.mouse.up();
  await assertBoardLayout(2);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await assertBoardLayout(4);
  const columns = await board().locator('.task-board-columns').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const clip = { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, Math.ceil(columns.y + columns.height + 28)) };
  await page.screenshot({ path: path.join(output, 'board-full.png'), scale: 'css', clip });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'board-dark.png'), scale: 'css', clip });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();

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
  const data = path.join(profile, 'plugin-data', pluginId, pluginId, 'tasks.sqlite');
  assert.ok((await stat(data)).size > 0);
  await app.close();
  await launch();
  await openBoard();
  await board().getByRole('button', { name: title, exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Task Board date-time editing, narrow/medium/full layouts, drag, global scope, AI query and restart passed.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
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
