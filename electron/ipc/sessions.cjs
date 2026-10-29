/**
 * IPC：会话。
 * 新建 / 读取 / 侧边栏操作（重命名、置顶、归档、分叉）/ 发消息 / 排队 / 扩展状态。
 */

const { ipcMain } = require('electron');
const {
  configPath,
  readConfig,
  writeConfig,
  getWindow,
  agentSessions,
} = require('../core/state.cjs');
const { serializeMessage } = require('../core/serialize.cjs');
const { updateSidebar } = require('../sidebar-state.cjs');
const {
  detail,
  createDraft,
  findManager,
  ensureAgent,
  listWorkspaces,
  forkSession,
  composerResources,
  invalidateIndex,
  forgetDetail,
  dropDraft,
  updateSessionSummary,
  indexSessions,
  releaseInactiveSessions,
} = require('../services/sessions.cjs');
const { setSessionModel, setSessionThinking } = require('../services/sessions.cjs');
const { fileReferenceContext } = require('../services/workspace.cjs');
const { attachmentContext } = require('../services/attachments.cjs');
const { extensionState, extensionAction, extensionDialogResult, extensionSelectResult, updateEditorText, footerAction } = require('../services/extensions.cjs');
const { createAutoTitleGenerator } = require('../services/auto-title.cjs');
const { beginTurn, endTurn, saveTurnDiff } = require('../services/turn-diff.cjs');
const { watchCompactionRecovery } = require('../services/compaction-recovery.cjs');
const activeRequests = new Map();

/** 把 Pi Studio 的名称写回 Pi 的 session_info，保证 CLI / resume 看到同一个名字。 */
async function syncNativeName(id, name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return;
  try {
    const found = await findManager(id);
    if (!found) return;
    if (found.manager.getSessionName() === text) return;
    found.manager.appendSessionInfo(text);
  } catch {
    /* 原生名称同步失败不影响桌面端标题 */
  }
}

const autoTitles = createAutoTitleGenerator({
  readMetadata: id => readConfig(configPath(), {}).sessionMetadata?.[id] || {},
  updateMetadata: (id, patch) => {
    const config = readConfig(configPath(), {});
    writeConfig(configPath(), { ...config, sessionMetadata: {
      ...config.sessionMetadata, [id]: { ...config.sessionMetadata?.[id], ...patch },
    } });
  },
  notify: id => {
    const meta = readConfig(configPath(), {}).sessionMetadata?.[id];
    if (meta?.autoTitle) void syncNativeName(id, meta.autoTitle);
    invalidateIndex(); forgetDetail(id);
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('pi:sessions-changed');
  },
});


/**
 * 发送消息。
 *
 * 流程：
 *  1. 准备 AgentSession（首次会创建）
 *  2. 把 `@` 引用的文件与落盘附件作为隐藏上下文先塞进会话
 *  3. 订阅流式事件并转发给渲染进程（requestId 用于前端配对）
 *  4. 发送真正的 prompt；完成后让会话索引与详情缓存失效
 */
