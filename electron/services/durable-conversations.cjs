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
} = require('../core/app-settings.cjs');
const { getStudioModelsRuntime } = require('../core/studio-models.cjs');
const {
  getDurableRuntime,
  latestEntry,
  reconcileRuntimeForWorkspace,
} = require('./durable-runtime.cjs');
const {
  concreteThinkingLevel,
  enabledRuntimeModel,
  modelInfo,
  runtimeModelFor,
  sessionModelInfo,
  splitModelRef,
  validateThinkingLevel,
} = require('./models.cjs');
const { fileReferenceContext } = require('./workspace.cjs');
const {
  attachmentContext,
  removeAttachmentDirectory,
} = require('./attachments.cjs');
const {
  beginTurn,
  endTurn,
  saveTurnDiff,
} = require('./turn-diff.cjs');
const { runtimeSelection } = require('./tool-selection.cjs');
const {
  extensionComposerCommands,
  purgeProjectWorkspaceState,
} = require('./studio-extensions.cjs');
const { composerSkills, expandSkillCommand } = require('./studio-skills.cjs');
const {
  generateConversationTitle,
  temporaryTitle,
} = require('./conversation-title.cjs');

const DEFAULT_PAGE_SIZE = 80;
const MAX_PAGE_SIZE = 2_000;
const ENTRY_SCAN_PAGE_SIZE = 300;
const MAX_OUTLINE_ITEMS = 10_000;
const MAX_OUTLINE_TEXT = 2_000;
const MAX_TRACKED_CONVERSATION_COUNTS = 2_000;
const CONVERSATION_KINDS = new Set(['conversation', 'durable']);
const BUSY_POLICIES = new Set(['steer', 'followUp', 'reject']);

const watches = new Map();
const subscribers = new Map();
const messageCounts = new Map();
const runningConversations = new Set();
const runDiffSnapshots = new Map();

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
    ...overrides,
  };
}

