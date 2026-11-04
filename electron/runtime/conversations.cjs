/**
 * Durable conversation domain service.
 *
 * Pi Durable owns transcripts, submissions, live generation, tasks, inboxes,
 * usage, and forking. Studio SQLite owns only the user-facing projection:
 * workspace grouping, names, pin/archive state, and the long-task goal.
 *
 * The renderer never sees an AgentSession-shaped event stream. It receives
 * committed, JSON-safe DTOs and a single snapshot-backed conversation event
 * stream.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  deleteWorkspaceScopedSettings,
  deletePermissionSessionPolicy,
  getRuntimePolicy,
} = require('../core/app-settings.cjs');
const { getStudioModelsRuntime } = require('../core/studio-models.cjs');
const durableView = require('./view.cjs');
const {
  getDurableRuntime,
  latestEntry,
  reconcileRuntimeForWorkspace,
} = require('./durable-runtime.cjs');
const { guardSensitiveInput } = require('../services/sensitive-input-guard.cjs');
const {
  concreteThinkingLevel,
  enabledRuntimeModel,
  modelInfo,
  runtimeModelFor,
  sessionModelInfo,
  splitModelRef,
  validateThinkingLevel,
} = require('../services/models.cjs');
const { fileReferenceContext } = require('../services/workspace.cjs');
const {
  attachmentContext,
  removeAttachmentDirectory,
} = require('../services/attachments.cjs');
const {
  beginTurn,
  endTurn,
  saveTurnDiff,
} = require('../services/turn-diff.cjs');
const { runtimeSelection } = require('./tool-selection.cjs');
const {
  extensionComposerCommands,
  purgeProjectWorkspaceState,
} = require('../services/studio-extensions.cjs');
const {
  composerSkills,
  expandSkillCommand,
} = require('../capabilities/skills/index.cjs');
const {
  generateConversationTitleAfterIdle,
  temporaryTitle,
} = require('../services/conversation-title.cjs');
const {
  clearLongTaskState,
  completeLongTaskState,
  continuationText,
  createLongTaskContract,
  editLongTaskState,
  emptyLongTaskState,
  initializeLongTaskState,
  isLongTaskContinuation,
  nextLongTaskContinuationGuard,
  normalizeLongTaskState,
  publicLongTaskState,
  readLongTaskState,
  replaceLongTaskState,
  shouldStartLongTaskGoal,
  validateLongTaskGoal,
} = require('../capabilities/long-task/index.cjs');
const {
  onRequestTrace,
} = require('../capabilities/request-trace/index.cjs');
const {
  discardManagedWorktreesForConversations,
} = require('../capabilities/subagents/index.cjs');

const DEFAULT_PAGE_SIZE = 80;
const MAX_PAGE_SIZE = 2_000;
const ENTRY_SCAN_PAGE_SIZE = 300;
const MAX_OUTLINE_ITEMS = 10_000;
const MAX_OUTLINE_TEXT = 2_000;
const MAX_TRACKED_CONVERSATION_COUNTS = 2_000;
const BUSY_POLICIES = new Set(['steer', 'followUp', 'reject']);
// 1.5.0 起待调度态叫 `pending`（1.4.0 叫 `ready`），其余不变。
const ACTIVE_TASK_STATES = new Set(['running', 'pending', 'waiting', 'sleeping']);

const watches = new Map();
const subscribers = new Map();
const messageCounts = new Map();
const runningConversations = new Set();
const runDiffSnapshots = new Map();
const editRangesCache = new Map();
const REQUEST_TRACE_PAGE_LIMIT = 16;

onRequestTrace(async (trace) => {
  const numericConversationId = normalizeId(trace?.conversationId);
  if (!numericConversationId) return;
  const row = await getConversationRow(String(numericConversationId));
  const key = row ? conversationKey(row) : String(numericConversationId);
  const dto = {
    ...trace,
    conversationId: key,
  };
  if (!getStudioDatabase().saveRequestTrace(key, dto)) return;
  const entry = watches.get(key);
  if (!entry) return;
  entry.revision += 1;
  await entry.emit({
    type: 'request.trace',
    conversationId: key,
    revision: entry.revision,
    payload: { trace: dto },
  });
});

function rememberMessageCount(id, count) {
  const key = String(id);
  messageCounts.delete(key);
  messageCounts.set(key, count);
  while (messageCounts.size > MAX_TRACKED_CONVERSATION_COUNTS) {
    messageCounts.delete(messageCounts.keys().next().value);
  }
}

function normalizeId(id) {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function encodeCursor(cursor) {
  if (!cursor) return undefined;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  if (typeof cursor === 'object') return cursor;
  if (typeof cursor !== 'string') throw new Error('历史分页游标无效');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new Error('历史分页游标已失效，请重新打开会话');
  }
}

function conversationDto(row, overrides = {}) {
  if (!row) return undefined;
  return {
    id: String(row.publicId || row.id),
    cwd: row.workspace,
    title: row.title || '新会话',
    kind: row.kind === 'durable' ? 'durable' : 'conversation',
    goal: row.goal || '',
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(Number.isFinite(row.lastDurationMs) ? { lastDurationMs: row.lastDurationMs } : {}),
    ...overrides,
  };
}

async function longTaskDto(row) {
  if (!row) return undefined;
  const runtime = await getDurableRuntime();
  const state = await readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
  if (state.enabled || state.goal) return state;
  if (!row.goal) return state;
  // Durable documents are authoritative. This read-only fallback keeps older
  // Studio projections visible until their first submission initializes it.
  const legacy = normalizeLongTaskState(emptyLongTaskState());
  legacy.enabled = true;
  legacy.goal = row.goal;
  legacy.completionCriteria = row.goal;
  legacy.status = 'active';
  return publicLongTaskState(legacy);
}

function liveSnapshotDto(conversation, snapshot, extra = {}) {
  const runtime = snapshot?.run;
  return conversationDto(conversation, {
    // A model run and the Studio conversation have different lifetimes. A
    // background subagent can outlive the main generation, so the task
    // inspection projection is the authoritative "conversation still active"
    // signal. `snapshot.run` only protects against the brief registration race.
    running: Boolean(runtime) || runningConversations.has(conversationKey(conversation)),
    requestId: runtime?.inputs?.length ? conversation.lastRequestId : '',
    compacting: Boolean(snapshot?.compactions?.length),
    generation: snapshot?.generation?.message
      ? partialMessage(snapshot.generation.message)
      : undefined,
    retry: snapshot?.generation?.retry,
    inbox: snapshot?.inbox || [],
    tools: snapshot?.tools || [],
    nestedTools: snapshot?.nestedTools || [],
    usage: snapshot?.usage,
    agent: snapshot?.agent || {},
    ...extra,
  });
}

async function getConversationRow(id) {
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  return getStudioDatabase().getConversation(String(id));
}

async function getConversationHandle(id, options = {}) {
  const row = await getConversationRow(id);
  const normalized = normalizeId(row?.id);
  if (!normalized) return undefined;
  if (row?.workspace) await reconcileRuntimeForWorkspace(row.workspace, options);
  const runtime = await getDurableRuntime();
  return runtime.harness.conversation(normalized, runtime.context);
}

function conversationKey(row) {
  return String(row?.publicId || row?.id || '');
}

function contentToChat(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === 'text') return [{ type: 'text', text: String(block.text || '') }];
    if (block?.type === 'image') return [{
      type: 'image',
      data: block.data,
      mimeType: block.mimeType,
    }];
    if (block?.type === 'thinking') return [{
      type: 'thinking',
      thinking: String(block.thinking || ''),
      redacted: Boolean(block.redacted),
    }];
    if (block?.type === 'toolCall') return [{
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: block.arguments || {},
      ...(block.namespace ? { namespace: block.namespace } : {}),
    }];
    return [];
  });
}

function messageToChat(message, entry) {
  if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) return [];
  const data = entry.data && typeof entry.data === 'object' ? entry.data : {};
  if (message.role === 'user') {
    if (isLongTaskContinuation(message.content)) return [];
    const images = contentToChat(message.content).filter((block) => block.type === 'image');
    const displayContent = typeof data.displayText === 'string'
      ? [
          ...(data.displayText ? [{ type: 'text', text: data.displayText }] : []),
          ...images,
        ]
      : contentToChat(message.content);
    return [{
      role: 'user',
      content: displayContent,
      timestamp: message.timestamp,
      sourceIndex: Number(entry.id),
      ...(Array.isArray(data.attachments) ? { attachments: data.attachments } : {}),
    }];
  }
  if (message.role === 'assistant') {
    const taskId = entry.byTaskId === undefined || entry.byTaskId === null
      ? ''
      : String(entry.byTaskId);
    return [{
      role: 'assistant',
      content: contentToChat(message.content),
      timestamp: message.timestamp,
      ...(taskId ? { taskId } : {}),
      sourceIndex: Number(entry.id),
      streaming: false,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      model: message.model,
      provider: message.provider,
      usage: message.usage,
      thinkingLevel: message.thinkingLevel,
    }];
  }
  return [{
    role: 'toolResult',
    content: contentToChat(message.content),
    timestamp: message.timestamp,
    sourceIndex: Number(entry.id),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: Boolean(message.isError),
    durationMs: message.durationMs,
    details: message.details,
    usage: message.usage,
  }];
}

function entryToMessages(entry) {
  if (!['pi.user', 'studio.user', 'pi.assistant', 'pi.tool-result'].includes(entry.kind)) return [];
  return (entry.model || []).flatMap((message) => messageToChat(message, entry));
}

function partialMessage(message) {
  return messageToChat(message, { id: 0, data: undefined })[0];
}

function editToken(entry) {
  const token = entry.data && typeof entry.data === 'object'
    ? entry.data.editToken
    : undefined;
  return typeof token === 'string' && token
    ? token
    : `entry:${entry.id}`;
}

/**
 * Studio edit markers are immutable Durable entries. A marker maps a user
 * message to the branch it replaced; a restore marker withdraws that range
 * when the replacement input could not be admitted.
 */
