import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { activate } from '../../assets/official-plugins/packages/task-board/extension/extension.mjs';
import manifestContract from '../../electron/main/core/extension-manifest.cjs';
import dataView from '../../electron/main/services/extension-data-view.cjs';

const sourceId = 'user:studio.task-board/board-data';
const localTime = (year, month, date, hour, minute = 0) => new Date(year, month - 1, date, hour, minute);

test('standalone task-board plugin supports types, multi-project linking, activity logs, archive/restore, and accurate period summaries', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-board-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  let currentTime = localTime(2031, 8, 11, 10, 0); // Monday
  let active = activate({ dataDirectory, now: () => currentTime });
  const service = new dataView.ExtensionDataViewService({ normalizeContentList: value => value });
  const unregister = dataView.registerExtensionDataViewService(service);
  const firstRenderer = { id: 1, send() {} };
  const secondRenderer = { id: 2, send() {} };
  const bugId = randomUUID();
  const featureId = randomUUID();
  const blockedId = randomUUID();

  const open = (target, cwd, sessionId, viewParams) => service.open({
    sourceId,
    view: true,
    viewScope: 'global',
    viewParams,
    target,
    cwd,
    sessionId,
    context: { durableSessionId: '45' },
    owner: { manifestId: 'studio.task-board', scope: 'user' },
  }, active.dataSources['board-data']);

  const queryTool = async (name, args = {}) => {
    const tool = active.durableExtension.tools.find(item => item.name === name);
    assert.ok(tool, `missing tool ${name}`);
    assert.equal(tool.replay, 'safe');
    return JSON.parse((await tool.execute(args, { conversationId: 12 })).output[0].text);
  };

  try {
    const first = await open(firstRenderer, '/work-a', 'session-a');
    assert.equal(first.snapshot.viewData.total, 0);
    assert.equal(first.snapshot.viewInvocable, true);

    // Unauthorized renderer cannot invoke.
    await assert.rejects(
      service.invokeView(first.subscriptionId, secondRenderer, 'createTask', { id: bugId, fields: { title: 'x' } }),
      /无权/,
    );

    // Create a Bug linked to multiple projects (对接型任务).
    const bug = await service.invokeView(first.subscriptionId, firstRenderer, 'createTask', {
      id: bugId,
      fields: {
        title: '修复支付回调签名校验',
        details: '上游返回空字段时验签失败',
        type: 'bug',
        status: 'todo',
        priority: 'high',
        projects: ['pi-studio', '支付网关'],
      },
    });
    assert.equal(bug.type, 'bug');
    assert.deepEqual(bug.projects, ['pi-studio', '支付网关']);
    assert.equal(bug.actualStartAt, null);
    assert.equal(bug.actualEndAt, null);

    // Move to in_progress on Monday -> auto-fills actualStartAt.
    currentTime = localTime(2031, 8, 11, 11, 30);
    const bugStarted = await service.invokeView(first.subscriptionId, firstRenderer, 'updateTask', {
      id: bugId, revision: bug.revision, fields: { status: 'in_progress' },
    });
    assert.equal(bugStarted.actualStartAt, currentTime.toISOString());

    // Add a progress note on Monday.
    currentTime = localTime(2031, 8, 11, 14, 0);
    const noted = await service.invokeView(first.subscriptionId, firstRenderer, 'addNote', {
      taskId: bugId, body: '已复现，正在与支付网关确认签名顺序',
    });
    assert.equal(noted.activities[0].kind, 'note');

    // Finish Bug on Monday -> auto-fills actualEndAt.
    currentTime = localTime(2031, 8, 11, 17, 0);
    const bugDone = await service.invokeView(first.subscriptionId, firstRenderer, 'updateTask', {
      id: bugId, revision: noted.task.revision, fields: { status: 'done' },
    });
    assert.equal(bugDone.actualEndAt, currentTime.toISOString());

    // Archive Bug on Tuesday, and edit its title on Friday -> completion MUST stay Monday!
    currentTime = localTime(2031, 8, 12, 9, 30);
    const bugArchived = await service.invokeView(first.subscriptionId, firstRenderer, 'archiveTask', {
      id: bugId, revision: bugDone.revision,
    });
    assert.ok(bugArchived.task.archivedAt);
    assert.equal(bugArchived.task.actualEndAt, bugDone.actualEndAt);

    // Multi-day in-progress feature + blocked task.
    const feature = await service.invokeView(first.subscriptionId, firstRenderer, 'createTask', {
      id: featureId,
      fields: { title: '画板独立主题切换', type: 'feature', status: 'in_progress', projects: ['pi-studio'] },
    });
    await service.invokeView(first.subscriptionId, firstRenderer, 'addNote', {
      taskId: featureId, body: '完成浅色/深色切换原型',
    });
    await service.invokeView(first.subscriptionId, firstRenderer, 'createTask', {
      id: blockedId,
      fields: { title: '移动端导出权限确认', type: 'chore', status: 'blocked', priority: 'urgent', projects: ['移动端'] },
    });

    // Global subscriptions survive conversation cleanup.
    await dataView.closeConversationDataViewServices(['session-a', '45']);

    // Rename archived Bug on Friday -> should not shift completion to Friday.
    currentTime = localTime(2031, 8, 15, 16, 0);
    await service.invokeView(first.subscriptionId, firstRenderer, 'updateTask', {
      id: bugId, revision: bugArchived.task.revision, fields: { title: '修复支付回调签名校验（已上线）' },
    });

    // Monday summary includes Bug completion.
    const monSummary = await queryTool('task_board_summary', { from: '2031-08-11', to: '2031-08-11' });
    assert.equal(monSummary.completed.length, 1);
    assert.equal(monSummary.completed[0].id, bugId);
    assert.equal(monSummary.completed[0].archived, true);

    // Tuesday summary MUST NOT count Bug as completed just because it was archived on Tuesday!
    const tueSummary = await queryTool('task_board_summary', { from: '2031-08-12', to: '2031-08-12' });
    assert.equal(tueSummary.completed.length, 0);
    assert.equal(tueSummary.progressed.some(item => item.id === featureId), true);
    assert.equal(tueSummary.progressed.some(item => item.id === bugId), false);

    // Weekly summary deduplicates Bug and supports project filtering!
    const weekSummary = await queryTool('task_board_summary', { from: '2031-08-11', to: '2031-08-17', project: '支付网关' });
    assert.equal(weekSummary.completed.length, 1);
    assert.equal(weekSummary.completed[0].id, bugId);
    assert.equal(weekSummary.stats.completedByType.bug, 1);

    // List tool filters by project & archived state.
    const archivedList = await queryTool('task_board_list', { archived: 'archived', project: '支付网关' });
    assert.equal(archivedList.total, 1);
    assert.equal(archivedList.tasks[0].id, bugId);

    // Restore and reopen work cleanly.
    const detail = await queryTool('task_board_get', { id: bugId });
    assert.ok(detail.activities.length >= 4);
    const restored = await service.invokeView(first.subscriptionId, firstRenderer, 'restoreTask', {
      id: bugId, revision: detail.task.revision,
    });
    assert.equal(restored.task.archivedAt, null);
    assert.equal(restored.task.status, 'done');

    const reopened = await service.invokeView(first.subscriptionId, firstRenderer, 'reopenTask', {
      id: bugId, revision: restored.task.revision,
    });
    assert.equal(reopened.task.status, 'in_progress');
    assert.equal(reopened.task.actualEndAt, null);

    // Survives plugin reload.
    await service.closeAll();
    active.cleanup();
    active = activate({ dataDirectory, now: () => currentTime });
    const reloaded = await open(secondRenderer, '', '');
    assert.equal(reloaded.snapshot.viewData.total, 3);
    assert.deepEqual(
      reloaded.snapshot.viewData.allProjects,
      ['pi-studio', '移动端', '支付网关'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    );
  } finally {
    await service.closeAll();
    unregister();
    active.cleanup();
  }
});

