/**
 * Studio's conversation-scoped task plan.
 *
 * The plan is a Durable document owned by one conversation. Tool results carry
 * the public snapshot to the renderer, while the document remains the source of
 * truth for later tool calls, restarts, forks, and context compaction.
 */

const TODO_DOC_KIND = 'studio.todo';
const TODO_SCHEMA_VERSION = 1;
const MAX_TASKS = 100;
const MAX_CREATE_ITEMS = 50;
const MAX_BLOCKED_BY = 20;
const MAX_SUBJECT_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_ACTIVE_FORM_LENGTH = 240;
const MAX_CLOSE_REASON_LENGTH = 1_000;

const ACTIONS = new Set([
  'create',
  'createMany',
  'update',
  'list',
  'get',
  'start',
  'complete',
  'finish',
  'reopen',
  'close',
  'archive',
  'restore',
  'delete',
  'clear',
]);

function emptyTodoState() {
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    tasks: [],
    nextId: 1,
    lastMutationTaskId: 0,
  };
}

function positiveId(value, label = '任务 ID') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label}必须是正整数`);
  }
  return id;
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return text;
}

function requiredText(value, label, maximum) {
  const text = optionalText(value, label, maximum);
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function normalizedText(value, maximum) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, maximum);
  return text || undefined;
}

function normalizedIds(values) {
  if (!Array.isArray(values)) return undefined;
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_BLOCKED_BY) break;
  }
  return ids.length > 0 ? ids : undefined;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function uniqueIds(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label}必须是任务 ID 数组`);
  if (values.length > MAX_BLOCKED_BY) {
    throw new Error(`${label}最多允许 ${MAX_BLOCKED_BY} 项`);
  }
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = positiveId(value, label);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const subject = typeof raw.subject === 'string' ? raw.subject.trim().slice(0, MAX_SUBJECT_LENGTH) : '';
  if (!subject) return undefined;
  const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(raw.status)
    ? raw.status
    : 'pending';
  const task = {
    id,
    subject,
    status,
  };
  const description = normalizedText(raw.description, MAX_DESCRIPTION_LENGTH);
  const activeForm = normalizedText(raw.activeForm, MAX_ACTIVE_FORM_LENGTH);
  const createdAt = timestamp(raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt);
  const archivedAt = timestamp(raw.archivedAt);
  const closedAt = timestamp(raw.closedAt);
  const closedReason = normalizedText(raw.closedReason, MAX_CLOSE_REASON_LENGTH);
  if (description) task.description = description;
  if (activeForm) task.activeForm = activeForm;
  const blockedBy = normalizedIds(raw.blockedBy);
  if (blockedBy) task.blockedBy = blockedBy;
  if (createdAt) task.createdAt = createdAt;
  if (updatedAt || createdAt) task.updatedAt = updatedAt || createdAt;
  if (archivedAt) task.archivedAt = archivedAt;
  if (closedAt) task.closedAt = closedAt;
  if (closedReason) task.closedReason = closedReason;
  return task;
}

function normalizeTodoState(value) {
  const state = emptyTodoState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  const seen = new Set();
  const tasks = [];
  for (const raw of Array.isArray(value.tasks) ? value.tasks : []) {
    const task = normalizeTask(raw);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  const maximumId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
  if (tasks.length > MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS);
  state.tasks = tasks;
  state.nextId = Math.max(
    Number.isSafeInteger(Number(value.nextId)) ? Number(value.nextId) : 1,
    maximumId + 1,
    1,
  );
  state.lastMutationTaskId = Number.isSafeInteger(Number(value.lastMutationTaskId))
    ? Math.max(0, Number(value.lastMutationTaskId))
    : 0;
  return state;
}

function publicDetails(state) {
  const normalized = normalizeTodoState(state);
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    tasks: normalized.tasks.map((task) => ({ ...task, ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}) })),
    nextId: normalized.nextId,
  };
}

function cloneState(state) {
  const normalized = normalizeTodoState(state);
  return {
    ...normalized,
    tasks: normalized.tasks.map((task) => ({
      ...task,
      ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
    })),
  };
}

function activeTasks(state) {
  return state.tasks.filter((task) => task.status !== 'deleted' && !task.archivedAt);
}

function taskById(state, id, allowDeleted = false) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`任务 #${id} 不存在`);
  if (!allowDeleted && task.status === 'deleted') throw new Error(`任务 #${id} 已删除`);
  return task;
}

