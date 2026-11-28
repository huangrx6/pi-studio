// Production Electron, preload, SQLite, Durable, todo tools and renderer. Only model replies are scripted.
import { openSessionInspection } from './fixtures/open-session-inspection.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop, configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
import { startChecklistModel } from './fixtures/checklist-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.qa/session-lifecycle');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-checklist-qa-')));
const workspace = path.join(temporary, 'workspace');
const profile = path.join(temporary, 'studio');
const model = await startChecklistModel();
const report = [];
const clearedAfterMs = {};
const pageErrors = [];
let app, page;
const button = name => page.getByRole('button', { name, exact: true });
const panel = () => page.locator('.inspection-card .conversation-progress');
const taskPage = () => page.getByRole('region', { name: '本会话全部任务' });

async function launch() {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1440, 920));
  page.on('pageerror', e => pageErrors.push(e.message));
}

async function openProgress() {
  const card = await openSessionInspection(page);
  await card.getByRole('tab', { name: '进展', exact: true }).click();
  if (await button('返回进展').isVisible()) await button('返回进展').click();
  await panel().getByRole('button', { name: '查看全部任务' }).waitFor();
}

async function select(id) {
  await selectTestSession(page, workspace, id);
  await openProgress();
}

async function start(tag) {
  await page.locator('.composer-editor').fill(tag);
  await button('发送消息').click();
  await runTodo(tag, { action: 'createMany', items: [{ subject: tag + ' 第一项' }, { subject: tag + ' 第二项' }] });
  if (tag === 'QA-DONE') {
    const compact = page.locator('.transcript-viewport .inspection-card[data-mode="compact"]');
    await compact.getByText('0/2 项完成').waitFor();
    assert.equal(await page.locator('.file-panel, .header-inspector-entry').count(), 0);
    await page.screenshot({ path: path.join(output, 'inspection-created.png') });
    await compact.getByRole('button', { name: '展开会话详情' }).click();
  }
  await panel().getByText(tag + ' 第一项', { exact: true }).waitFor();
  await panel().getByText(tag + ' 第二项', { exact: true }).waitFor();
  await model.wait(tag);
}