async function loadEditRanges(conversation) {
  const cacheKey = String(conversation.id);
  if (editRangesCache.has(cacheKey)) return editRangesCache.get(cacheKey);
  const runtime = await getDurableRuntime();
  const active = new Map();
  let cursor;
  do {
    const page = await conversation.entries(
      { order: 'ascending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    for (const entry of page.items) {
      if (entry.kind === 'studio.edit') {
        const from = Number(entry.data?.editFrom);
        const through = Number(entry.id);
        if (
          Number.isSafeInteger(from)
          && from > 0
          && Number.isSafeInteger(through)
          && from <= through
        ) {
          active.set(editToken(entry), { from, through });
        }
      } else if (entry.kind === 'studio.edit-restore') {
        active.delete(editToken(entry));
      }
    }
    cursor = page.next;
  } while (cursor);
  const ranges = [...active.values()];
  editRangesCache.set(cacheKey, ranges);
  return ranges;
}

function entryIsHidden(entryId, ranges) {
  const id = Number(entryId);
  return ranges.some((range) => id >= range.from && id <= range.through);
}

/**
 * 一次历史扫描的停止条件。
 *
 * @returns {'complete' | 'limit' | 'continue' | 'exhausted'}
 */
function scanStopReason({ count, messageLimit, hasMoreEntries }) {
  // 扫描上限等于页大小：凑满一页就先停下，剩下的交给游标。
  if (count >= messageLimit) return 'limit';
  return hasMoreEntries ? 'continue' : 'exhausted';
}

async function scanEntries(conversation, options = {}) {
  const runtime = await getDurableRuntime();
  const editRanges = await loadEditRanges(conversation);
  const order = options.order === 'ascending' ? 'ascending' : 'descending';
  const messageLimit = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Number(options.messageLimit) || DEFAULT_PAGE_SIZE),
  );
  const groups = [];
  const decoded = decodeCursor(options.cursor);
  if (decoded && decoded.version !== 2) {
    throw new Error('历史分页游标版本已更新，请重新打开会话');
  }
  if (decoded && decoded.order !== order) {
    throw new Error('历史分页方向与游标不一致');
  }
  let cursor = decoded?.upstream;
  let skip = Math.max(0, Number(decoded?.skip) || 0);
  let nextCursor;
  let exhausted = false;
  let count = 0;

  while (count < messageLimit) {
    const page = await conversation.entries(
      { order },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    let consumedInPage = 0;
    let pageMessages = 0;
    for (const entry of page.items) {
      const entryMessages = entryIsHidden(entry.id, editRanges)
        ? []
        : entryToMessages(entry);
      pageMessages += entryMessages.length;
      if (skip >= entryMessages.length) {
        skip -= entryMessages.length;
        consumedInPage += entryMessages.length;
        continue;
      }
      const available = entryMessages.slice(skip);
      consumedInPage += skip;
      skip = 0;
      const take = available.slice(0, Math.max(0, messageLimit - count));
      if (take.length > 0) groups.push(take);
      count += take.length;
      consumedInPage += take.length;
      if (scanStopReason({ count, messageLimit, hasMoreEntries: true }) !== 'continue') break;
    }

    const pageHasUnconsumedMessages = consumedInPage < pageMessages;
    const stop = scanStopReason({ count, messageLimit, hasMoreEntries: Boolean(page.next) });
    if (stop === 'complete' || stop === 'limit') {
      if (pageHasUnconsumedMessages || page.next) {
        nextCursor = encodeCursor({
          version: 2,
          order,
          upstream: cursor,
          skip: consumedInPage,
        });
      } else {
        exhausted = true;
      }
      break;
    }
    if (!page.next) {
      exhausted = true;
      break;
    }
    cursor = page.next;
    skip = 0;
  }

  const display = order === 'ascending'
    ? groups.flat()
    : [...groups].reverse().flat();
  const messages = display.slice(0, messageLimit);
  return {
    messages,
    hasOlder: order === 'descending' && Boolean(nextCursor) && !exhausted,
    nextCursor: order === 'descending' ? nextCursor : undefined,
  };
}

async function scanDisplayMessages(conversation, visit) {
  const runtime = await getDurableRuntime();
  const editRanges = await loadEditRanges(conversation);
  let cursor;
  do {
    const page = await conversation.entries(
      { order: 'ascending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    for (const entry of page.items) {
      if (entryIsHidden(entry.id, editRanges)) continue;
      for (const message of entryToMessages(entry)) visit(message);
    }
    cursor = page.next;
  } while (cursor);
}

async function fullDisplayMessages(conversation) {
  const messages = [];
  await scanDisplayMessages(conversation, (message) => messages.push(message));
  return messages;
}

async function firstUserQuestion(conversation) {
  const runtime = await getDurableRuntime();
  const editRanges = await loadEditRanges(conversation);
  let cursor;
  do {
    const page = await conversation.entries(
      { order: 'ascending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    for (const entry of page.items) {
      if (entryIsHidden(entry.id, editRanges)) continue;
      const message = entryToMessages(entry).find((item) => item.role === 'user');
      if (!message) continue;
      return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    cursor = page.next;
  } while (cursor);
  return '';
}

async function conversationMessageSummary(conversation, options = {}) {
  const items = [];
  let totalMessages = 0;
  await scanDisplayMessages(conversation, (message) => {
    totalMessages += 1;
    if (!options.outline || message.role !== 'user' || items.length >= MAX_OUTLINE_ITEMS) return;
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_OUTLINE_TEXT) || '消息';
    items.push({
      sourceIndex: message.sourceIndex || 0,
      text,
      timestamp: message.timestamp,
    });
  });
  return { items, totalMessages };
}

async function temporarySnapshot(conversation) {
  const runtime = await getDurableRuntime();
  const watch = await conversation.watch(runtime.context);
  try {
    return durableView.liveFromView(watch.value);
  } finally {
    await watch.stop().catch(() => {});
  }
}

async function reconcileWatchSnapshot(entry, conversation) {
  if (!entry || !entry.running) return entry?.snapshot;
  const fresh = await temporarySnapshot(conversation);
  if (fresh?.run) return entry.snapshot;
  // The event stream can briefly lag the task projection. Refresh it before
  // closing the live entry; background tasks are still part of this Studio
  // conversation even though they do not keep Durable's parent run busy.
  await refreshRuntimeState();
  entry.snapshot = fresh;
  entry.partial = fresh?.generation?.message;
  entry.running = false;
  return fresh;
}

async function conversationSnapshot(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) return undefined;
  await refreshRuntimeState();
  const key = conversationKey(row);
  const entry = watches.get(key);
  const snapshot = entry
    ? await reconcileWatchSnapshot(entry, conversation)
    : await temporarySnapshot(conversation);
  const agent = await conversation.agent((await getDurableRuntime()).context);
  return liveSnapshotDto(row, snapshot, {
    durableSessionId: String(row.id),
    model: await sessionModelInfo(agent),
    turnDiffs: getStudioDatabase().readTurnDiffs(key),
    longTask: await longTaskDto(row),
    requestTraces: getStudioDatabase().listRequestTraces(key, {
      limit: REQUEST_TRACE_PAGE_LIMIT,
    }),
  });
}

async function conversationPage(id, options = {}) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) return undefined;
  await refreshRuntimeState();
  const page = await scanEntries(conversation, {
    order: 'descending',
    messageLimit: options.limit,
    cursor: options.cursor,
  });
  const agent = await conversation.agent((await getDurableRuntime()).context);
  const key = conversationKey(row);
  const entry = watches.get(key);
  const snapshot = entry
    ? await reconcileWatchSnapshot(entry, conversation)
    : await temporarySnapshot(conversation);
  const turnDiffs = getStudioDatabase().readTurnDiffs(key);
  rememberMessageCount(key, Math.max(
    messageCounts.get(key) || 0,
    page.messages.length,
  ));
  return liveSnapshotDto(row, snapshot, {
    messages: page.messages,
    model: await sessionModelInfo(agent),
    turnDiffs,
    longTask: await longTaskDto(row),
    requestTraces: getStudioDatabase().listRequestTraces(key, {
      limit: REQUEST_TRACE_PAGE_LIMIT,
    }),
    page: {
      hasOlder: page.hasOlder,
      nextCursor: page.nextCursor,
    },
    messageStart: page.messages[0]?.sourceIndex ?? 0,
  });
}