test('task-board migrates v1 SQLite databases cleanly without losing legacy tasks', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-board-v1-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const dbPath = path.join(dataDirectory, 'tasks.sqlite');
  const legacy = new DatabaseSync(dbPath);
  const legacyId = randomUUID();
  const iso = '2030-05-01T08:00:00.000Z';
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      planned_start_at TEXT,
      planned_end_at TEXT,
      actual_start_at TEXT,
      actual_end_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  legacy.prepare(`
    INSERT INTO tasks (id, title, details, status, priority, created_at, updated_at)
    VALUES (?, '旧版任务', '保留内容', 'done', 'normal', ?, ?)
  `).run(legacyId, iso, iso);
  legacy.close();

  const active = activate({ dataDirectory });
  try {
    const snap = active.dataSources['board-data'].read({ viewParams: {} }).viewData;
    assert.equal(snap.total, 1);
    assert.equal(snap.tasks[0].id, legacyId);
    assert.equal(snap.tasks[0].type, 'chore');
    assert.deepEqual(snap.tasks[0].projects, []);
    assert.equal(snap.tasks[0].archivedAt, null);
  } finally {
    active.cleanup();
  }
});

test('global task board uses the generic panel.view declaration with user-level scope', async () => {
  const source = new URL('../../assets/official-plugins/packages/task-board/extension/pi-studio.extension.json', import.meta.url);
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  const normalize = (raw, scope = 'user') => manifestContract.normalizeManifest(raw, source.pathname, scope);
  const normalized = normalize(manifest);
  assert.equal(normalized.contributes.panels[0].view.sourceId, sourceId);
  assert.equal(normalized.contributes.panels[0].view.entry, 'ui/index.html');
  assert.equal(normalized.contributes.panels[0].view.scope, 'global');
  assert.throws(() => normalize(manifest, 'project'), /需要用户级安装/);
  const badEntry = structuredClone(manifest);
  badEntry.contributes.panels[0].view.entry = '../extension.mjs';
  assert.throws(() => normalize(badEntry), /非法路径段/);
  const missing = structuredClone(manifest);
  missing.contributes.dataSources = [{ id: 'different-source', title: 'Unused source' }];
  assert.throws(() => normalize(missing), /未声明/);
});