async function prompt(event, { sessionId, text, requestId, mentions, attachments, images }) {
  const found = await findManager(sessionId);
  if (!found) throw new Error('会话不存在');
  const firstTurn = !found.manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user');
  updateSessionSummary(sessionId, text);
  const session = await ensureAgent(sessionId, found.manager, found.cwd);
  activeRequests.set(sessionId, requestId);

  // 文件 / 附件上下文：作为一条不展示的自定义消息注入，不触发新回合
  const referenceBlocks = await fileReferenceContext(found.cwd, mentions);
  const attachedBlocks = await attachmentContext(attachments);
  if (referenceBlocks.length > 0 || attachedBlocks.length > 0) {
    try {
      await session.sendCustomMessage(
        {
          customType: 'pi-studio:file-reference',
          content: [
            { type: 'text', text: 'The user referenced the following workspace files or attachments. Treat them as primary context for this request.' },
            ...referenceBlocks,
            ...attachedBlocks,
          ],
          display: false,
        },
        { triggerTurn: false },
      );
    } catch {
      /* 文件上下文属于尽力而为 */
    }
  }

  // 流式事件 → 渲染进程
  const changed = () => event.sender.send('pi:sessions-changed');
  changed();
  const send = (payload) => event.sender.send('pi:prompt-event', { requestId, ...payload });
  // message_update 携带的是完整消息而不是增量，可以合并到下一帧再发：
  // 高速模型每秒会产生大量 token，逐个 IPC 只会把主进程和渲染层都拖慢。
  // 用 timestamp 分组，避免打断同时流式的助手消息与工具结果。
  const pendingUpdates = new Map();
  let updateTimer;
  const flushUpdate = () => {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
    if (pendingUpdates.size === 0) return;
    const batch = [...pendingUpdates.values()];
    pendingUpdates.clear();
    for (const message of batch) send({ type: 'message_update', message });
  };
  let compactionSeen = false;
  let recovering = false;
  let recoveryTimer;
  let recoveryPromise;
  let resolveRecovery;
  let cleaned = false;
  const unsubscribe = session.subscribe((piEvent) => {
    if (piEvent.type === 'message_update') {
      if (piEvent.message.role === 'user') return;
      const message = serializeMessage(piEvent.message);
      if (!message) return;
      pendingUpdates.set(`${message.role}:${message.timestamp}`, message);
      if (!updateTimer) updateTimer = setTimeout(flushUpdate, 16);
      return;
    }
    if (piEvent.type === 'message_start' || piEvent.type === 'message_end') {
      // 开始 / 结束帧必须立即到达；先把上一帧积压的最新内容发出去。
      flushUpdate();
      const message = serializeMessage(piEvent.message);
      if (message) send({ type: piEvent.type, message });
      if (piEvent.type === 'message_end') {
        // 只有用户消息会影响草稿标题与侧边栏排序；助手 / 工具消息沿用文件 mtime。
        if (piEvent.message.role === 'user') {
          updateSessionSummary(sessionId, text);
          changed();
        }
      }
    }
    if (piEvent.type === 'compaction_start') {
      compactionSeen = true;
      send({ type: 'compaction-start', reason: piEvent.reason });
    }
    if (piEvent.type === 'compaction_end') {
      send({ type: 'compaction-end', reason: piEvent.reason, aborted: piEvent.aborted, errorMessage: piEvent.errorMessage });
      if (recovering) watchRecovery();
    }
    if (piEvent.type === 'auto_retry_start') {
      send({ type: 'retry-start', attempt: piEvent.attempt, maxAttempts: piEvent.maxAttempts, delayMs: piEvent.delayMs, errorMessage: piEvent.errorMessage });
    }
    if (piEvent.type === 'auto_retry_end') {
      send({ type: 'retry-end', success: piEvent.success, attempt: piEvent.attempt, finalError: piEvent.finalError });
    }
  });

  // 回合开始前记录 Git 工作树快照；非 Git 仓库返回 null，前端回退到工具统计。
  const diffToken = await beginTurn(found.cwd, requestId).catch(() => null);
  let diffFinished = false;
  const finishTurnDiff = async () => {
    if (diffFinished || !diffToken) return;
    diffFinished = true;
    try {
      const diff = await endTurn(diffToken);
      if (!diff || diff.files.length === 0) return;
      const at = [...session.messages].reverse().find((message) => message.role === 'assistant')?.timestamp || Date.now();
      const payload = { at, ...diff };
      try { saveTurnDiff(sessionId, payload); } catch { /* 存储失败仍把本轮结果推给界面 */ }
      forgetDetail(sessionId);
      send({ type: 'turn-diff', at, diff: payload });
      changed();
    } catch {
      /* 统计失败不影响会话本身 */
    }
  };

  /** 收尾：索引、持久化、通知前端。正常回合与压缩恢复共用。 */
  let doneSent = false;
  async function completeRun() {
    if (doneSent) return;
    doneSent = true;
    flushUpdate();
    invalidateIndex();
    forgetDetail(sessionId);
    // Sidebar indexing must not strand a finished run in the busy state.
    await indexSessions(true).catch(() => {});
    dropDraft(sessionId);
    send({ type: 'done' });
    // diff 在 done 之后异步计算，不阻塞流式收尾。
    void finishTurnDiff();
  }

  function cleanupRun() {
    if (cleaned) return;
    cleaned = true;
    if (recoveryTimer) { recoveryTimer(); recoveryTimer = undefined; }
    invalidateIndex();
    forgetDetail(sessionId);
    unsubscribe();
    if (activeRequests.get(sessionId) === requestId) activeRequests.delete(sessionId);
    changed();
  }

  /**
   * 压缩恢复观察器。
   *
   * 自动压缩会中止当前请求，再由扩展注入一条隐藏的「继续」消息启动新回合。
   * 这里在压缩结束后等待新回合开始并结束，然后才发送 done；期间保持订阅，
   * 继续把恢复回合的流式输出转发给前端。
   */
  function watchRecovery() {
    if (recoveryTimer) return;
    recoveryTimer = watchCompactionRecovery(session, {
      onCompacted: () => send({ type: 'compaction-end' }),
      onComplete: () => {
        recoveryTimer = undefined;
        void completeRun().catch(() => { /* 收尾失败仍要解除订阅 */ }).finally(() => {
          recovering = false;
          cleanupRun();
          resolveRecovery?.();
        });
      },
    });
  }

  function beginRecovery() {
    if (!recoveryPromise) {
      recoveryPromise = new Promise((resolve) => { resolveRecovery = resolve; });
    }
    if (recovering) return recoveryPromise;
    recovering = true;
    send({ type: 'compaction-interrupted', compacting: session.isCompacting });
    watchRecovery();
    return recoveryPromise;
  }

  try {
    const imageBlocks = Array.isArray(images)
      ? images.filter((image) => image && image.type === 'image' && typeof image.data === 'string' && typeof image.mimeType === 'string').slice(0, 8)
      : [];
    // 标题与主回合并行生成：不等回答结束，失败也不影响发送。
    if (firstTurn) {
      void autoTitles.generate({
        id: sessionId,
        firstMessage: text,
        reply: '',
        model: session.model,
        complete: (model, context, options) => session.modelRuntime.completeSimple(model, context, options),
        hasExplicitName: () => Boolean(found.manager.getSessionName()),
      }).catch(() => {});
    }
    let disposition;
    // Extension continuations and a reopened session can be running even when
    // the renderer believes it is idle. Let the SDK atomically decide to queue.
    await session.prompt(text, {
      ...(imageBlocks.length ? { images: imageBlocks } : {}),
      streamingBehavior: 'followUp',
      preflightResult: value => { disposition = value; },
    });
    if (disposition === 'queued' || session.isStreaming) {
      send({ type: 'run-attached' });
      await beginRecovery();
      return;
    }
    flushUpdate();
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
    const aborted = Boolean(lastAssistant && (lastAssistant.stopReason === 'aborted' || /aborted/i.test(lastAssistant.errorMessage || '')));
    // 压缩中止了本回合：不要立刻 done，保持订阅等待扩展自动继续。
    if (aborted && (compactionSeen || session.isCompacting)) {
      await beginRecovery();
      return;
    }
    await completeRun();
  } catch (error) {
    flushUpdate();
    const message = error instanceof Error ? error.message : String(error);
    // 压缩期间提交的 prompt 会被 Pi 拒绝；同样进入恢复流程，不显示原始英文错误。
    if (compactionSeen || session.isCompacting || /compaction/i.test(message)) {
      await beginRecovery();
      return;
    }
    void finishTurnDiff();
    send({ type: 'error', error: message });
    throw error;
  } finally {
    flushUpdate();
    if (!recovering) cleanupRun();
  }

}