async function outline(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) return undefined;
  const summary = await conversationMessageSummary(conversation, { outline: true });
  rememberMessageCount(row.id, summary.totalMessages);
  return {
    id: conversationKey(row),
    items: summary.items,
    totalMessages: summary.totalMessages,
  };
}

function validateWorkspace(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('请先选择一个工作区，再开始对话。');
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error('工作区文件夹不存在，请重新选择。');
  }
  return path.resolve(cwd);
}

async function createConversation({ cwd, title = '新会话', goal = '' } = {}) {
  const workspace = validateWorkspace(cwd);
  const cleanGoal = String(goal || '').trim();
  const runtime = await getDurableRuntime();
  const modelRuntime = await getStudioModelsRuntime();
  await reconcileRuntimeForWorkspace(workspace, { verifyExtensionIntegrity: true });
  const agentSelection = await runtimeSelection({
    longTask: Boolean(cleanGoal),
  });
  const modelSelection = await modelInfo(workspace);
  const ref = splitModelRef(modelSelection.modelRef);
  const model = runtimeModelFor(modelRuntime.models, ref);
  if (!model) throw new Error('没有可用模型，请先在设置中配置模型来源与 API Key');
  const thinkingLevel = modelSelection.effectiveThinkingLevel;
  const longTaskContract = createLongTaskContract(runtime.durable);
  const conversation = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: {
      model: { provider: ref.provider, modelId: ref.modelId },
      thinkingLevel,
      cwd: workspace,
      extensions: agentSelection.extensions,
      tools: agentSelection.tools,
    },
    ...(cleanGoal
      ? {
          init: async (tx, conversationId) => {
            const state = await tx.doc(
              longTaskContract.LongTask,
              conversationId,
            );
            initializeLongTaskState(state, {
              goal: cleanGoal,
              completionCriteria: cleanGoal,
              status: 'active',
              now: Date.now(),
            });
          },
        }
      : {}),
  }, runtime.context);
  const row = getStudioDatabase().insertConversation({
    id: String(conversation.id),
    workspace,
    kind: 'conversation',
    title: String(title || '新会话').trim() || '新会话',
    goal: cleanGoal,
  });
  return conversationDto(row, {
    messages: [],
    model: await sessionModelInfo({
      model: { provider: ref.provider, modelId: ref.modelId },
      thinkingLevel,
    }),
    longTask: await longTaskDto(row),
    page: { hasOlder: false },
  });
}

