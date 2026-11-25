import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activate } from '../../assets/official-plugins/packages/task-board/extension/extension.mjs';
import contract from '../../electron/main/core/task-board-contract.cjs';
import manifestContract from '../../electron/main/core/extension-manifest.cjs';
import dataView from '../../electron/main/services/extension-data-view.cjs';

const sourceId = 'user:studio.task-board/board-data';
const day = '2031-08-09';
const localTime = (date, hour, minute = 0) => new Date(2031, 7, date, hour, minute).toISOString();
const fields = {
  title: '  更新接口说明  ',
  details: '补一段示例请求',
  status: 'todo',
  priority: 'high',
  plannedStartAt: localTime(9, 8),
  plannedEndAt: localTime(9, 23, 59),
  actualStartAt: localTime(9, 8, 30),
  actualEndAt: null,
};

test('a task can be edited across subscriptions, queried by local date, and restored after plugin reload', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-board-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let active = activate({ dataDirectory, taskBoard: contract.taskBoardProtocol });
  const service = new dataView.ExtensionDataViewService({ normalizeContentList: value => value });
  const unregister = dataView.registerExtensionDataViewService(service);
  const firstRenderer = { id: 1 };
  const secondRenderer = { id: 2 };
  const id = randomUUID();
  const secondId = randomUUID();
  const open = (target, cwd, sessionId, query) => service.open({
    sourceId, taskBoard: true, taskBoardQuery: query, target, cwd, sessionId,
    context: { durableSessionId: '45' },
    owner: { manifestId: 'studio.task-board', scope: 'user' },
  }, active.dataSources['board-data']);
  const queryTool = async (name, args) => {
    const tool = active.durableExtension.tools.find(item => item.name === name);
    return JSON.parse((await tool.execute(args, { conversationId: 12 })).output[0].text);
  };
  try {
    const first = await open(firstRenderer, '/work-a', 'session-a');
    assert.equal(first.snapshot.taskBoard.total, 0);
    assert.equal(first.snapshot.taskBoardWritable, true);
    const create = { action: 'create', id, fields };
    await assert.rejects(service.writeTaskBoard(first.subscriptionId, secondRenderer, create), /无权/);
    const created = await service.writeTaskBoard(first.subscriptionId, firstRenderer, create);
    assert.equal(created.title, '更新接口说明');
    assert.equal(created.revision, 1);
    assert.deepEqual(await service.writeTaskBoard(first.subscriptionId, firstRenderer, create), created);
    await service.writeTaskBoard(first.subscriptionId, firstRenderer, {
      action: 'create', id: secondId, fields: { title: '下一天', plannedEndAt: localTime(10, 0) },
    });

    const second = await open(secondRenderer, '/work-b', 'session-b', { dateField: 'plannedEndAt', from: day, to: day });
    assert.deepEqual(second.snapshot.taskBoard.tasks, [created]);
    // Global subscriptions must stay open when a conversation is purged.
    await dataView.closeConversationDataViewServices(['session-a', '45']);
    const revised = await service.writeTaskBoard(second.subscriptionId, secondRenderer, {
      action: 'update', id, revision: 1, fields: { status: 'done', actualEndAt: localTime(9, 12) },
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.details, fields.details);
    await assert.rejects(service.writeTaskBoard(first.subscriptionId, firstRenderer, {
      action: 'update', id, revision: 1, fields: { title: '过期修改' },
    }), /已被更新/);
    await assert.rejects(service.writeTaskBoard(second.subscriptionId, secondRenderer, {
      action: 'update', id, revision: 2, fields: { actualEndAt: localTime(9, 7) },
    }), /实际结束时间/);

    const found = await queryTool('task_board_list', { status: 'done', dateField: 'actualEndAt', from: day, to: day });
    assert.equal(found.total, 1);
    assert.equal(found.tasks[0].id, id);
    assert.equal(Object.hasOwn(found.tasks[0], 'details'), false);
    assert.equal((await queryTool('task_board_list', { from: 'today', to: 'today' })).total, 2);
    assert.equal((await queryTool('task_board_list', { limit: 1 })).nextOffset, 1);
    await assert.rejects(queryTool('task_board_list', { from: '2031-02-29' }), /时间无效/);
    await assert.rejects(queryTool('task_board_list', { dateField: 'plannedEndAt', from: '2031-08-10', to: day }), /结束日期/);

    await service.closeAll();
    active.cleanup();
    active = activate({ dataDirectory, taskBoard: contract.taskBoardProtocol });
    assert.deepEqual(await queryTool('task_board_get', { id }), revised);
    assert.deepEqual((await open(firstRenderer, '', '')).snapshot.taskBoard.tasks.map(task => task.id).sort(), [id, secondId].sort());
  } finally {
    await service.closeAll();
    unregister();
    active.cleanup();
  }
});

test('global task boards are valid user-level panel declarations with their own data source', async () => {
  const source = new URL('../../assets/official-plugins/packages/task-board/extension/pi-studio.extension.json', import.meta.url);
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  const normalize = (raw, scope = 'user') => manifestContract.normalizeManifest(raw, source.pathname, scope);
  assert.equal(normalize(manifest).contributes.panels[0].taskBoard.sourceId, sourceId);
  assert.throws(() => normalize(manifest, 'project'), /需要用户级安装/);
  const ambiguous = structuredClone(manifest);
  ambiguous.contributes.panels[0].canvas = { sourceId: 'board-data' };
  assert.throws(() => normalize(ambiguous), /只能声明一个/);
  const missing = structuredClone(manifest);
  missing.contributes.dataSources = [{ id: 'different-source', title: 'Unused source' }];
  assert.throws(() => normalize(missing), /未声明/);
});