/** 侧边栏操作：分叉、重命名、置顶、归档、恢复工作区。 */
async function sidebarAction(input) {
  if (input.kind === 'session') {
    const found = await findManager(input.id);
    if (!found) throw new Error('会话不存在');
    if (input.action === 'fork') return forkSession(input.id);
  } else if (input.kind !== 'workspace' || !(await listWorkspaces()).some((item) => item.cwd === input.id)) {
    throw new Error('工作区不存在');
  }
  writeConfig(configPath(), updateSidebar(readConfig(configPath(), {}), input));
  if (input.kind === 'session' && input.action === 'rename') await syncNativeName(input.id, input.name);
  return { ok: true };
}

function registerSessionsIpc() {
  // 新建草稿会话
  ipcMain.handle('pi:session-create', async (_event, cwd) => createDraft(cwd));

  // 读取会话详情（标题优先用用户重命名后的）
  ipcMain.handle('pi:session', async (_event, id, limit) => {
    const result = await detail(id, Number.isInteger(limit) ? limit : undefined);
    const meta = readConfig(configPath(), {}).sessionMetadata?.[id];
    // Pi 原生名优先（CLI 重命名也能同步）；没有时用桌面端 metadata 兼容旧数据。
    const name = result?.nativeName || meta?.name || meta?.autoTitle;
    const runtime = agentSessions.get(id);
    const requestId = activeRequests.get(id);
    return result && { ...result, title: name || result.title,
      running: Boolean(requestId || runtime?.isStreaming || runtime?.isCompacting),
      compacting: Boolean(runtime?.isCompacting), requestId,
    };
  });

  // 侧边栏动作
  ipcMain.handle('pi:sidebar-action', async (_event, input) => sidebarAction(input));

  // 发送消息（流式）
  ipcMain.handle('pi:prompt', async (event, payload) => prompt(event, payload));

  // 切换会话时释放其它空闲 AgentSession，避免主进程长期保留多份大会话。
  ipcMain.on('pi:session-focus', (_event, sessionId) => releaseInactiveSessions(typeof sessionId === 'string' ? sessionId : null));

  // 会话级模型 / 推理等级：只改当前会话，不写全局默认、不影响其它会话。
  ipcMain.handle('pi:set-session-model', (_event, { sessionId, modelRef }) => setSessionModel(sessionId, modelRef));
  ipcMain.handle('pi:set-session-thinking', (_event, { sessionId, level }) => setSessionThinking(sessionId, level));

  // 运行中排队：steer 立即插话，followUp 当前回合结束后执行
  ipcMain.handle('pi:queue-prompt', async (_event, { sessionId, text, behavior, mentions, attachments, images }) => {
    const found = await findManager(sessionId);
    if (!found) throw new Error('会话不存在');
    const session = await ensureAgent(sessionId, found.manager, found.cwd);

    const referenceBlocks = await fileReferenceContext(found.cwd, mentions);
    const attachedBlocks = await attachmentContext(attachments);
    if (referenceBlocks.length > 0 || attachedBlocks.length > 0) {
      try {
        await session.sendCustomMessage(
          {
            customType: 'pi-studio:file-reference',
            content: [
              { type: 'text', text: 'The user referenced the following workspace files or attachments. Treat them as primary context for this request.' },
              ...referenceBlocks,
              ...attachedBlocks,
            ],
            display: false,
          },
          { triggerTurn: false },
        );
      } catch {
        /* 尽力而为 */
      }
    }

    const imageBlocks = Array.isArray(images)
      ? images.filter((image) => image && image.type === 'image' && typeof image.data === 'string' && typeof image.mimeType === 'string').slice(0, 8)
      : [];
    const queued = behavior === 'steer'
      ? await session.steer(text, imageBlocks.length > 0 ? imageBlocks : undefined, { source: 'interactive' })
      : await session.followUp(text, imageBlocks.length > 0 ? imageBlocks : undefined, { source: 'interactive' });
    return { disposition: queued };
  });

  // 执行扩展注册的斜杠命令（本质上也是一条 prompt）
  ipcMain.handle('pi:run-extension-command', async (_event, { sessionId, command }) => {
    const found = await findManager(sessionId);
    if (!found) throw new Error('会话不存在');
    const session = await ensureAgent(sessionId, found.manager, found.cwd);
    await session.prompt(String(command));
    return { ok: true };
  });

  // 扩展状态：只读已有 AgentSession，不在「打开历史」时创建它。
  // 大会话的 AgentSession 会持有完整消息/图片，历史浏览不应为状态栏付这份内存。
  // 真正发送消息或执行扩展命令时再 ensureAgent，session_start 会推送状态。
  ipcMain.handle('pi:extension-state', async (_event, sessionId) => extensionState(sessionId));

  ipcMain.handle('pi:footer-action', (_event, { sessionId, ...input }) => footerAction(sessionId, input));
  // 通用扩展 surface：widget / custom / footer 共用同一个输入入口。
  ipcMain.handle('pi:extension-action', (_event, { sessionId, ...input }) => extensionAction(sessionId, input));
  ipcMain.handle('pi:extension-dialog-result', (_event, { id, value }) => extensionDialogResult(id, value));
  ipcMain.handle('pi:extension-select-result', (_event, { id, value }) => extensionSelectResult(id, value));
  // 渲染层把输入框当前文本同步给主进程，扩展 getEditorText() 才能同步读取。
  ipcMain.on('pi:editor-text', (_event, { sessionId, text }) => updateEditorText(sessionId, text));

  // 输入框斜杠命令与技能列表
  ipcMain.handle('pi:composer-resources', async (_event, payload) => composerResources(payload || {}));
}

module.exports = { registerSessionsIpc };