async function listWorkspaces() {
  await refreshRuntimeState();
  const db = getStudioDatabase();
  const groups = new Map();
  for (const workspace of db.listWorkspaces().filter((item) => !item.hidden)) {
    groups.set(workspace.cwd, {
      cwd: workspace.cwd,
      name: workspace.name,
      sessions: [],
    });
  }
  for (const row of db.listConversations({ includeArchived: true })) {
    if (!groups.has(row.workspace)) {
      groups.set(row.workspace, {
        cwd: row.workspace,
        name: path.basename(row.workspace) || row.workspace,
        sessions: [],
      });
    }
    groups.get(row.workspace).sessions.push(conversationDto(row, {
      messageCount: messageCounts.get(conversationKey(row)) || 0,
      running: runningConversations.has(conversationKey(row)),
    }));
  }
  return [...groups.values()]
    .map((workspace) => {
      const sessions = workspace.sessions.sort((a, b) => (
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
      ));
      return {
        ...workspace,
        sessions,
        sessionCount: sessions.length,
        archivedCount: sessions.filter((session) => session.archived).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function inputContent({ cwd, text, mentions, attachments, images }) {
  const blocks = [];
  const referenceBlocks = await fileReferenceContext(cwd, mentions);
  const attachedBlocks = await attachmentContext(attachments);
  const connected = [...referenceBlocks, ...attachedBlocks];
  const referenceText = connected
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
  const referenceImages = connected.filter((block) => block?.type === 'image');
  const prefix = String(text || '').trim();
  const body = [prefix, referenceText].filter(Boolean).join('\n\n');
  if (body) blocks.push({ type: 'text', text: body });
  blocks.push(...referenceImages);
  for (const image of Array.isArray(images) ? images : []) {
    if (image?.type === 'image' && image.data && image.mimeType) {
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(empty message)' });
  return blocks;
}

function busyPolicy(value) {
  return BUSY_POLICIES.has(value) ? value : 'followUp';
}

async function prepareLongTaskSubmission({ row, conversation, text }) {
  const runtime = await getDurableRuntime();
  const { LongTask } = createLongTaskContract(runtime.durable);
  const cleanGoal = String(text || '').trim();
  let projectionGoal = '';
  await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const state = normalizeLongTaskState(stored);
    const now = Date.now();
    // Older Studio rows may still carry only the SQLite goal projection.
    // Promote that value before considering the new message as the goal.
    const initialGoal = row.goal || (row.kind === 'durable' ? cleanGoal : '');
    if (!state.goal && initialGoal) {
      initializeLongTaskState(state, {
        goal: initialGoal,
        completionCriteria: initialGoal,
        status: 'active',
        now,
      });
      projectionGoal = state.goal;
    } else if (state.enabled && state.goal && state.status === 'idle') {
      state.status = 'active';
      state.updatedAt = now;
    } else if (state.enabled && state.goal && state.status === 'blocked') {
      // A user reply is the signal that the missing input has been supplied.
      state.status = 'active';
      state.blockReason = '';
      state.blockedAt = 0;
      state.updatedAt = now;
    }
    Object.assign(stored, normalizeLongTaskState(state));
  }, runtime.context);
  if (projectionGoal) {
    getStudioDatabase().updateConversation(row.id, { goal: projectionGoal });
  }
  return readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
}

async function submitConversation(input = {}, options = {}) {
  const row = await getConversationRow(input.id || input.sessionId);
  const conversation = await getConversationHandle(input.id || input.sessionId, {
    verifyExtensionIntegrity: true,
  });
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const displayText = String(input.text || '').trim();
  await guardSensitiveInput({ sessionId: row.publicId, text: displayText });
  const longTask = await prepareLongTaskSubmission({
    row,
    conversation,
    text: displayText,
  });
  const selection = await runtimeSelection({
    kind: row.kind,
    longTask: Boolean(longTask?.enabled && longTask?.goal),
  });
  await conversation.configure({
    extensions: selection.extensions,
    tools: selection.tools,
  }, runtime.context);
  const content = await inputContent({
    cwd: row.workspace,
    text: expandSkillCommand(input.text, row.workspace),
    mentions: input.mentions,
    attachments: input.attachments,
    images: input.images,
  });
  if (content.some((block) => block?.type === 'image')) {
    const agent = await conversation.agent(runtime.context);
    const studioModels = await getStudioModelsRuntime();
    const model = runtimeModelFor(studioModels.models, agent.model);
    if (!Array.isArray(model?.input) || !model.input.includes('image')) {
      throw new Error(`${model?.name || '当前模型'} 不支持图片输入，请切换模型后重试`);
    }
  }
  const requestId = typeof input.requestId === 'string' && input.requestId
    ? input.requestId
    : randomUUID();
  const submission = await conversation.submit({
    type: 'input',
    content,
    requestId,
    whenBusy: options.edit ? 'reject' : busyPolicy(input.whenBusy),
    entry: {
      kind: 'studio.user',
      data: {
        displayText,
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
      },
    },
  }, runtime.context);
  options.onAdmitted?.();
  const record = await submission.status(runtime.context);
  const repairingFallbackTitle = row.titleSource === 'auto-fallback';
  const needsInitialTitle = row.title === '新会话';
  const shouldGenerateTitle = (
    !options.edit
    &&
    (needsInitialTitle || repairingFallbackTitle)
    && Boolean(displayText)
  );
  const titleQuestion = repairingFallbackTitle
    ? (await firstUserQuestion(conversation) || displayText)
    : displayText;
  const nextTitle = needsInitialTitle ? temporaryTitle(displayText) : row.title;
  getStudioDatabase().updateConversation(row.id, {
    ...(options.edit ? {} : { title: nextTitle }),
    ...(options.edit ? {} : {
      titleSource: shouldGenerateTitle ? 'auto-pending' : row.titleSource,
    }),
    lastRequestId: requestId,
    updatedAt: Date.now(),
  });
  if (shouldGenerateTitle) {
    void (async () => {
      const db = getStudioDatabase();
      let generated = '';
      try {
        const modelRuntime = await getStudioModelsRuntime();
        generated = await generateConversationTitleAfterIdle({
          conversation,
          context: runtime.context,
          question: titleQuestion,
          getModel: async () => {
            const agent = await conversation.agent(runtime.context);
            return runtimeModelFor(modelRuntime.models, agent.model);
          },
          complete: (selectedModel, context, requestOptions) => (
            modelRuntime.models.completeSimple(
              selectedModel,
              context,
              requestOptions,
            )
          ),
        });
      } catch {
        // Naming is optional and must never affect the submitted prompt.
      }
      const latest = db.getConversation(row.id);
      if (!latest || latest.titleSource !== 'auto-pending') return;
      if (!generated) {
        db.updateConversation(row.id, {
          titleSource: 'auto-fallback',
          updatedAt: latest.updatedAt,
        });
        return;
      }
      db.updateConversation(row.id, {
        title: generated,
        titleSource: 'auto-generated',
        updatedAt: latest.updatedAt,
      });
      try {
        await options.onTitleUpdated?.({
          id: conversationKey(latest),
          title: generated,
        });
      } catch {
        // Sidebar/menu-bar presentation failure does not invalidate the title.
      }
    })().catch(() => {
      // Database shutdown while the app exits is not a user-facing failure.
    });
  }
  return {
    conversationId: conversationKey(row),
    submissionId: String(submission.id),
    requestId,
    status: record.status,
    whenBusy: options.edit ? 'reject' : busyPolicy(input.whenBusy),
  };
}

/**
 * Edit a user message by appending a Durable context boundary and then
 * submitting the replacement as a normal user input. Old answers remain
 * auditable Durable entries, but neither the model nor Studio's transcript
 * projection sees them after the edit.
 */
async function editConversation(input = {}, options = {}) {
  const id = input.id || input.sessionId;
  const entryId = Number(input.entryId);
  const text = String(input.text || '').trim();
  if (!text) throw new Error('编辑后的消息不能为空');
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    throw new Error('要编辑的消息标识无效');
  }

  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id, {
    verifyExtensionIntegrity: true,
  });
  if (!row || !conversation) throw new Error('会话不存在');

  const runtime = await getDurableRuntime();
  const inspection = await runtime.harness.inspect(runtime.context);
  const durableConversationId = String(row.id);
  const hasLiveTask = inspection.tasks.some((task) => (
    ACTIVE_TASK_STATES.has(task.state.kind)
    && String(task.record?.conversationId || '') === durableConversationId
  ));
  const hasSubmission = inspection.submissions.some((submission) => (
    String(submission.conversationId || '') === durableConversationId
    && (submission.status === 'queued' || submission.status === 'placed')
  ));
  if (hasLiveTask || hasSubmission) {
    throw new Error('当前会话仍在运行，请停止回答后再编辑消息');
  }

  const [context, editRanges] = await Promise.all([
    conversation.context(runtime.context),
    loadEditRanges(conversation),
  ]);
  const targetIndex = context.entries.findIndex((entry) => Number(entry.id) === entryId);
  if (targetIndex < 0) {
    throw new Error('这条消息不在当前可编辑的上下文范围内');
  }
  if (entryIsHidden(entryId, editRanges)) {
    throw new Error('这条消息已经被后续编辑替换');
  }
  const target = context.entries[targetIndex];
  const targetContribution = context.contributions[targetIndex] || [];
  const targetUserMessage = targetContribution.find((message) => message.role === 'user');
  if (!targetUserMessage) {
    throw new Error('只能编辑当前上下文中的用户消息');
  }

  const requestId = typeof input.requestId === 'string' && input.requestId
    ? input.requestId
    : randomUUID();
  const token = `edit:${requestId}`;
  const covered = context.entries.slice(targetIndex).map((entry) => Number(entry.id));
  const data = target.data && typeof target.data === 'object' ? target.data : {};
  const attachments = Array.isArray(data.attachments)
    ? data.attachments
      .map((attachment) => attachment?.path)
      .filter((attachmentPath) => typeof attachmentPath === 'string' && attachmentPath)
    : [];
  const images = targetContribution
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .filter((block) => block?.type === 'image')
    .map((block) => ({
      type: 'image',
      data: block.data,
      mimeType: block.mimeType,
    }));
  const projectionCutoff = Number(targetUserMessage.timestamp)
    || Number(context.entries[Math.max(0, targetIndex - 1)]?.model?.[0]?.timestamp)
    || Date.now();
  const db = getStudioDatabase();
  const projectionKey = conversationKey(row);
  const removedTurnDiffs = db.readTurnDiffs(projectionKey)
    .filter((diff) => Number(diff?.at) >= projectionCutoff);
  const removedRequestTraces = db.listRequestTraces(projectionKey)
    .filter((trace) => Number(trace?.createdAt) >= projectionCutoff);

  const marker = await conversation.submit({
    type: 'write',
    requestId: `marker:${requestId}`,
    entry: {
      kind: 'studio.edit',
      data: {
        editToken: token,
        editFrom: entryId,
      },
      edits: covered.map((targetId) => ({ target: targetId, action: 'omit' })),
    },
  }, runtime.context);
  editRangesCache.delete(String(conversation.id));
  const markerRecord = await marker.status(runtime.context);
  if (markerRecord.status !== 'done') {
    throw new Error('编辑边界未能写入，请重试');
  }

  let admitted = false;
  try {
    db.deleteConversationProjectionsFrom(projectionKey, projectionCutoff);
    const result = await submitConversation({
      id,
      text,
      requestId,
      mentions: input.mentions,
      attachments,
      images,
    }, {
      ...options,
      edit: true,
      onAdmitted: () => {
        admitted = true;
      },
    });
    return {
      ...result,
      editedEntryId: entryId,
      markerId: String(marker.id),
    };
  } catch (error) {
    if (admitted) throw error;
    const restoredEdits = context.entries.slice(targetIndex).map((entry, index) => ({
      target: Number(entry.id),
      action: 'replace',
      messages: context.contributions[targetIndex + index] || [],
    }));
    try {
      await conversation.submit({
        type: 'write',
        requestId: `restore:${requestId}`,
        entry: {
          kind: 'studio.edit-restore',
          data: {
            editToken: token,
          },
          edits: restoredEdits,
        },
      }, runtime.context);
      editRangesCache.delete(String(conversation.id));
      for (const diff of removedTurnDiffs) db.saveTurnDiff(projectionKey, diff);
      for (const trace of removedRequestTraces) db.saveRequestTrace(projectionKey, trace);
    } catch (restoreError) {
      throw new Error(
        `编辑消息失败，且上下文恢复失败：${String(
          error instanceof Error ? error.message : error,
        )}；${String(
          restoreError instanceof Error ? restoreError.message : restoreError,
        )}`,
      );
    }
    throw error;
  }
}

async function configureConversation({ id, modelRef, thinkingLevel } = {}) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const modelRuntime = await getStudioModelsRuntime();
  const current = await conversation.agent(runtime.context);
  const currentRef = current.model || splitModelRef((await modelInfo(row.workspace)).modelRef);
  const nextRef = modelRef
    ? splitModelRef(modelRef)
    : { provider: currentRef.provider, modelId: currentRef.modelId };
  if (!nextRef) throw new Error('模型标识无效');
  const model = enabledRuntimeModel(modelRuntime.models, nextRef);
  if (!model) throw new Error('模型已不存在，请刷新后重试');
  const requested = thinkingLevel || current.thinkingLevel || 'default';
  validateThinkingLevel(model, requested, modelRuntime);
  const concrete = concreteThinkingLevel(model, requested, modelRuntime);
  await conversation.configure({
    model: { provider: nextRef.provider, modelId: nextRef.modelId },
    thinkingLevel: concrete,
  }, runtime.context);
  return {
    ...await sessionModelInfo({
      model: { provider: nextRef.provider, modelId: nextRef.modelId },
      thinkingLevel: concrete,
    }),
    pending: runningConversations.has(conversationKey(row)),
  };
}

/**
 * Move only the Durable agent cwd. The Studio row keeps its original workspace
 * so isolated comparison branches remain visible under the parent project.
 * This helper is internal to the main process and is not exposed through IPC.
 */
async function configureConversationAgentCwd(id, cwd) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('托管工作目录无效');
  }
  const target = fs.realpathSync(path.resolve(cwd));
  if (!fs.statSync(target).isDirectory()) throw new Error('托管工作目录无效');
  const runtime = await getDurableRuntime();
  await conversation.configure({ cwd: target }, runtime.context);
  return { ok: true, cwd: target };
}