function dependencyCycle(state, taskId, blockedBy) {
  const visiting = new Set();
  const visited = new Set();
  const reachesTask = (id) => {
    if (id === taskId) return true;
    if (visited.has(id) || visiting.has(id)) return false;
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status === 'deleted') return false;
    visiting.add(id);
    const found = (task.blockedBy || []).some(reachesTask);
    visiting.delete(id);
    visited.add(id);
    return found;
  };
  return blockedBy.some(reachesTask);
}

function assertTaskReady(state, task) {
  const blockers = (task.blockedBy || [])
    .map((id) => state.tasks.find((candidate) => candidate.id === id))
    .filter((dependency) => (
      dependency
      && !dependency.archivedAt
      && dependency.status !== 'completed'
      && !dependency.closedAt
    ));
  if (blockers.length > 0) {
    throw new Error(`任务 #${task.id} 仍被 ${blockers.map((item) => `#${item.id}`).join('、')} 阻塞`);
  }
}

function validateBlockedBy(state, taskId, input) {
  if (input === undefined) return undefined;
  const blockedBy = uniqueIds(input, '依赖任务');
  for (const dependencyId of blockedBy) {
    if (dependencyId === taskId) throw new Error(`任务 #${taskId} 不能依赖自己`);
    const dependency = state.tasks.find((task) => task.id === dependencyId);
    if (!dependency) throw new Error(`依赖任务 #${dependencyId} 不存在`);
    if (dependency.status === 'deleted') throw new Error(`依赖任务 #${dependencyId} 已删除`);
  }
  if (taskId > 0 && dependencyCycle(state, taskId, blockedBy)) {
    throw new Error(`任务 #${taskId} 的依赖会形成循环`);
  }
  return blockedBy;
}

function sameIds(left, right) {
  const a = left || [];
  const b = right || [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assignOptional(task, key, value) {
  if (value === undefined) delete task[key];
  else task[key] = value;
}

function changedTask(task, change, now) {
  let changed = false;
  for (const key of ['subject', 'description', 'activeForm', 'status', 'closedReason']) {
    if (!Object.hasOwn(change, key)) continue;
    if (task[key] === change[key]) continue;
    if (change[key] === undefined) delete task[key];
    else task[key] = change[key];
    changed = true;
  }
  if (Object.hasOwn(change, 'blockedBy') && !sameIds(task.blockedBy, change.blockedBy)) {
    if (change.blockedBy?.length) task.blockedBy = [...change.blockedBy];
    else delete task.blockedBy;
    changed = true;
  }
  if (Object.hasOwn(change, 'closedAt') && task.closedAt !== change.closedAt) {
    assignOptional(task, 'closedAt', change.closedAt);
    changed = true;
  }
  if (Object.hasOwn(change, 'archivedAt') && task.archivedAt !== change.archivedAt) {
    assignOptional(task, 'archivedAt', change.archivedAt);
    changed = true;
  }
  if (changed) task.updatedAt = now;
  return changed;
}

function assertTaskCapacity(state, adding = 1) {
  if (state.tasks.length + adding > MAX_TASKS) {
    throw new Error(`任务计划最多保留 ${MAX_TASKS} 项；请先删除或清空旧任务`);
  }
}

function itemPatch(item, now) {
  return {
    subject: requiredText(item?.subject, '任务标题', MAX_SUBJECT_LENGTH),
    description: optionalText(item?.description, '任务说明', MAX_DESCRIPTION_LENGTH),
    activeForm: optionalText(item?.activeForm, '进行中文案', MAX_ACTIVE_FORM_LENGTH),
    createdAt: now,
    updatedAt: now,
  };
}

function createTask(state, item, now) {
  assertTaskCapacity(state);
  const patch = itemPatch(item, now);
  const blockedBy = validateBlockedBy(state, 0, item?.blockedBy);
  const task = {
    id: state.nextId,
    subject: patch.subject,
    status: 'pending',
  };
  if (patch.description) task.description = patch.description;
  if (patch.activeForm) task.activeForm = patch.activeForm;
  if (blockedBy?.length) task.blockedBy = blockedBy;
  task.createdAt = now;
  task.updatedAt = now;
  state.nextId += 1;
  state.tasks.push(task);
  return task;
}

function updatePatch(state, task, args) {
  const change = {};
  if (Object.hasOwn(args, 'subject')) {
    change.subject = requiredText(args.subject, '任务标题', MAX_SUBJECT_LENGTH);
  }
  if (Object.hasOwn(args, 'description')) {
    change.description = optionalText(args.description, '任务说明', MAX_DESCRIPTION_LENGTH);
  }
  if (Object.hasOwn(args, 'activeForm')) {
    change.activeForm = optionalText(args.activeForm, '进行中文案', MAX_ACTIVE_FORM_LENGTH);
  }
  if (Object.hasOwn(args, 'blockedBy')) {
    change.blockedBy = validateBlockedBy(state, task.id, args.blockedBy);
  }
  if (Object.hasOwn(args, 'status')) {
    if (!['pending', 'in_progress', 'completed'].includes(args.status)) {
      throw new Error('update.status 只能是 pending、in_progress 或 completed');
    }
    if (task.status === 'deleted') throw new Error(`任务 #${task.id} 已删除`);
    if (task.status === 'completed' && args.status === 'in_progress') {
      throw new Error(`任务 #${task.id} 已完成，请先 reopen`);
    }
    if (task.closedAt && args.status !== 'pending') {
      throw new Error(`任务 #${task.id} 已结束，请先 reopen`);
    }
    if (args.status === 'in_progress') assertTaskReady(state, task);
    change.status = args.status;
    if (args.status !== 'completed') change.closedAt = undefined;
  }
  if (Object.keys(change).length === 0) {
    throw new Error('update 至少需要一个可修改字段');
  }
  return change;
}

function archivedTargets(state, args) {
  if (Array.isArray(args.ids) && args.ids.length > 0) return uniqueIds(args.ids, '任务 IDs');
  if (args.id !== undefined) return [positiveId(args.id)];
  throw new Error('请提供 ids 或 id');
}

function applyTodoMutation(inputState, args, nowValue = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('todo 参数格式无效');
  }
  const action = typeof args.action === 'string' ? args.action : '';
  if (!ACTIONS.has(action)) throw new Error(`未知 todo action：${action || '(empty)'}`);
  const now = Number(nowValue) > 0 ? Number(nowValue) : Date.now();
  const state = cloneState(inputState);

  if (action === 'list') {
    return { state, changed: false, message: '已读取当前任务计划。' };
  }
  if (action === 'get') {
    const id = positiveId(args.id);
    taskById(state, id, true);
    return { state, changed: false, message: `已读取任务 #${id}。` };
  }
  if (action === 'create') {
    const task = createTask(state, args, now);
    return { state, changed: true, message: `已创建任务 #${task.id}。` };
  }
  if (action === 'createMany') {
    const items = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) throw new Error('createMany 至少需要一个任务');
    if (items.length > MAX_CREATE_ITEMS) {
      throw new Error(`createMany 一次最多创建 ${MAX_CREATE_ITEMS} 个任务`);
    }
    assertTaskCapacity(state, items.length);
    const created = [];
    for (const item of items) created.push(createTask(state, item, now));
    return {
      state,
      changed: true,
      message: `已创建 ${created.length} 个任务：${created.map((task) => `#${task.id}`).join('、')}。`,
    };
  }
  if (action === 'update') {
    const task = taskById(state, positiveId(args.id));
    const changed = changedTask(task, updatePatch(state, task, args), now);
    return {
      state,
      changed,
      message: changed ? `已更新任务 #${task.id}。` : `任务 #${task.id} 没有变化。`,
    };
  }
  if (action === 'start') {
    const task = taskById(state, positiveId(args.id));
    if (task.closedAt) throw new Error(`任务 #${task.id} 已结束，请先 reopen`);
    if (task.status === 'completed') throw new Error(`任务 #${task.id} 已完成，请先 reopen`);
    assertTaskReady(state, task);
    if (task.status === 'in_progress') {
      return { state, changed: false, message: `任务 #${task.id} 已在进行中。` };
    }
    changedTask(task, { status: 'in_progress' }, now);
    return { state, changed: true, message: `已开始任务 #${task.id}。` };
  }
  if (action === 'complete' || action === 'finish') {
    const task = taskById(state, positiveId(args.id));
    if (task.closedAt) throw new Error(`任务 #${task.id} 已结束，请先 reopen`);
    if (task.status === 'completed') {
      return { state, changed: false, message: `任务 #${task.id} 已完成。` };
    }
    changedTask(task, { status: 'completed' }, now);
    return { state, changed: true, message: `已完成任务 #${task.id}。` };
  }
  if (action === 'reopen') {
    const task = taskById(state, positiveId(args.id));
    if (task.status === 'pending' && !task.closedAt && !task.archivedAt) {
      return { state, changed: false, message: `任务 #${task.id} 已经处于待开始状态。` };
    }
    changedTask(task, {
      status: 'pending',
      closedAt: undefined,
      closedReason: undefined,
      archivedAt: undefined,
    }, now);
    return { state, changed: true, message: `已重新打开任务 #${task.id}。` };
  }
  if (action === 'close') {
    const task = taskById(state, positiveId(args.id));
    if (task.closedAt) throw new Error(`任务 #${task.id} 已经结束`);
    if (task.status === 'completed') throw new Error(`任务 #${task.id} 已完成，不能按未完成结束`);
    const reason = optionalText(args.closeReason ?? args.closedReason, '结束原因', MAX_CLOSE_REASON_LENGTH);
    changedTask(task, {
      closedAt: now,
      closedReason: reason,
    }, now);
    return { state, changed: true, message: `已结束任务 #${task.id}。` };
  }
  if (action === 'archive') {
    const ids = archivedTargets(state, args);
    for (const id of ids) {
      const task = taskById(state, id);
      if (task.status !== 'completed') throw new Error(`任务 #${id} 尚未完成，不能归档`);
    }
    for (const id of ids) changedTask(taskById(state, id), { archivedAt: now }, now);
    return { state, changed: true, message: `已归档 ${ids.length} 个任务。` };
  }
  if (action === 'restore') {
    const ids = archivedTargets(state, args);
    for (const id of ids) {
      const task = taskById(state, id);
      if (!task.archivedAt) throw new Error(`任务 #${id} 未归档`);
    }
    for (const id of ids) changedTask(taskById(state, id), { archivedAt: undefined }, now);
    return { state, changed: true, message: `已恢复 ${ids.length} 个任务。` };
  }
  if (action === 'delete') {
    const task = taskById(state, positiveId(args.id));
    const referencedBy = state.tasks.filter((candidate) => (
      candidate.id !== task.id
      && candidate.status !== 'deleted'
      && (candidate.blockedBy || []).includes(task.id)
    ));
    if (referencedBy.length > 0) {
      throw new Error(`任务 #${task.id} 正被 ${referencedBy.map((item) => `#${item.id}`).join('、')} 依赖，不能删除`);
    }
    changedTask(task, {
      status: 'deleted',
      archivedAt: undefined,
      closedAt: undefined,
      closedReason: undefined,
    }, now);
    return { state, changed: true, message: `已删除任务 #${task.id}。` };
  }

  const count = state.tasks.filter((task) => task.status !== 'deleted').length;
  state.tasks = [];
  return { state, changed: count > 0, message: count > 0 ? `已清空 ${count} 个任务。` : '任务计划已经为空。' };
}

function taskLabel(task) {
  if (task.status === 'deleted') return `#${task.id} 已删除`;
  if (task.archivedAt) return `#${task.id} 已归档 ${task.subject}`;
  if (task.closedAt) return `#${task.id} 已结束 ${task.subject}`;
  if (task.status === 'completed') return `#${task.id} 已完成 ${task.subject}`;
  if (task.status === 'in_progress') return `#${task.id} 进行中 ${task.activeForm || task.subject}`;
  const blocked = (task.blockedBy || []).length
    ? `（依赖 ${task.blockedBy.map((id) => `#${id}`).join('、')}）`
    : '';
  return `#${task.id} 待开始 ${task.subject}${blocked}`;
}

function planText(state) {
  const nondel = state.tasks.filter((task) => task.status !== 'deleted');
  const visible = nondel.filter((task) => !task.archivedAt);
  const done = visible.filter((task) => task.status === 'completed').length;
  const archived = nondel.length - visible.length;
  if (visible.length === 0 && archived === 0) return '当前没有任务。';
  const lines = visible.slice(0, 40).map((task) => `- ${taskLabel(task)}`);
  if (visible.length > lines.length) lines.push(`- 另有 ${visible.length - lines.length} 项未显示`);
  if (archived > 0) lines.push(`- ${archived} 项已归档`);
  return `进度 ${done}/${visible.length}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

function createStudioTodoExtension(durable, piAi) {
  const { defineDoc, defineExtension, defineTool, Type } = { ...durable, Type: piAi.Type };
  const Todos = defineDoc({
    kind: TODO_DOC_KIND,
    version: TODO_SCHEMA_VERSION,
    scope: 'conversation',
    history: 'rewindable',
    fork: 'asOf',
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
    initial: emptyTodoState,
  });

  const status = Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ]);
  const taskItem = Type.Object({
    subject: Type.String({ minLength: 1, maxLength: MAX_SUBJECT_LENGTH }),
    description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION_LENGTH })),
    activeForm: Type.Optional(Type.String({ maxLength: MAX_ACTIVE_FORM_LENGTH })),
    blockedBy: Type.Optional(Type.Array(Type.Number({ minimum: 1 }), { maxItems: MAX_BLOCKED_BY })),
  });

  const todo = defineTool({
    name: 'todo',
    description: [
      'Create and maintain the visible execution plan shown above the composer.',
      'For multi-step work, call createMany before implementation, then start and complete tasks as work advances.',
      'Use one in_progress task at a time, complete each task immediately after its verification succeeds, and use update/list/get for the remaining lifecycle operations.',
      'Do not use todo for a simple one-step request, and do not describe a plan only in prose when this tool is available.',
    ].join(' '),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('create'),
        Type.Literal('createMany'),
        Type.Literal('update'),
        Type.Literal('list'),
        Type.Literal('get'),
        Type.Literal('start'),
        Type.Literal('complete'),
        Type.Literal('finish'),
        Type.Literal('reopen'),
        Type.Literal('close'),
        Type.Literal('archive'),
        Type.Literal('restore'),
        Type.Literal('delete'),
        Type.Literal('clear'),
      ]),
      id: Type.Optional(Type.Number({ minimum: 1, description: 'Target task ID.' })),
      ids: Type.Optional(Type.Array(Type.Number({ minimum: 1 }), {
        maxItems: MAX_CREATE_ITEMS,
        description: 'Target IDs for archive or restore.',
      })),
      subject: Type.Optional(Type.String({ maxLength: MAX_SUBJECT_LENGTH })),
      description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION_LENGTH })),
      activeForm: Type.Optional(Type.String({ maxLength: MAX_ACTIVE_FORM_LENGTH })),
      status: Type.Optional(status),
      blockedBy: Type.Optional(Type.Array(Type.Number({ minimum: 1 }), { maxItems: MAX_BLOCKED_BY })),
      items: Type.Optional(Type.Array(taskItem, { maxItems: MAX_CREATE_ITEMS })),
      closeReason: Type.Optional(Type.String({ maxLength: MAX_CLOSE_REASON_LENGTH })),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const conversationId = Number(api.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
        throw new Error('todo 只能在持久会话中运行');
      }
      const action = String(args?.action || '');
      const readOnly = action === 'list' || action === 'get';
      const mutationTaskId = Number(api.taskId);
      let details;
      let message;
      if (readOnly) {
        const state = normalizeTodoState(await api.snapshot(Todos, conversationId, context));
        const result = applyTodoMutation(state, args, api.now());
        details = publicDetails(result.state);
        message = result.message;
      } else {
        const committed = await api.commit(async (tx) => {
          const stored = await tx.doc(Todos, conversationId);
          const draft = normalizeTodoState(stored);
          if (Number.isSafeInteger(mutationTaskId) && mutationTaskId > 0
            && draft.lastMutationTaskId === mutationTaskId) {
            return {
              details: publicDetails(draft),
              message: '这次任务计划变更已经记录。',
            };
          }
          const applied = applyTodoMutation(draft, args, api.now());
          Object.assign(stored, applied.state);
          if (Number.isSafeInteger(mutationTaskId) && mutationTaskId > 0) {
            stored.lastMutationTaskId = mutationTaskId;
          }
          return {
            details: publicDetails(normalizeTodoState(stored)),
            message: applied.message,
          };
        }, context);
        details = committed.details;
        message = committed.message;
      }
      return {
        output: [{
          type: 'text',
          text: `${message}\n${planText(normalizeTodoState(details))}`,
        }],
        details,
      };
    },
  });

  return defineExtension({
    name: 'studio-todo',
    tools: [todo],
  });
}

module.exports = {
  TODO_DOC_KIND,
  TODO_SCHEMA_VERSION,
  applyTodoMutation,
  createStudioTodoExtension,
  emptyTodoState,
  normalizeTodoState,
  publicDetails,
};
