/**
 * Read-only projection of Durable child conversations.
 *
 * A subagent tool creates a child conversation owned by its tool task. The
 * renderer receives a compact DTO and never gets a Durable handle, task object,
 * storage path, or raw extension implementation.
 */

const { modelUsageTotals } = require('../../core/usage-totals.cjs');
const { getSubagentConfig } = require('../../core/app-settings.cjs');
const {
  createProtocol,
  queueSupervisorReply,
  emptyRegistry,
} = require('./protocol.cjs');
const {
  reconcileManagedWorktreesForChildren,
} = require('./worktrees.cjs');

const MAX_CHILDREN = 100;
const CONVERSATION_SCAN_PAGE = 200;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

async function fullDisplayMessages(...args) {
  return require('../../runtime/conversations.cjs').fullDisplayMessages(...args);
}

async function getConversationHandle(...args) {
  return require('../../runtime/conversations.cjs').getConversationHandle(...args);
}

async function purgeConversationData(...args) {
  return require('../../runtime/conversations.cjs').purgeConversationData(...args);
}

async function scanEntries(...args) {
  return require('../../runtime/conversations.cjs').scanEntries(...args);
}

async function getRuntime() {
  const {
    getDurableRuntime,
  } = require('../../runtime/durable-runtime.cjs');
  return getDurableRuntime();
}