async function setLongTaskStatus(row, conversation, status) {
  if (!row) return undefined;
  const runtime = await getDurableRuntime();
  const { LongTask } = createLongTaskContract(runtime.durable);
  await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const state = normalizeLongTaskState(stored);
    if (!state.enabled || !state.goal) return;
    state.status = status;
    state.updatedAt = Date.now();
    if (status === 'active') {
      state.pauseReason = '';
      state.blockReason = '';
      state.blockedAt = 0;
      state.completionSummary = '';
      state.completedAt = 0;
    }
    Object.assign(stored, state);
  }, runtime.context);
  return readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
}

async function submitLongTaskContinuation(row, conversation, state, requestPrefix) {
  if (!state?.goal || state.status !== 'active') return false;
  const runtime = await getDurableRuntime();
  const selection = await runtimeSelection({
    kind: row.kind,
    longTask: true,
  });
  await conversation.configure({
    extensions: selection.extensions,
    tools: selection.tools,
  }, runtime.context);
  await conversation.submit({
    type: 'input',
    content: continuationText(state),
    requestId: `${requestPrefix}:${randomUUID()}`,
    whenBusy: 'followUp',
  }, runtime.context);
  return true;
}

async function pauseLongTaskForContinuationGuard(entry, row, reason) {
  if (entry.longTaskGuardTriggered) return;
  entry.longTaskGuardTriggered = true;
  const runtime = await getDurableRuntime();
  const conversation = await runtime.harness.conversation(
    Number(row.id),
    runtime.context,
  );
  if (!conversation) return;
  const { LongTask } = createLongTaskContract(runtime.durable);
  await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const state = normalizeLongTaskState(stored);
    if (state.status !== 'active') return;
    state.status = 'paused';
    state.pauseReason = reason;
    state.updatedAt = Date.now();
    Object.assign(stored, state);
  }, runtime.context);
  await conversation.abort(runtime.context, { background: true });
  await refreshRuntimeState();
}

async function guardLongTaskContinuation(entry, row) {
  if (entry.longTaskGuardTriggered) return;
  const runtime = await getDurableRuntime();
  const state = await readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
  if (state.status !== 'active') return;
  const policy = getRuntimePolicy();
  const decision = nextLongTaskContinuationGuard({
    continuations: entry.longTaskContinuations,
    stalledContinuations: entry.longTaskStalledContinuations,
    iteration: state.iteration,
    lastIteration: entry.longTaskLastIteration,
    maxContinuations: policy.longTask.maxContinuations,
    maxStalledContinuations: policy.longTask.maxStalledContinuations,
  });
  entry.longTaskContinuations = decision.continuations;
  entry.longTaskStalledContinuations = decision.stalledContinuations;
  entry.longTaskLastIteration = decision.iteration;
  if (decision.pauseReason) {
    await pauseLongTaskForContinuationGuard(
      entry,
      row,
      decision.pauseReason,
    );
  }
}

async function longTaskPause(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const current = await readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
  if (!current.enabled || !current.goal) throw new Error('当前会话没有可暂停的长期目标');
  if (!['active', 'blocked'].includes(current.status)) {
    throw new Error('当前目标已经暂停或结束，无需再次暂停');
  }
  await refreshRuntimeState();
  const state = await setLongTaskStatus(row, conversation, 'paused');
  const wasRunning = runningConversations.has(conversationKey(row));
  await conversation.abort(runtime.context, { background: true });
  await refreshRuntimeState();
  return { ok: true, wasRunning, longTask: state };
}

async function longTaskResume(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const current = await readLongTaskState(
    runtime.durable,
    runtime.harness,
    Number(row.id),
    runtime.context,
  );
  if (!current.enabled || !current.goal) throw new Error('请先设置一个长期目标');
  if (!['active', 'paused', 'blocked'].includes(current.status)) {
    throw new Error(current.status === 'completed'
      ? '当前目标已经完成，请使用 /goal <新目标>'
      : '当前目标状态无法继续');
  }
  await refreshRuntimeState();
  const state = await setLongTaskStatus(row, conversation, 'active');
  const started = !runningConversations.has(conversationKey(row))
    && await submitLongTaskContinuation(row, conversation, state, 'long-task-resume');
  return {
    ok: true,
    started,
    longTask: await readLongTaskState(
      runtime.durable,
      runtime.harness,
      Number(row.id),
      runtime.context,
    ),
  };
}

async function longTaskSetGoal(id, options = {}) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');

  const goal = validateLongTaskGoal(options.goal);
  const completionCriteria = String(options.completionCriteria || goal).trim().slice(0, 32_000);
  const runtime = await getDurableRuntime();
  const { LongTask } = createLongTaskContract(runtime.durable);
  let previousStatus = 'idle';
  let shouldStart = false;

  await refreshRuntimeState();
  const wasRunning = runningConversations.has(conversationKey(row));
  const stagedState = await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const current = normalizeLongTaskState(stored);
    previousStatus = current.status;
    shouldStart = shouldStartLongTaskGoal(options.mode, previousStatus);
    const next = options.mode === 'edit'
      ? editLongTaskState(stored, {
          goal,
          completionCriteria,
          previousStatus,
          now: Date.now(),
        })
      : replaceLongTaskState(stored, {
          goal,
          completionCriteria,
          now: Date.now(),
        });
    next.status = 'paused';
    next.pauseReason = options.mode === 'edit'
      ? '正在更新目标。'
      : '正在切换目标。';
    next.updatedAt = Date.now();
    Object.assign(stored, next);
    return publicLongTaskState(next);
  }, runtime.context);
  await conversation.abort(runtime.context, { background: true });

  const state = shouldStart
    ? await setLongTaskStatus(row, conversation, 'active')
    : stagedState;

  getStudioDatabase().updateConversation(row.id, {
    goal: state.goal,
    updatedAt: Date.now(),
  });
  const started = state.status === 'active'
    && await submitLongTaskContinuation(row, conversation, state, 'long-task-set');
  await refreshRuntimeState();
  return {
    ok: true,
    wasRunning,
    started,
    longTask: await readLongTaskState(
      runtime.durable,
      runtime.harness,
      Number(row.id),
      runtime.context,
    ),
  };
}