function liveSnapshotDto(conversation, snapshot, extra = {}) {
  const runtime = snapshot?.run;
  return conversationDto(conversation, {
    running: Boolean(runtime),
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
    return [{
      role: 'assistant',
      content: contentToChat(message.content),
      timestamp: message.timestamp,
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

async function scanEntries(conversation, options = {}) {
  const runtime = await getDurableRuntime();
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
      const entryMessages = entryToMessages(entry);
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
      if (count >= messageLimit) break;
    }

    const pageHasUnconsumedMessages = consumedInPage < pageMessages;
    if (count >= messageLimit && (pageHasUnconsumedMessages || page.next)) {
      nextCursor = encodeCursor({
        version: 2,
        order,
        upstream: cursor,
        skip: consumedInPage,
      });
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
  let cursor;
  do {
    const page = await conversation.entries(
      { order: 'ascending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    for (const entry of page.items) {
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
  const stream = await runtime.durable.watchEvents(
    runtime.harness,
    conversation.id,
    runtime.context,
  );
  try {
    return stream.snapshot;
  } finally {
    await stream.stop().catch(() => {});
  }
}

async function reconcileWatchSnapshot(entry, row, conversation) {
  if (!entry || !entry.running) return entry?.snapshot;
  const runtime = await getDurableRuntime();
  const inspection = await runtime.harness.inspect(runtime.context);
  const hasForegroundWork = inspection.tasks.some((task) => (
    Number(task.record?.conversationId) === Number(row.id)
    && !task.record?.background
    && ['running', 'ready', 'waiting', 'sleeping'].includes(task.state.kind)
  ));
  if (hasForegroundWork) return entry.snapshot;
  const fresh = await temporarySnapshot(conversation);
  if (fresh?.run) return entry.snapshot;
  entry.snapshot = fresh;
  entry.partial = fresh?.generation?.message;
  entry.running = false;
  runningConversations.delete(conversationKey(row));
  return fresh;
}

async function conversationSnapshot(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) return undefined;
  const key = conversationKey(row);
  const entry = watches.get(key);
  const snapshot = entry
    ? await reconcileWatchSnapshot(entry, row, conversation)
    : await temporarySnapshot(conversation);
  const agent = await conversation.agent((await getDurableRuntime()).context);
  return liveSnapshotDto(row, snapshot, {
    durableSessionId: String(row.id),
    model: await sessionModelInfo(agent),
  });
}

async function conversationPage(id, options = {}) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!row || !conversation) return undefined;
  const page = await scanEntries(conversation, {
    order: 'descending',
    messageLimit: options.limit,
    cursor: options.cursor,
  });
  const agent = await conversation.agent((await getDurableRuntime()).context);
  const key = conversationKey(row);
  const entry = watches.get(key);
  const snapshot = entry
    ? await reconcileWatchSnapshot(entry, row, conversation)
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

async function createConversation({ cwd, kind = 'conversation', title = '新会话', goal = '' } = {}) {
  const workspace = validateWorkspace(cwd);
  if (!CONVERSATION_KINDS.has(kind)) throw new Error('无效的工作项类型');
  const runtime = await getDurableRuntime();
  const modelRuntime = await getStudioModelsRuntime();
  await reconcileRuntimeForWorkspace(workspace, { verifyExtensionIntegrity: true });
  const agentSelection = await runtimeSelection();
  const modelSelection = await modelInfo(workspace);
  const ref = splitModelRef(modelSelection.modelRef);
  const model = runtimeModelFor(modelRuntime.models, ref);
  if (!model) throw new Error('没有可用模型，请先在设置中配置模型来源与 API Key');
  const thinkingLevel = modelSelection.effectiveThinkingLevel;
  const cleanGoal = String(goal || '').trim();
  const conversation = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: {
      model: { provider: ref.provider, modelId: ref.modelId },
      thinkingLevel,
      cwd: workspace,
      extensions: agentSelection.extensions,
      tools: agentSelection.tools,
      ...(kind === 'durable' && cleanGoal
        ? {
            instructions: [
              'This conversation is a Pi Studio long-running task.',
              `Goal: ${cleanGoal}`,
              'Keep the goal active across turns. Record meaningful progress in the transcript and continue until the user changes or completes the goal.',
            ].join('\n'),
          }
        : {}),
    },
  }, runtime.context);
  const row = getStudioDatabase().insertConversation({
    id: String(conversation.id),
    workspace,
    kind,
    title: String(title || '新会话').trim() || '新会话',
    goal: cleanGoal,
  });
  return conversationDto(row, {
    messages: [],
    model: await sessionModelInfo({
      model: { provider: ref.provider, modelId: ref.modelId },
      thinkingLevel,
    }),
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

async function submitConversation(input = {}, options = {}) {
  const row = await getConversationRow(input.id || input.sessionId);
  const conversation = await getConversationHandle(input.id || input.sessionId, {
    verifyExtensionIntegrity: true,
  });
  if (!row || !conversation) throw new Error('会话不存在');
  const runtime = await getDurableRuntime();
  const selection = await runtimeSelection();
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
  const displayText = String(input.text || '').trim();
  const requestId = typeof input.requestId === 'string' && input.requestId
    ? input.requestId
    : randomUUID();
  const submission = await conversation.submit({
    type: 'input',
    content,
    requestId,
    whenBusy: busyPolicy(input.whenBusy),
    entry: {
      kind: 'studio.user',
      data: {
        displayText,
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
      },
    },
  }, runtime.context);
  const record = await submission.status(runtime.context);
  const shouldGenerateTitle = row.title === '新会话' && Boolean(displayText);
  const nextTitle = shouldGenerateTitle ? temporaryTitle(displayText) : row.title;
  getStudioDatabase().updateConversation(row.id, {
    title: nextTitle,
    titleSource: shouldGenerateTitle ? 'auto-pending' : row.titleSource,
    lastRequestId: requestId,
    updatedAt: Date.now(),
  });
  if (shouldGenerateTitle) {
    void (async () => {
      const db = getStudioDatabase();
      let generated = '';
      try {
        const [agent, modelRuntime] = await Promise.all([
          conversation.agent(runtime.context),
          getStudioModelsRuntime(),
        ]);
        const model = runtimeModelFor(modelRuntime.models, agent.model);
        generated = await generateConversationTitle({
          question: displayText,
          model,
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
    whenBusy: busyPolicy(input.whenBusy),
  };
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

async function abortConversation(id) {
  const row = await getConversationRow(id);
  const conversation = await getConversationHandle(id);
  if (!conversation) throw new Error('会话不存在');
  const wasRunning = runningConversations.has(conversationKey(row));
  const runtime = await getDurableRuntime();
  await conversation.abort(runtime.context);
  runningConversations.delete(conversationKey(row));
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
    return { ...tree, attachmentsRemoved };
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

  const cleanupKeys = [...new Set([
    ...tree.conversationIds.map(String),
    ...tree.publicIds.map(String),
  ])];
  await Promise.all(cleanupKeys.map((key) => stopConversationWatches(key)));
  for (const key of cleanupKeys) {
    runningConversations.delete(key);
    messageCounts.delete(key);
    runDiffSnapshots.delete(key);
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
  return { ...removed, attachmentsRemoved };
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
      };
    }
    else throw new Error('不支持的工作区操作');
    return { ok: true };
  }
  if (input.kind !== 'session') throw new Error('无效的操作对象');
  if (input.action === 'fork') return forkConversation(input.id, input.entryId);
  const row = await getConversationRow(input.id);
  if (!row) throw new Error('会话不存在');
  if (input.action === 'rename') {
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
  const graph = await runtime.harness.taskGraph(runtime.context);
  try {
    return {
      conversationId: String(id),
      tasks: serializableTaskGraph(graph.value),
    };
  } finally {
    graph.dispose?.();
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function appendAtPath(value, segments, delta) {
  if (segments.length === 0 || typeof value !== 'object' || value === null) return value;
  let current = value;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) {
      current[segment] = typeof segments[index + 1] === 'number' ? [] : {};
    }
    current = current[segment];
  }
  const last = segments.at(-1);
  current[last] = `${current[last] || ''}${delta}`;
  return value;
}

function applyMessageChanges(message, changes) {
  const next = {
    ...message,
    content: Array.isArray(message.content) ? cloneJson(message.content) : [],
  };
  for (const change of changes || []) {
    if (
      change.type === 'text_start'
      || change.type === 'thinking_start'
      || change.type === 'toolcall_start'
      || change.type === 'block'
    ) {
      next.content[change.contentIndex] = cloneJson(change.block);
      continue;
    }
    if (change.type === 'text_delta' || change.type === 'thinking_delta') {
      const key = change.type === 'thinking_delta' ? 'thinking' : 'text';
      const current = next.content[change.contentIndex] || { type: key, [key]: '' };
      next.content[change.contentIndex] = {
        ...current,
        [key]: `${current[key] || ''}${change.delta}`,
      };
      continue;
    }
    if (change.type === 'toolcall_delta') {
      const current = cloneJson(next.content[change.contentIndex] || {
        type: 'toolCall',
        arguments: {},
      });
      next.content[change.contentIndex] = appendAtPath(
        current,
        ['arguments', ...change.path],
        change.delta,
      );
      continue;
    }
    if (change.type === 'message') {
      next.content = cloneJson(change.message.content);
    }
  }
  return next;
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
    const value = {
      ...diff,
      at: Date.now(),
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

async function handleAgentEvent(event, entry, conversation, emit) {
  const key = conversationKey(conversation);
  if (event.type === 'snapshot') {
    entry.snapshot = event;
    entry.partial = event.generation?.message;
    entry.running = Boolean(event.run);
    if (entry.running) {
      runningConversations.add(key);
      await beginRunDiff(entry, conversation, event.run?.inputs);
    } else {
      runningConversations.delete(key);
    }
    await emit({
      type: 'snapshot',
      conversationId: key,
      revision: entry.revision,
      payload: {
        run: event.run,
        generation: entry.partial ? partialMessage(entry.partial) : undefined,
        tools: event.tools,
        nestedTools: event.nestedTools,
        compactions: event.compactions,
        compactionFailure: event.compactionFailure,
        inbox: event.inbox,
        agent: event.agent,
        usage: event.usage,
      },
    });
    return;
  }

  if (event.type === 'run_start') {
    entry.running = true;
    runningConversations.add(key);
    await beginRunDiff(entry, conversation, event.inputs);
    await emit({
      type: 'run.started',
      conversationId: key,
      revision: entry.revision,
      payload: { inputs: event.inputs },
    });
    return;
  }

  if (event.type === 'run_end') {
    entry.running = false;
    runningConversations.delete(key);
    await finishRunDiff(entry, conversation, emit);
    getStudioDatabase().updateConversation(key, { updatedAt: Date.now() });
    await emit({
      type: 'run.completed',
      conversationId: key,
      revision: entry.revision,
      payload: { inputs: event.inputs },
    });
    return;
  }

  if (event.type === 'message_start') {
    if (event.message.role === 'assistant') entry.partial = cloneJson(event.message);
    return;
  }

  if (event.type === 'message_update') {
    entry.partial = applyMessageChanges(entry.partial || {
      role: 'assistant',
      content: [],
      timestamp: Date.now(),
      stopReason: 'pending',
    }, event.changes);
    const message = partialMessage({ ...entry.partial, usage: event.usage });
    if (message) {
      await emit({
        type: 'assistant.updated',
        conversationId: key,
        revision: entry.revision,
        payload: { message: { ...message, streaming: true, sourceIndex: undefined } },
      });
    }
    return;
  }

  if (event.type === 'message_end') {
    const message = entryToMessages(event.entry)[0];
    entry.partial = undefined;
    if (message) {
      await emit({
        type: 'assistant.completed',
        conversationId: key,
        revision: entry.revision,
        payload: { message },
      });
    }
    return;
  }

  if (
    event.type === 'tool_execution_start'
    || event.type === 'tool_execution_update'
    || event.type === 'tool_execution_end'
  ) {
    await emit({
      type: event.type.replaceAll('_', '.'),
      conversationId: key,
      revision: entry.revision,
      payload: event,
    });
    if (event.type === 'tool_execution_end' && event.entry) {
      const messages = entryToMessages(event.entry);
      if (messages.length > 0) {
        await emit({
          type: 'transcript.appended',
          conversationId: key,
          revision: entry.revision,
          payload: { messages },
        });
      }
    }
    return;
  }

  if (event.type === 'inbox_update') {
    await emit({
      type: 'inbox.updated',
      conversationId: key,
      revision: entry.revision,
      payload: { items: event.items },
    });
    return;
  }

  if (event.type === 'submission') {
    await emit({
      type: 'submission.updated',
      conversationId: key,
      revision: entry.revision,
      payload: { record: event.record },
    });
    return;
  }

  if (event.type === 'agent_changed') {
    await emit({
      type: 'agent.updated',
      conversationId: key,
      revision: entry.revision,
      payload: { agent: event.agent },
    });
    return;
  }

  if (event.type === 'usage_changed') {
    await emit({
      type: 'usage.updated',
      conversationId: key,
      revision: entry.revision,
      payload: { usage: event.usage },
    });
    return;
  }

  if (event.type === 'entry_appended') {
    const messages = entryToMessages(event.entry);
    if (messages.length > 0) {
      await emit({
        type: 'transcript.appended',
        conversationId: key,
        revision: entry.revision,
        payload: { messages },
      });
    }
    return;
  }

  if (event.type === 'auto_retry_start') {
    await emit({
      type: 'retry.updated',
      conversationId: key,
      revision: entry.revision,
      payload: {
        active: true,
        attempt: event.attempt,
        at: event.at,
        errorMessage: event.errorMessage,
      },
    });
    return;
  }

  if (event.type === 'auto_retry_end') {
    await emit({
      type: 'retry.updated',
      conversationId: key,
      revision: entry.revision,
      payload: { active: false, attempt: event.attempt },
    });
    return;
  }

  if (event.type === 'compaction_start' || event.type === 'compaction_end') {
    await emit({
      type: event.type.replaceAll('_', '.'),
      conversationId: key,
      revision: entry.revision,
      payload: event,
    });
    return;
  }

  if (event.type === 'task_failed') {
    entry.running = false;
    runningConversations.delete(key);
    getStudioDatabase().updateConversation(key, {
      lastError: event.message,
      updatedAt: Date.now(),
    });
    await emit({
      type: 'run.failed',
      conversationId: key,
      revision: entry.revision,
      payload: {
        taskId: String(event.taskId),
        kind: event.kind,
        message: event.message,
      },
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
  const stream = await runtime.durable.watchEvents(
    runtime.harness,
    conversation.id,
    runtime.context,
  );
  const entry = {
    id: key,
    stream,
    snapshot: stream.snapshot,
    partial: stream.snapshot?.generation?.message,
    running: Boolean(stream.snapshot?.run),
    revision: 0,
    emit,
    diffKey: undefined,
    closeWhenIdle: false,
  };
  watches.set(key, entry);
  if (entry.running) runningConversations.add(key);
  stream.start(async (events) => {
    entry.revision += 1;
    for (const event of events) {
      await handleAgentEvent(event, entry, row, emit);
    }
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
  const entry = await ensureWatch(key, emit);
  const owners = subscribers.get(key) || new Set();
  owners.add(owner);
  subscribers.set(key, owners);
  entry.closeWhenIdle = false;
  const conversation = await getConversationHandle(row.id);
  if (!conversation) throw new Error('会话不存在');
  const agent = await conversation.agent((await getDurableRuntime()).context);
  const snapshot = await reconcileWatchSnapshot(entry, row, conversation);
  return liveSnapshotDto(row, snapshot, {
    model: await sessionModelInfo(agent),
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
    if (!['running', 'ready', 'waiting', 'sleeping'].includes(task.state.kind)) continue;
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
}

module.exports = {
  abortConversation,
  closeConversationWatches,
  composerResources,
  configureConversation,
  conversationMessageSummary,
  conversationAction,
  conversationPage,
  conversationSnapshot,
  createConversation,
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