function messageText(message) {
  return (message?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function taskStatus(task) {
  const state = task?.state;
  if (!state) return 'pending';
  if (['pending'].includes(state.status)) return 'pending';
  if (['running', 'completing'].includes(state.status)) return 'running';
  if (['waiting', 'sleeping'].includes(state.status)) return 'paused';
  if (state.status !== 'terminal') return 'running';
  const outcome = state.outcome?.status;
  if (outcome === 'completed') return 'completed';
  if (outcome === 'aborted') return 'stopped';
  return 'failed';
}

/**
 * Task outcomes are authoritative. A stale LiveDoc may still advertise a
 * run after an owned child has settled, but it must never reopen that child.
 */
function resolveSubagentStatus({
  taskStatusValue,
  liveRunning,
  cachedStatus,
  supervisorPending = 0,
}) {
  let status;
  if (TERMINAL_STATUSES.has(taskStatusValue)) status = taskStatusValue;
  else if (liveRunning) status = 'running';
  else if (taskStatusValue && taskStatusValue !== 'pending') status = taskStatusValue;
  else if (TERMINAL_STATUSES.has(cachedStatus)) status = cachedStatus;
  else status = cachedStatus || taskStatusValue || 'pending';
  if (supervisorPending > 0 && !liveRunning && !TERMINAL_STATUSES.has(status)) {
    return 'waiting';
  }
  return status;
}

function taskError(task) {
  const state = task?.state;
  if (state?.status !== 'terminal') return undefined;
  const outcome = state.outcome;
  if (outcome?.status === 'failed' || outcome?.status === 'faulted') {
    return outcome.error?.message || '子智能体执行失败';
  }
  if (outcome?.status === 'aborted') return outcome.reason || '子智能体已停止';
  if (outcome?.status === 'orphaned') return outcome.reason || '子智能体定义已不可用';
  return undefined;
}

function childKey(conversationId) {
  return `conversation:${conversationId}`;
}

/**
 * Child conversations are owned by a Durable tool task and intentionally do
 * not have a Studio SQLite projection. Resolve their handles through the
 * harness directly; using the parent conversation service would incorrectly
 * require a Studio row.
 */
async function openChildConversation(conversationId, runtimeOverride) {
  const id = Number(conversationId);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const runtime = runtimeOverride || await getRuntime();
  return runtime.harness.conversation(id, runtime.context);
}

async function ownedChildRecords(parent) {
  const runtime = await getRuntime();
  const records = [];
  let cursor;
  do {
    const page = await runtime.storage.scanConversations({
      ownerConversationId: parent.id,
      order: 'ascending',
    }, CONVERSATION_SCAN_PAGE, cursor, runtime.context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor && records.length < MAX_CHILDREN);
  return records.slice(0, MAX_CHILDREN);
}

/**
 * Resolve the model-issued or nested tool call that owns a child conversation.
 * This is read-only and uses the same Session consistency boundary.
 */
async function childTaskInfo(parent, taskId) {
  const runtime = await getRuntime();
  return parent.commit(async (tx) => {
    const task = await tx.task(taskId);
    if (!task) return undefined;
    const input = task.input;
    let call;
    if (input?.kind === 'model') {
      const entry = await tx.entry(input.assistant);
      call = entry?.model
        ?.flatMap((message) => message.content || [])
        .find((block) => block?.type === 'toolCall' && block.id === input.callId);
    } else if (input?.kind === 'nested') {
      call = input.call;
    }
    if (!call || !['subagent', 'subagents'].includes(call.name)) return undefined;
    return { task, call };
  }, runtime.context);
}

async function childDto(record, info, index, runtimeOverride, overrides = {}) {
  const conversation = await openChildConversation(record.id, runtimeOverride);
  if (!conversation) return undefined;
  const runtime = runtimeOverride || await getRuntime();
  const agent = await conversation.agent(runtime.context);
  const protocol = createProtocol(runtime.durable);
  const childContext = await runtime.harness.snapshot(
    protocol.ChildContext,
    conversation.id,
    runtime.context,
  );
  const usage = await runtime.harness.snapshot(runtime.durable.UsageDoc, conversation.id, runtime.context);
  const metricTotals = getStudioDatabase().metricTotalsForConversation(conversation.id);
  const messages = await fullDisplayMessages(conversation);
  const firstUser = messages.find((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const lastAssistant = [...assistantMessages].reverse().find((message) => messageText(message));
  const task = info?.task;
  const status = overrides.status || taskStatus(task);
  const inputTask = typeof info?.call?.arguments?.task === 'string'
    ? info.call.arguments.task.trim()
    : '';
  const taskText = inputTask || messageText(firstUser) || '子智能体任务';
  const preview = messageText(lastAssistant)
    || taskError(task)
    || (status === 'running' ? '正在独立上下文中执行…' : '等待输出');
  const model = agent.model
    ? `${agent.model.provider}/${agent.model.modelId}`
    : '';
  const startedAt = overrides.startedAt || task?.startedAt;
  const endedAt = overrides.endedAt || task?.endedAt;
  const durableUsage = modelUsageTotals(usage);
  return {
    key: childKey(record.id),
    runId: String(overrides.runId || task?.id || record.id),
    index,
    agent: overrides.agent || info?.call?.name || 'subagent',
    ...(overrides.name ? { name: overrides.name } : {}),
    task: taskText.slice(0, 4_000),
    status,
    source: overrides.source || (task?.background ? 'background' : 'foreground'),
    context: 'fresh',
    model,
    thinking: agent.thinkingLevel || '',
    cwd: agent.cwd || '',
    isolation: childContext?.isolation === 'worktree' ? 'worktree' : 'workspace',
    ...(childContext?.worktreeId ? { worktreeId: childContext.worktreeId } : {}),
    ...(startedAt ? { startedAt } : {}),
    updatedAt: endedAt || Date.now(),
    ...(startedAt && endedAt ? { durationMs: Math.max(0, endedAt - startedAt) } : {}),
    tokens: durableUsage.tokens ?? metricTotals.tokens,
    ...(durableUsage.referenceCostUsd !== undefined || metricTotals.cost > 0
      ? { referenceCostUsd: durableUsage.referenceCostUsd ?? metricTotals.cost }
      : {}),
    providerRequests: metricTotals.requests,
    toolCount: messages.filter((message) => message.role === 'toolResult').length,
    turnCount: assistantMessages.length,
    ...(overrides.supervisorPending ? { supervisorPending: overrides.supervisorPending } : {}),
    supervisorRequests: overrides.supervisorRequests || [],
    ...(overrides.lastReporterId ? { lastReporterId: overrides.lastReporterId } : {}),
    preview: preview.slice(0, 2_000),
    ...(overrides.error || taskError(task)
      ? { error: String(overrides.error || taskError(task)).slice(0, 2_000) }
      : {}),
    hasTranscript: true,
  };
}

async function listSubagentChildren(parentId) {
  const parent = await getConversationHandle(parentId);
  if (!parent) return [];
  const runtime = await getRuntime();
  const protocol = createProtocol(runtime.durable);
  const registry = await runtime.harness.snapshot(
    protocol.Subagents,
    parent.id,
    runtime.context,
  ) || emptyRegistry();
  const children = [];
  const seen = new Set();
  for (const agent of Object.values(registry.agents)) {
    if (!Number.isSafeInteger(Number(agent?.conversationId))) continue;
    const conversationId = Number(agent.conversationId);
    const live = await runtime.harness.snapshot(
      runtime.durable.LiveDoc,
      conversationId,
      runtime.context,
    );
    const pending = Object.values(registry.supervisorRequests)
      .filter((request) => (
        request?.childConversationId === conversationId
        && request.status === 'pending'
      )).length;
    const ownerTask = agent.ownerTaskId
      ? await runtime.harness.getTask(agent.ownerTaskId, runtime.context)
      : undefined;
    const reportTask = agent.lastReporterTaskId
      ? await runtime.harness.getTask(agent.lastReporterTaskId, runtime.context)
      : undefined;
    const statusTask = ownerTask || reportTask;
    const taskStatusValue = taskStatus(statusTask);
    // The foreground child is owned by the tool task. That task's terminal
    // outcome is authoritative; registry status is only a fast-path cache.
    let status = resolveSubagentStatus({
      taskStatusValue,
      liveRunning: Boolean(live?.run),
      cachedStatus: agent.lastStatus,
      supervisorPending: pending,
      supervisorRequests: Object.values(registry.supervisorRequests)
        .filter(request => request?.childConversationId === conversationId && request.status === 'pending')
        .map(request => ({ id: request.requestId, question: request.question, createdAt: request.createdAt })),
    });
    if (!['pending', 'running', 'completed', 'failed', 'stopped', 'paused', 'waiting'].includes(status)) {
      status = 'pending';
    }
    const registeredEndedAt = Number(agent.updatedAt) > Number(agent.createdAt)
      ? Number(agent.updatedAt)
      : undefined;
    const endedAt = TERMINAL_STATUSES.has(status)
      ? statusTask?.endedAt || registeredEndedAt
      : live?.run
        ? undefined
        : statusTask?.endedAt || registeredEndedAt;
    const child = await childDto({
      id: conversationId,
      owner: { kind: 'task', taskId: agent.anchorTaskId || agent.ownerTaskId || conversationId },
    }, undefined, children.length, runtime, {
      agent: 'subagent',
      name: agent.name,
      status,
      source: agent.mode === 'foreground' ? 'foreground' : 'background',
      runId: agent.lastReporterTaskId || agent.anchorTaskId || conversationId,
      startedAt: agent.createdAt,
      endedAt,
      supervisorPending: pending,
      lastReporterId: agent.lastReporterTaskId ? String(agent.lastReporterTaskId) : undefined,
      error: agent.lastError || taskError(statusTask),
    });
    if (child) {
      const firstUser = child.task !== '子智能体任务';
      child.agent = 'subagent';
      if (
        !live?.run
        && ['pending', 'running'].includes(child.status)
      ) {
        // Older Studio builds could leave the registry at "running" after the
        // foreground task settled. Prefer the owner outcome, then fall back to
        // a committed assistant answer when the old task record is unavailable.
        const recovered = taskStatus(ownerTask);
        if (recovered !== 'pending') child.status = recovered;
        else if (child.turnCount > 0) child.status = 'completed';
      }
      if (!firstUser && reportTask?.state?.outcome?.status === 'failed') {
        child.status = 'failed';
      }
      children.push(child);
      seen.add(conversationId);
    }
  }
  const records = await ownedChildRecords(parent);
  for (const record of records) {
    if (seen.has(Number(record.id))) continue;
    const taskId = record.owner?.taskId;
    if (taskId === undefined) continue;
    const info = await childTaskInfo(parent, taskId);
    if (!info) continue;
    const child = await childDto(record, info, children.length, runtime);
    if (child) {
      children.push(child);
      seen.add(Number(record.id));
    }
  }
  const sorted = children.sort((left, right) => (
    Number(left.startedAt || 0) - Number(right.startedAt || 0)
    || Number(left.index) - Number(right.index)
  )).map((child, index) => ({ ...child, index }));
  await reconcileManagedWorktreesForChildren(sorted).catch((error) => {
    console.warn('Unable to reconcile managed worktrees:', error);
  });
  return sorted;
}

async function subagentTranscript(parentId, childKeyValue, options = {}) {
  const children = await listSubagentChildren(parentId);
  const child = children.find((item) => item.key === childKeyValue);
  if (!child) throw new Error('子智能体不属于当前会话');
  const conversationId = Number(childKeyValue.slice('conversation:'.length));
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    throw new Error('子智能体标识无效');
  }
  const conversation = await openChildConversation(conversationId);
  if (!conversation) throw new Error('子智能体会话不存在');
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
  const page = await scanEntries(conversation, {
    order: 'descending',
    messageLimit: limit,
    cursor: options.cursor,
  });
  return {
    child,
    messages: page.messages,
    totalMessages: (await fullDisplayMessages(conversation)).length,
    hasMore: page.hasOlder,
    messageStart: page.messages[0]?.sourceIndex ?? 0,
  };
}

/**
 * Delete one child only after proving that it belongs to the supplied parent.
 * The child is stopped first, then its Durable tree is purged, and finally the
 * parent's registry entry is retired. A failed registry write therefore leaves
 * a stale reference that cannot resolve to a conversation, never an orphaned
 * live child hidden from the overview.
 */
async function deleteSubagentChild(parentId, childKeyValue) {
  if (typeof childKeyValue !== 'string' || !childKeyValue.startsWith('conversation:')) {
    throw new Error('子智能体标识无效');
  }
  const parent = await getConversationHandle(parentId);
  if (!parent) throw new Error('父会话不存在');
  const children = await listSubagentChildren(parentId);
  const child = children.find((item) => item.key === childKeyValue);
  if (!child) throw new Error('子智能体不属于当前会话');
  const conversationId = Number(childKeyValue.slice('conversation:'.length));
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    throw new Error('子智能体标识无效');
  }
  const runtime = await getRuntime();
  const protocol = createProtocol(runtime.durable);
  const childConversation = await openChildConversation(conversationId, runtime);
  if (!childConversation) throw new Error('子智能体会话不存在');
  await childConversation.abort(runtime.context, { background: true });
  // Purging waits for all owned tasks to settle before removing worktrees.
  const removed = await purgeConversationData([conversationId]);

  await parent.commit(async (tx) => {
    const registry = await tx.doc(protocol.Subagents, parent.id);
    const names = Object.entries(registry.agents)
      .filter(([, agent]) => Number(agent?.conversationId) === conversationId)
      .map(([name]) => name);
    for (const name of names) {
      const reporterTaskId = registry.agents[name]?.lastReporterTaskId;
      delete registry.agents[name];
      for (const [requestKey, reporter] of Object.entries(registry.reporters || {})) {
        if (
          reporter?.name === name
          || Number(reporter?.taskId) === Number(reporterTaskId)
        ) {
          delete registry.reporters[requestKey];
        }
      }
    }
    for (const [requestId, request] of Object.entries(registry.supervisorRequests || {})) {
      if (Number(request?.childConversationId) === conversationId) {
        delete registry.supervisorRequests[requestId];
      }
    }
  }, runtime.context);

  return {
    ok: true,
    deletedChildKey: child.key,
    name: child.name || child.agent,
    deletedConversations: removed.conversationIds.length,
  };
}

async function replySubagentSupervisor(parentId, childKeyValue, requestId, messageValue) {
  const message = typeof messageValue === 'string' ? messageValue.trim() : '';
  if (!message || message.length > 16_000) throw new Error('监督回复不能为空，且不能超过 16000 个字符');
  if (typeof requestId !== 'string' || !requestId) throw new Error('监督请求标识无效');
  const parent = await getConversationHandle(parentId);
  if (!parent) throw new Error('父会话不存在');
  const children = await listSubagentChildren(parentId);
  const child = children.find((item) => item.key === childKeyValue);
  if (!child) throw new Error('子智能体不属于当前会话');
  const conversationId = Number(childKeyValue.slice('conversation:'.length));
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) throw new Error('子智能体标识无效');
  const runtime = await getRuntime();
  const agent = await parent.agent(runtime.context);
  const project = getSubagentConfig('project', agent?.cwd || '');
  const user = getSubagentConfig('user');
  const maximum = Math.max(1, Math.min(16, Number(project?.maxConcurrent || user?.maxConcurrent || 4)));
  const reporter = await parent.commit((tx) => queueSupervisorReply({
    tx,
    durable: runtime.durable,
    parentConversationId: parent.id,
    replyTo: requestId,
    message,
    now: Date.now(),
    maximum,
    childConversationId: conversationId,
  }), runtime.context);
  return {
    ok: true,
    requestId,
    childKey: child.key,
    reporterTaskId: String(reporter.taskId),
  };
}

module.exports = {
  deleteSubagentChild,
  listSubagentChildren,
  openChildConversation,
  replySubagentSupervisor,
  resolveSubagentStatus,
  subagentTranscript,
};
