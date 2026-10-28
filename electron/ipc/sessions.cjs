/**
 * IPC：会话。
 * 新建 / 读取 / 侧边栏操作（重命名、置顶、归档、分叉）/ 发消息 / 排队 / 扩展状态。
 */

const { ipcMain } = require('electron');
const {
  configPath,
  readConfig,
  writeConfig,
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
} = require('../services/sessions.cjs');
const { fileReferenceContext } = require('../services/workspace.cjs');
const { attachmentContext } = require('../services/attachments.cjs');
const { extensionState, footerAction } = require('../services/extensions.cjs');

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
  updateSessionSummary(sessionId, text);
  const session = await ensureAgent(sessionId, found.manager, found.cwd);

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
    if (piEvent.type === 'auto_retry_start') {
      send({ type: 'retry-start', attempt: piEvent.attempt, maxAttempts: piEvent.maxAttempts, delayMs: piEvent.delayMs, errorMessage: piEvent.errorMessage });
    }
    if (piEvent.type === 'auto_retry_end') {
      send({ type: 'retry-end', success: piEvent.success, attempt: piEvent.attempt, finalError: piEvent.finalError });
    }
  });

  try {
    const imageBlocks = Array.isArray(images)
      ? images.filter((image) => image && image.type === 'image' && typeof image.data === 'string' && typeof image.mimeType === 'string').slice(0, 8)
      : [];
    await session.prompt(text, imageBlocks.length > 0 ? { images: imageBlocks } : undefined);
    flushUpdate();
    invalidateIndex();
    forgetDetail(sessionId);
    await indexSessions(true);
    dropDraft(sessionId);
    send({ type: 'done' });
  } catch (error) {
    flushUpdate();
    send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    flushUpdate();
    invalidateIndex();
    forgetDetail(sessionId);
    unsubscribe();
    changed();
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
  return { ok: true };
}

function registerSessionsIpc() {
  // 新建草稿会话
  ipcMain.handle('pi:session-create', async (_event, cwd) => createDraft(cwd));

  // 读取会话详情（标题优先用用户重命名后的）
  ipcMain.handle('pi:session', async (_event, id) => {
    const result = await detail(id);
    const name = readConfig(configPath(), {}).sessionMetadata?.[id]?.name;
    return result && { ...result, title: name || result.title };
  });

  // 侧边栏动作
  ipcMain.handle('pi:sidebar-action', async (_event, input) => sidebarAction(input));

  // 发送消息（流式）
  ipcMain.handle('pi:prompt', async (event, payload) => prompt(event, payload));

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

  // 扩展状态（会话底部）：打开历史会话时也要先绑定扩展，footer 才有内容可渲染。
  // 绑定失败（例如模型密钥缺失）不应挡住会话阅读，退回空状态即可。
  ipcMain.handle('pi:extension-state', async (_event, sessionId) => {
    if (sessionId) {
      try {
        const found = await findManager(sessionId);
        if (found) await ensureAgent(sessionId, found.manager, found.cwd);
      } catch {
        /* 扩展不可用不影响会话本身 */
      }
    }
    return extensionState(sessionId);
  });

  ipcMain.handle('pi:footer-action', (_event, { sessionId, ...input }) => footerAction(sessionId, input));

  // 输入框斜杠命令与技能列表
  ipcMain.handle('pi:composer-resources', async (_event, payload) => composerResources(payload || {}));
}

module.exports = { registerSessionsIpc };