async function longTaskComplete(id, summary = '') {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const { LongTask } = createLongTaskContract(runtime.durable);
  await refreshRuntimeState();
  const wasRunning = runningConversations.has(conversationKey(row));
  const state = await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const next = completeLongTaskState(stored, {
      summary,
      now: Date.now(),
    });
    return publicLongTaskState(next);
  }, runtime.context);
  await conversation.abort(runtime.context, { background: true });
  getStudioDatabase().updateConversation(row.id, {
    goal: state.goal,
    updatedAt: Date.now(),
  });
  await refreshRuntimeState();
  return { ok: true, wasRunning, started: false, longTask: state };
}

async function longTaskClear(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const { LongTask } = createLongTaskContract(runtime.durable);
  await refreshRuntimeState();
  const wasRunning = runningConversations.has(conversationKey(row));
  const state = await conversation.commit(async (tx) => {
    const stored = await tx.doc(LongTask, Number(row.id));
    const next = clearLongTaskState(stored);
    return publicLongTaskState(next);
  }, runtime.context);
  await conversation.abort(runtime.context, { background: true });
  getStudioDatabase().updateConversation(row.id, {
    goal: '',
    updatedAt: Date.now(),
  });
  await refreshRuntimeState();
  return { ok: true, wasRunning, started: false, longTask: state };
}

async function abortConversation(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const wasRunning = runningConversations.has(conversationKey(row));
  const runtime = await getDurableRuntime();
  // A stopped goal becomes paused before the abort reaches GenerationTask.
  // Otherwise the final boundary could immediately continue after Stop.
  await setLongTaskStatus(row, conversation, 'paused');
  // Stop background children with the main turn. The UI exposes one stop
  // action for the conversation, so leaving an owned background task alive
  // would keep the row spinning after the user explicitly stopped it.
  await conversation.abort(runtime.context, { background: true });
  await refreshRuntimeState();
  return { ok: true, wasRunning };
}

async function forkConversation(id, entryId) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const entry = entryId === undefined
    ? await latestEntry(conversation)
    : (await conversation.entries(
        { order: 'ascending', minEntryId: normalizeId(entryId), maxEntryId: normalizeId(entryId) },
        1,
        undefined,
        (await getDurableRuntime()).context,
      )).items[0];
  if (!entry) throw new Error('找不到要分叉的消息');
  const runtime = await getDurableRuntime();
  const fork = await conversation.fork(entry.id, {
    ownership: { kind: 'ownerless' },
  }, runtime.context);
  const next = getStudioDatabase().insertConversation({
    id: String(fork.id),
    workspace: row.workspace,
    kind: row.kind,
    title: `${row.title.slice(0, 72)} · 分叉`,
    titleSource: 'user',
    goal: row.goal,
  });
  return conversationDto(next);
}

/**
 * 手动压缩：摘要任务按 Durable 规则提交，空闲时立即落地，忙碌时在下一个边界写入，
 * 因此正在运行的回合不会被打断，摘要应用后自动继续。
 */
async function compactConversation(id, instructions) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const text = typeof instructions === 'string' && instructions.trim()
    ? instructions.trim().slice(0, 2_000)
    : undefined;
  const taskId = await conversation.compact(text, runtime.context);
  await refreshRuntimeState();
  return { ok: true, taskId: String(taskId) };
}

async function stopConversationWatches(id) {
  const key = String(id);
  subscribers.delete(key);
  const entry = watches.get(key);
  if (!entry) return;
  watches.delete(key);
  await entry.stream.stop().catch(() => {});
}

function taskIsActive(task) {
  const status = task?.state?.kind || task?.state?.status;
  return status !== 'terminal';
}