async function runTodo(tag, action) {
  await model.reply(tag, action);
  const dialog = page.getByRole('dialog', { name: '工具调用' }).filter({ hasText: /todo\s*\{/ });
  await dialog.getByRole('button', { name: '允许', exact: true }).click();
}

async function move(tag, id, action, subject) {
  await runTodo(tag, { action, id });
  const state = action === 'complete' ? '.is-complete' : '.is-active';
  await panel().locator('.todo-row' + state).getByText(tag + ' ' + subject, { exact: true }).waitFor();
  await model.wait(tag);
}

async function emptyPanel() {
  await panel().getByRole('button', { name: '查看全部任务' }).waitFor();
  await panel().locator('.todo-row').first().waitFor({ state: 'detached', timeout: 3500 });
  assert.equal(await panel().locator('.progress-tasks h3 small, .progress-task-scroll').count(), 0);
}

async function ended(id) {
  // Observe the idle UI before any explicit IPC reads can reconcile its watch.
  await emptyPanel();
  await page.locator('.send-button.is-stop').waitFor({ state: 'detached', timeout: 3500 });
  await page.waitForFunction(async id => !(await window.piApi.conversationSnapshot(id)).running &&
    !(await window.piApi.conversationTodo(id)), id, { polling: 100, timeout: 3500 });
}

async function verifyHistory(id, expected) {
  await panel().getByRole('button', { name: '查看全部任务' }).click();
  await taskPage().locator('li').first().waitFor();
  for (const group of await taskPage().locator('.session-tasks-disclosure').all()) {
    if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  }
  const plans = await page.evaluate(async id => (await window.piApi.conversationTodoHistory({ id })).items, id);
  assert.ok(plans.every(plan => plan.conversationId === id && plan.lifecycle === 'ended' && plan.scope === 'turn'));
  assert.equal(new Set(plans.map(plan => plan.turnId)).size, Object.keys(expected).length);
  assert.equal(plans.length, Object.keys(expected).length);
  const saved = {};
  for (const plan of plans) {
    const tag = plan.tasks[0].subject.split(' ')[0];
    assert.deepEqual(plan.tasks.map(task => task.subject), [tag + ' 第一项', tag + ' 第二项']);
    saved[tag] = plan.tasks.map(task => task.status);
    for (const task of plan.tasks) {
      const status = task.status === 'completed' ? 'completed' : 'unfinished';
      await taskPage().locator('li[data-status="' + status + '"]').getByText(task.subject, { exact: true }).waitFor();
    }
  }
  assert.deepEqual(saved, expected);
  assert.equal(await taskPage().locator('li').count(), Object.keys(expected).length * 2);
  await button('返回进展').click();
  await emptyPanel();
  return plans;
}

try {
  await Promise.all([mkdir(workspace), mkdir(profile), mkdir(output, { recursive: true })]);
  await launch();
  await configureTestModel(page, workspace, model.baseUrl);
  const [a, b] = await page.evaluate(async cwd => {
    const api = window.piApi;
    const a = await api.createConversation({ cwd, title: '验收会话 A' });
    const b = await api.createConversation({ cwd, title: '验收会话 B' });
    return [a.id, b.id];
  }, workspace);
  const expectedA = {}, expectedB = {};
  await selectTestSession(page, workspace, a);
  assert.equal(await page.locator('.inspection-card').count(), 0);
  for (const [tag, first] of [['QA-DONE', 1], ['QA-MISSED', 3], ['QA-STOP', 5], ['QA-FAIL', 7]]) {
    console.log('Running', tag);
    await start(tag);
    await move(tag, first, 'start', '第一项');
    await move(tag, first, 'complete', '第一项');
    if (tag !== 'QA-MISSED') await move(tag, first + 1, 'start', '第二项');
    if (tag === 'QA-DONE') await move(tag, first + 1, 'complete', '第二项');
    const finishAt = Date.now();
    if (tag === 'QA-STOP') await button('停止当前任务').click();
    else await model.reply(tag, tag === 'QA-FAIL' ? 'fail' : 'finish');
    await ended(a);
    clearedAfterMs[tag] = Date.now() - finishAt;
    if (tag === 'QA-FAIL') await page.getByText(/QA controlled model failure/).first().waitFor();
    expectedA[tag] = ['completed', tag === 'QA-DONE' ? 'completed' : tag === 'QA-MISSED' ? 'pending' : 'in_progress'];
    await verifyHistory(a, expectedA);
    report.push(tag);
  }

  await select(b);
  await start('QA-SWITCH');
  await move('QA-SWITCH', 1, 'start', '第一项');
  for (let i = 0; i < 3; i++) {
    await select(a);
    await emptyPanel();
    await select(b);
    await panel().locator('.todo-row.is-active').getByText('QA-SWITCH 第一项').waitFor();
  }
  await move('QA-SWITCH', 1, 'complete', '第一项');
  await select(a);
  await emptyPanel();
  await model.reply('QA-SWITCH', 'finish');
  const beforeA = await verifyHistory(a, expectedA);
  await select(b);
  await ended(b);
  expectedB['QA-SWITCH'] = ['completed', 'pending'];
  const beforeB = await verifyHistory(b, expectedB);
  await button('移动会话浮卡').press('Shift+ArrowLeft');
  const card = () => page.getByRole('complementary', { name: '会话详情', exact: true });
  const original = await card().boundingBox();
  await button('调整会话浮卡大小').press('Shift+ArrowLeft');
  await button('调整会话浮卡大小').press('ArrowDown');
  const custom = await card().boundingBox();
  assert.equal(custom.width, original.width + 32);
  assert.equal(custom.height, original.height + 8);
  await button('放大会话详情').click();
  await page.waitForFunction(async ({ id, width, height }) => {
    const saved = await window.piApi.readLayout('conversation:' + id, 'inspector');
    return saved?.mode === 'expanded' && saved.maximized && saved.position?.right === 32
      && saved.size?.width === width && saved.size?.height === height;
  }, { id: b, width: custom.width, height: custom.height });
  report.push('会话快速切换及后台完成');

  await app.close();
  await launch();
  for (const [id, expected, previous] of [[a, expectedA, beforeA], [b, expectedB, beforeB]]) {
    await selectTestSession(page, workspace, id);
    await button('收起会话详情').waitFor();
    if (id === b) {
      await button('还原会话详情大小').waitFor();
      assert.deepEqual(await card().boundingBox(), await page.locator('.inspection-stage').boundingBox());
      await button('还原会话详情大小').click();
      await page.waitForFunction(() => document.querySelector('.inspection-card')?.style.right === '32px');
      const restored = await card().boundingBox();
      assert.equal(restored.width, custom.width);
      assert.equal(restored.height, custom.height);
    } else {
      await button('放大会话详情').waitFor();
      assert.equal(await card().getAttribute('data-sized'), null);
    }
    await openProgress();
    await ended(id);
    assert.deepEqual(await verifyHistory(id, expected), previous, 'Persisted plan identity and states after restart');
  }
  report.push('空闲时重启恢复清单及各会话浮卡的尺寸、位置和放大状态');

  const resumedTag = 'QA-RESTART';
  await start(resumedTag);
  await move(resumedTag, 3, 'complete', '第一项');
  await move(resumedTag, 4, 'start', '第二项');
  const liveBefore = await page.evaluate(id => window.piApi.conversationTodo(id), b);
  await app.close();
  await launch();
  await select(b);
  await panel().locator('.todo-row.is-complete').getByText(resumedTag + ' 第一项').waitFor();
  await panel().locator('.todo-row.is-active').getByText(resumedTag + ' 第二项').waitFor();
  assert.deepEqual(await page.evaluate(id => window.piApi.conversationTodo(id), b), liveBefore);
  await move(resumedTag, 4, 'complete', '第二项');
  await model.reply(resumedTag, 'finish');
  await ended(b);
  expectedB[resumedTag] = ['completed', 'completed'];
  await verifyHistory(b, expectedB);
  report.push('执行中重启后续跑同一份清单');
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({
    passed: report, clearedAfterMs, sessions: { A: expectedA, B: expectedB },
  }, null, 2));
  console.log('Passed:', report.join(', '));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(-3000));
    await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 2500 }).catch(() => {});
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  await model.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