test('task-board Agent write tools keep temporary chat read-only while notifying live subscribers and supporting batch creation', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-board-agent-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const active = activate({ dataDirectory, now: () => localTime(2031, 9, 1, 14, 0) });
  const toolsByName = new Map(active.durableExtension.tools.map(tool => [tool.name, tool]));
  const safeTools = active.durableExtension.tools.filter(tool => tool.replay === 'safe').map(tool => tool.name);
  assert.deepEqual(safeTools, ['task_board_list', 'task_board_get', 'task_board_summary']);

  const published = [];
  const abortController = new AbortController();
  const unsubscribe = active.dataSources['board-data'].subscribe(
    { signal: abortController.signal, viewParams: {} },
    payload => published.push(payload.viewData.total),
  );

  try {
    assert.deepEqual(published, [0]);

    const batchRes = JSON.parse((await toolsByName.get('task_board_create').execute({
      tasks: [
        {
          title: '批量创建需求任务',
          type: 'feature',
          status: 'in_progress',
          priority: 'high',
          projects: ['RAG 服务图集'],
          plannedEndAt: '2031-09-02T18:00:00+08:00',
          note: '已完成初版架构拆分',
        },
        {
          title: '已完成验收任务',
          type: 'chore',
          status: 'done',
          projects: ['任务看板插件'],
        },
      ],
    })).output[0].text);

    assert.equal(batchRes.createdCount, 2);
    assert.equal(batchRes.tasks[0].latestNote, '已完成初版架构拆分');
    assert.equal(batchRes.tasks[0].plannedEndAt, new Date('2031-09-02T18:00:00+08:00').toISOString());
    assert.equal(published.at(-1), 2);

    const updated = JSON.parse((await toolsByName.get('task_board_update').execute({
      id: batchRes.tasks[0].id,
      status: 'done',
      note: '最终验证通过',
    })).output[0].text);
    assert.equal(updated.task.status, 'done');
    assert.equal(updated.task.latestNote, '最终验证通过');

    await toolsByName.get('task_board_add_note').execute({
      taskId: batchRes.tasks[0].id,
      body: '补充上线记录',
    });

    const midSummary = JSON.parse((await toolsByName.get('task_board_summary').execute({
      from: '2031-09-01',
      to: '2031-09-01',
    })).output[0].text);
    const midDetail = JSON.parse((await toolsByName.get('task_board_get').execute({
      id: batchRes.tasks[0].id,
    })).output[0].text);
    const summaryItem = midSummary.completed.find(item => item.id === batchRes.tasks[0].id);
    assert.ok(summaryItem);
    assert.deepEqual(
      summaryItem.notes.map(note => note.body),
      ['已完成初版架构拆分', '最终验证通过', '补充上线记录'],
    );
    assert.equal(summaryItem.notes.at(-1).body, midDetail.task.latestNote);
    assert.deepEqual(
      midDetail.activities.filter(item => item.kind === 'note').map(item => item.body),
      ['补充上线记录', '最终验证通过', '已完成初版架构拆分'],
    );

    const archived = JSON.parse((await toolsByName.get('task_board_archive').execute({
      action: 'archive_done',
    })).output[0].text);
    assert.equal(archived.archivedCount, 2);
    assert.equal(published.at(-1), 0);

    // Direct external write from another SQLite connection updates PRAGMA data_version cleanly.
    const externalDb = new DatabaseSync(path.join(dataDirectory, 'tasks.sqlite'));
    try {
      const extId = randomUUID();
      const iso = '2031-09-01T15:00:00.000Z';
      externalDb.prepare(`
        INSERT INTO tasks (id, title, details, status, priority, type, projects_json, created_at, updated_at)
        VALUES (?, '外部写入任务', '', 'todo', 'normal', 'chore', '[]', ?, ?)
      `).run(extId, iso, iso);
    } finally {
      externalDb.close();
    }
    const snap = active.dataSources['board-data'].read({ viewParams: {} }).viewData;
    assert.equal(snap.total, 1);
    assert.equal(snap.tasks[0].title, '外部写入任务');
  } finally {
    abortController.abort();
    unsubscribe();
    active.cleanup();
  }
});