async function waitForConversationTasksToSettle(conversationIds, taskIds = [], timeoutMs = 8_000) {
  if (conversationIds.length === 0 && taskIds.length === 0) return;
  const ids = new Set(conversationIds.map(Number));
  const ownedTaskIds = new Set(taskIds.map(Number));
  const runtime = await getDurableRuntime();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspection = await runtime.harness.inspect(runtime.context);
    const active = inspection.tasks.filter((task) => (
      (
        ids.has(Number(task.record?.conversationId))
        || ownedTaskIds.has(Number(task.record?.id))
      )
      && taskIsActive(task)
    ));
    if (active.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error('仍有任务没有停止，暂时无法安全删除会话');
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * Stop every task in a Durable conversation tree, then remove all dependent
 * rows, Studio projections, permissions, caches, watches, and attachments.
 * Global usage analytics and the next-ID allocator are deliberately retained.
 */
async function purgeConversationData(rootIds, options = {}) {
  const db = getStudioDatabase();
  const roots = [...new Set((rootIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (roots.length === 0) {
    return {
      conversationIds: [],
      taskIds: [],
      documentIds: [],
      publicIds: [],
      workspaces: [],
      attachmentsRemoved: 0,
    };
  }
  const tree = db.durableConversationTree(roots, {
    extraTaskIds: options.extraTaskIds,
  });
  if (tree.conversationIds.length === 0) {
    let attachmentsRemoved = 0;
    for (const root of roots) {
      const row = db.getConversation(String(root));
      const key = row?.publicId || String(root);
      await stopConversationWatches(key);
      deletePermissionSessionPolicy(key);
      db.deleteConversation(String(root));
      try {
        if (removeAttachmentDirectory(key)) attachmentsRemoved += 1;
      } catch (error) {
        console.warn('[pi-studio] unable to remove conversation attachments', error);
      }
    }
    const managed = await discardManagedWorktreesForConversations(roots, { force: true });
    return {
      ...tree,
      attachmentsRemoved,
      managedWorktreesRemoved: managed.removed,
    };
  }
  const runtime = await getDurableRuntime();
  const conversations = (await Promise.all(tree.conversationIds.map(async (id) => (
    runtime.harness.conversation(id, runtime.context)
  )))).filter(Boolean);
  const abortFailures = [];
  await Promise.all(conversations.map(async (conversation) => {
    try {
      await conversation.abort(runtime.context, { background: true });
    } catch (error) {
      abortFailures.push({ id: conversation.id, error });
    }
  }));
  if (abortFailures.length > 0) {
    const first = abortFailures[0].error;
    throw new Error(`无法停止会话任务：${first instanceof Error ? first.message : String(first)}`);
  }
  const taskAbortFailures = [];
  await Promise.all(tree.taskIds.map(async (taskId) => {
    try {
      await runtime.harness.abortTask(taskId, runtime.context);
    } catch (error) {
      taskAbortFailures.push({ id: taskId, error });
    }
  }));
  if (taskAbortFailures.length > 0) {
    const first = taskAbortFailures[0].error;
    throw new Error(`无法停止关联任务：${first instanceof Error ? first.message : String(first)}`);
  }
  await waitForConversationTasksToSettle(tree.conversationIds, tree.taskIds);
  const managedWorktrees = await discardManagedWorktreesForConversations(
    tree.conversationIds,
    { force: true },
  );

  const cleanupKeys = [...new Set([
    ...tree.conversationIds.map(String),
    ...tree.publicIds.map(String),
  ])];
  await Promise.all(cleanupKeys.map((key) => stopConversationWatches(key)));
  for (const key of cleanupKeys) {
    runningConversations.delete(key);
    messageCounts.delete(key);
    runDiffSnapshots.delete(key);
    editRangesCache.delete(key);
    deletePermissionSessionPolicy(key);
  }

  const removed = db.deleteConversationTrees(roots, {
    extraTaskIds: options.extraTaskIds,
  });
  let attachmentsRemoved = 0;
  for (const key of cleanupKeys) {
    try {
      if (removeAttachmentDirectory(key)) attachmentsRemoved += 1;
    } catch (error) {
      console.warn('[pi-studio] unable to remove conversation attachments', error);
    }
  }
  return {
    ...removed,
    attachmentsRemoved,
    managedWorktreesRemoved: managedWorktrees.removed,
  };
}

async function conversationAction(input = {}) {
  const db = getStudioDatabase();
  if (input.kind === 'workspace') {
    if (input.action === 'rename') db.upsertWorkspace({ cwd: input.id, name: input.name });
    else if (input.action === 'remove') {
      const sessions = db.listConversations({ includeArchived: true })
        .filter((item) => item.workspace === input.id);
      const archivedCount = sessions.filter((item) => item.archived).length;
      const removed = await purgeConversationData(sessions.map((item) => item.id));
      deleteWorkspaceScopedSettings(
        input.id,
        [...removed.publicIds, ...sessions.map((item) => item.publicId)],
      );
      await purgeProjectWorkspaceState(input.id, await getDurableRuntime());
      db.removeWorkspace(input.id);
      return {
        ok: true,
        deletedSessions: sessions.length,
        deletedArchivedSessions: archivedCount,
        deletedSubagents: Math.max(0, removed.conversationIds.length - sessions.length),
        deletedWorktrees: removed.managedWorktreesRemoved || 0,
      };
    }
    else throw new Error('不支持的工作区操作');
    return { ok: true };
  }
  if (input.kind !== 'session') throw new Error('无效的操作对象');
  if (input.action === 'fork') return forkConversation(input.id, input.entryId);
  const row = await getConversationRow(input.id);
  if (!row) throw new Error('会话不存在');
  if (input.action === 'long-task-set') {
    return longTaskSetGoal(row.id, {
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      mode: 'replace',
    });
  } else if (input.action === 'long-task-edit') {
    return longTaskSetGoal(row.id, {
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      mode: 'edit',
    });
  } else if (input.action === 'long-task-complete') {
    return longTaskComplete(row.id, input.summary);
  } else if (input.action === 'long-task-clear') {
    return longTaskClear(row.id);
  } else if (input.action === 'long-task-pause') {
    return longTaskPause(row.id);
  } else if (input.action === 'long-task-resume') {
    return longTaskResume(row.id);
  } else if (input.action === 'rename') {
    db.updateConversation(row.id, {
      title: String(input.name || '').trim() || row.title,
      titleSource: 'user',
    });
  } else if (input.action === 'pin') {
    db.updateConversation(row.id, { pinned: !row.pinned });
  } else if (input.action === 'archive') {
    if (runningConversations.has(conversationKey(row))) await abortConversation(row.id);
    db.updateConversation(row.id, { archived: !row.archived });
  } else if (input.action === 'remove') {
    const removed = await purgeConversationData([row.id]);
    return {
      ok: true,
      deletedSessions: 1,
      deletedSubagents: Math.max(0, removed.conversationIds.length - 1),
      attachmentsRemoved: removed.attachmentsRemoved,
      deletedWorktrees: removed.managedWorktreesRemoved || 0,
    };
  } else {
    throw new Error('不支持的会话操作');
  }
  return { ok: true };
}

function serializableTaskGraph(value) {
  const tasks = value?.tasks && typeof value.tasks === 'object' ? Object.values(value.tasks) : [];
  return tasks.map((task) => ({
    id: String(task.id),
    kind: task.kind,
    conversationId: String(task.conversationId),
    owner: task.owner ? String(task.owner) : undefined,
    background: Boolean(task.background),
    abortRequested: Boolean(task.abortRequested),
    blocked: task.blocked,
    state: task.state,
    conversations: (task.conversations || []).map(String),
  }));
}

async function taskGraph(id) {
  const runtime = await getDurableRuntime();
  // 1.5.0 移除了 Harness.taskGraph()，任务图现在是序列化 watch。
  const graph = await runtime.harness.watchTaskGraph(runtime.context);
  try {
    return {
      conversationId: String(id),
      tasks: serializableTaskGraph(graph.value),
    };
  } finally {
    await graph.stop().catch(() => {});
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function disposeWatch(key) {
  const entry = watches.get(key);
  if (!entry) return;
  watches.delete(key);
  await entry.stream.stop().catch(() => {});
}

async function beginRunDiff(entry, conversation, inputs) {
  const firstInput = inputs?.[0];
  if (!firstInput || entry.diffKey) return;
  const runtime = await getDurableRuntime();
  const submission = await runtime.harness.submission(firstInput, runtime.context);
  const record = submission ? await submission.status(runtime.context) : undefined;
  const requestId = record?.requestId || String(firstInput);
    const key = `${conversationKey(conversation)}:${requestId}`;
  const token = await beginTurn(conversation.workspace, key);
  if (token) {
    entry.diffKey = token;
    runDiffSnapshots.set(conversationKey(conversation), token);
  }
}

async function finishRunDiff(entry, conversation, emit) {
  if (!entry.diffKey) return;
  const token = entry.diffKey;
  entry.diffKey = undefined;
  runDiffSnapshots.delete(conversationKey(conversation));
  try {
    const diff = await endTurn(token);
    if (!diff) return;
    // at 必须与本轮最后一条助手消息的 timestamp 一致：渲染层按它匹配历史
    // 轮次。用结束时刻会让已保存的 diff 永远匹配不上，卡片只能退回工具统计。
    const at = Number.isFinite(entry.lastAssistantAt) ? entry.lastAssistantAt : Date.now();
    entry.lastAssistantAt = undefined;
    const value = {
      ...diff,
      at,
    };
    saveTurnDiff(conversationKey(conversation), value);
    await emit({
      type: 'turn.diff',
      conversationId: String(conversation.id),
      revision: entry.revision,
      payload: { diff: value },
    });
  } catch (error) {
    console.error('[pi-studio] turn diff failed', error);
  }
}

/**
 * 把一次会话视图变更翻译成 Studio 的 IPC 事件。
 *
 * 顺序与 1.4.0 的事件流保持一致：先发 entry（对应 `message_end` /
 * `entry_appended`），再发运行状态（对应 `run_end`），渲染层不会看到
 * "运行已结束、消息才追加"的错序。
 */
async function applyView(view, entry, conversation, emit) {
  const key = conversationKey(conversation);

  for (const record of durableView.appendedEntries(entry.entryIds, view.entries)) {
    const messages = entryToMessages(record);
    if (messages.length === 0) continue;
    if (messages.some((message) => (
      message.role === 'user' && isLongTaskContinuation(message.content)
    ))) {
      await guardLongTaskContinuation(entry, conversation);
    }
    const assistant = messages.find((message) => message.role === 'assistant');
    if (assistant) {
      // 对应 1.4.0 的 `message_end`：流式消息落定成正式消息。
      entry.partial = undefined;
      // 记住本轮最后一条助手消息的时间戳：turn diff 用它作为 at，渲染层才能
      // 用同一条消息的 timestamp 找回历史轮次的 diff。
      if (Number.isFinite(assistant.timestamp)) entry.lastAssistantAt = assistant.timestamp;
      await emit({
        type: 'assistant.completed',
        conversationId: key,
        revision: entry.revision,
        payload: { message: assistant },
      });
      continue;
    }
    await emit({
      type: 'transcript.appended',
      conversationId: key,
      revision: entry.revision,
      payload: { messages },
    });
  }

  const previous = entry.snapshot;
  const next = durableView.liveFromView(view);
  entry.snapshot = next;
  if (next.generation?.message) entry.partial = next.generation.message;

  for (const change of durableView.diffLive(previous, next)) {
    if (change.type === 'run.started') {
      entry.running = true;
      entry.runStartedAt ||= Date.now();
      entry.longTaskContinuations = 0;
      entry.longTaskStalledContinuations = 0;
      entry.longTaskGuardTriggered = false;
      runningConversations.add(key);
      await beginRunDiff(entry, conversation, change.payload.inputs);
      await emit({
        type: 'run.started',
        conversationId: key,
        revision: entry.revision,
        payload: { inputs: change.payload.inputs, running: true },
      });
      continue;
    }

    if (change.type === 'run.completed') {
      const endedAt = Date.now();
      const lastDurationMs = entry.runStartedAt === undefined
        ? undefined
        : Math.max(0, endedAt - entry.runStartedAt);
      entry.running = false;
      entry.runStartedAt = undefined;
      entry.partial = undefined;
      await refreshRuntimeState();
      await finishRunDiff(entry, conversation, emit);
      getStudioDatabase().updateConversation(key, {
        updatedAt: endedAt,
        ...(lastDurationMs === undefined ? {} : { lastDurationMs }),
      });
      await emit({
        type: 'run.completed',
        conversationId: key,
        revision: entry.revision,
        payload: {
          inputs: change.payload.inputs,
          running: runningConversations.has(key),
        },
      });
      continue;
    }

    if (change.type === 'run.failed') {
      entry.running = false;
      await refreshRuntimeState();
      getStudioDatabase().updateConversation(key, {
        lastError: change.payload.message,
        updatedAt: Date.now(),
      });
      await emit({
        type: 'run.failed',
        conversationId: key,
        revision: entry.revision,
        payload: { ...change.payload, running: runningConversations.has(key) },
      });
      continue;
    }

    if (change.type === 'assistant.updated') {
      const message = partialMessage(change.payload.message);
      if (message) {
        await emit({
          type: 'assistant.updated',
          conversationId: key,
          revision: entry.revision,
          payload: { message: { ...message, streaming: true, sourceIndex: undefined } },
        });
      }
      continue;
    }

    await emit({
      type: change.type,
      conversationId: key,
      revision: entry.revision,
      payload: change.payload,
    });
  }
}

async function ensureWatch(id, emit) {
  const row = await getConversationRow(id);
  if (!row) throw new Error('会话不存在');
  const key = conversationKey(row);
  const existing = watches.get(key);
  if (existing) return existing;
  const conversation = await getConversationHandle(row.id);
  if (!conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  // 1.5.0：watchEvents() 已移除，实时状态来自会话视图的序列化 watch。
  const watch = await conversation.watch(runtime.context);
  const initialLongTask = await longTaskDto(row);
  const snapshot = durableView.liveFromView(watch.value);
  const entry = {
    id: key,
    conversation,
    stream: watch,
    snapshot,
    partial: snapshot.generation?.message,
    running: Boolean(snapshot.run),
    entryIds: durableView.seedEntryIds(watch.value.entries),
    revision: 0,
    emit,
    diffKey: undefined,
    closeWhenIdle: false,
    // The safety budget belongs to one live run. User resume starts a new run
    // and resets it, so historical continuations never consume a new budget.
    longTaskContinuations: 0,
    longTaskStalledContinuations: 0,
    longTaskLastIteration: initialLongTask?.iteration || 0,
    longTaskGuardTriggered: false,
    runStartedAt: snapshot.run ? Date.now() : undefined,
  };
  watches.set(key, entry);
  if (entry.running) {
    runningConversations.add(key);
    await beginRunDiff(entry, conversation, snapshot.run?.inputs);
  } else {
    await refreshRuntimeState();
  }
  await emit({
    type: 'snapshot',
    conversationId: key,
    revision: entry.revision,
    payload: {
      run: snapshot.run,
      running: runningConversations.has(key),
      generation: entry.partial ? partialMessage(entry.partial) : undefined,
      tools: snapshot.tools,
      nestedTools: snapshot.nestedTools,
      compactions: snapshot.compactions,
      compactionFailure: snapshot.compactionFailure,
      inbox: snapshot.inbox,
      agent: snapshot.agent,
      usage: snapshot.usage,
    },
  });
  watch.start(async (call) => {
    // Durable 的失败会直接结束 watch，因此只有 value 调用会到达这里。
    if (call.kind !== 'value') return;
    entry.revision += 1;
    await applyView(call.value, entry, row, emit);
    if (!entry.running && entry.closeWhenIdle && !subscribers.get(key)?.size) {
      await disposeWatch(key);
    }
  });
  return entry;
}

async function subscribeConversation(id, owner, emit) {
  const row = await getConversationRow(id);
  if (!row) throw new Error('会话不存在');
  const key = conversationKey(row);
  await refreshRuntimeState();
  const entry = await ensureWatch(key, emit);
  const owners = subscribers.get(key) || new Set();
  owners.add(owner);
  subscribers.set(key, owners);
  entry.closeWhenIdle = false;
  const conversation = await getConversationHandle(row.id);
  if (!conversation) throw new Error('会话不存在');
  const agent = await conversation.agent((await getDurableRuntime()).context);
  const snapshot = await reconcileWatchSnapshot(entry, conversation);
  return liveSnapshotDto(row, snapshot, {
    model: await sessionModelInfo(agent),
    longTask: await longTaskDto(row),
    requestTraces: getStudioDatabase().listRequestTraces(key, {
      limit: REQUEST_TRACE_PAGE_LIMIT,
    }),
  });
}

async function stopConversationWatch(id, owner) {
  const row = await getConversationRow(id);
  const key = conversationKey(row);
  const owners = subscribers.get(key);
  owners?.delete(owner);
  if (owners?.size) return;
  subscribers.delete(key);
  const entry = watches.get(key);
  if (!entry) return;
  if (entry.running) {
    entry.closeWhenIdle = true;
    return;
  }
  await disposeWatch(key);
}

async function composerResources(input = {}) {
  const extensionCommands = extensionComposerCommands().map((command) => ({
    name: `${command.extensionId.replace(':', '-')}.${command.name}`,
    description: command.description || command.title,
    source: 'extension',
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    commandId: command.commandId,
    extensionId: command.extensionId,
  }));
  return {
    commands: [
      { name: 'new', description: '开始一个新会话', source: 'builtin' },
      { name: 'model', description: '切换当前会话或新对话的模型', source: 'builtin' },
      { name: 'thinking', description: '调整当前会话的思考强度', source: 'builtin' },
      {
        name: 'goal',
        description: '设置、查看、编辑、暂停、恢复或清除长期目标',
        source: 'builtin',
        argumentHint: '[目标|edit|pause|resume|complete|clear]',
      },
      { name: 'settings', description: '打开设置', source: 'builtin' },
      { name: 'copy', description: '复制最后一条助理回复', source: 'builtin' },
      ...extensionCommands,
    ],
    skills: typeof input.cwd === 'string' && input.cwd
      ? composerSkills(input.cwd)
      : composerSkills(''),
  };
}

async function refreshRuntimeState() {
  const runtime = await getDurableRuntime();
  const db = getStudioDatabase();
  const inspection = await runtime.harness.inspect(runtime.context);
  runningConversations.clear();
  for (const task of inspection.tasks) {
    if (!ACTIVE_TASK_STATES.has(task.state.kind)) continue;
    const conversationId = task.record?.conversationId;
    if (conversationId !== undefined) {
      const row = db.getConversation(String(conversationId));
      runningConversations.add(row ? conversationKey(row) : String(conversationId));
    }
  }
  return {
    scheduling: inspection.scheduling,
    tasks: inspection.tasks.length,
    submissions: inspection.submissions.length,
  };
}

async function closeConversationWatches() {
  const keys = [...watches.keys()];
  await Promise.all(keys.map((key) => disposeWatch(key)));
  subscribers.clear();
  runningConversations.clear();
  runDiffSnapshots.clear();
  editRangesCache.clear();
}

module.exports = {
  abortConversation,
  scanStopReason,
  closeConversationWatches,
  compactConversation,
  configureConversationAgentCwd,
  composerResources,
  configureConversation,
  conversationMessageSummary,
  conversationAction,
  conversationPage,
  conversationSnapshot,
  createConversation,
  editConversation,
  fullDisplayMessages,
  forkConversation,
  getConversationHandle,
  listWorkspaces,
  outline,
  purgeConversationData,
  refreshRuntimeState,
  scanDisplayMessages,
  scanEntries,
  stopConversationWatch,
  submitConversation,
  subscribeConversation,
  taskGraph,
};
