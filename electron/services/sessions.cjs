/**
 * 会话服务：磁盘会话索引、会话详情、会话创建/分叉、AgentSession 管理，
 * 以及输入框里的斜杠命令（composer resources）。
 *
 * 会话有两类：
 *  - 草稿（drafts）    还没发过消息、只在内存里的新会话
 *  - 磁盘会话（diskSessions） 已经写成 .jsonl 的历史会话
 *
 * 索引有 10 秒的节流：磁盘可能有很多会话，而前端每次刷新状态都会问一次。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CWD,
  piModule,
  getRuntime,
  getModelRef,
  readAuth,
  readConfig,
  writeConfig,
  modelsFile,
  mcpFile,
  agentDir,
  configPath,
  agentSessions,
} = require('../core/state.cjs');
const { serializeMessage, visibleSessionMessages } = require('../core/serialize.cjs');
const { parseAttachmentMarkers } = require('../core/attachment-markers.cjs');
const { reasoningFor, modelInfoFor } = require('./models.cjs');
const { createExtensionUI } = require('./extensions.cjs');
const { updateSidebar } = require('../sidebar-state.cjs');
const { envNameOf } = require('../credential-env.cjs');
const { consumePendingMode } = require('./mode.cjs');
const { sessionTitle } = require('./session-title.cjs');
const { readTurnDiffs } = require('./turn-diff.cjs');
const { temporaryTitle } = require('./auto-title.cjs');
const { readAgentToolSelection } = require('../settings-config.cjs');
const { clearSubagentRuntime } = require('./subagent-runtime.cjs');

/** 内存中的草稿会话：id → { manager, cwd }。 */
const drafts = new Map();
/** 正在创建的 AgentSession：同一会话的并发请求共享同一次创建。 */
const agentPromises = new Map();
/** 磁盘会话索引：id → { id, path, cwd, title, updatedAt, messageCount }。 */
const diskSessions = new Map();
/** 会话详情缓存：id → { mtimeMs, size, data }，用文件修改时间判断是否需要重读。 */
const detailCache = new Map();
/** 会话详情缓存上限：只缓存小会话，避免大会话在主进程里长期保留一整份副本。 */
const MAX_DETAIL_CACHE = 3;
const MAX_CACHED_FILE_BYTES = 4 * 1024 * 1024;
/** 默认只读取最近这么多条消息；大会话向上翻页，避免一次序列化 15MB JSONL。 */
const DEFAULT_HISTORY_LIMIT = 200;
/** 大纲只承担导航，截断过长提问，避免整份会话的正文再次跨 IPC 传输。 */
const OUTLINE_TEXT_LIMIT = 240;

/**
 * 取最近 limit 条消息，并从最近的用户消息边界开始，避免从半轮开始渲染。
 * startIndex 是该窗口在完整 transcript 中的绝对消息序号，供跨分页锚点使用。
 */
function messageWindow(entries, limit) {
  const total = entries.length;
  if (!Number.isInteger(limit) || limit <= 0 || total <= limit) {
    return { entries, hasMore: false, startIndex: 0, total };
  }
  let startIndex = total - limit;
  let window = entries.slice(startIndex);
  const firstUser = window.findIndex((entry) => entry.message?.role === 'user');
  if (firstUser > 0) {
    startIndex += firstUser;
    window = window.slice(firstUser);
  }
  return { entries: window, hasMore: startIndex > 0, startIndex, total };
}

/** 构造分页详情里的消息，并保留每条消息在完整会话中的绝对序号。 */
function serializeMessageWindow(entries, limit) {
  const window = messageWindow(entries, limit);
  const messages = visibleSessionMessages(
    window.entries
      .map((entry, index) => {
        const message = serializeMessage(entry.message);
        return message ? { ...message, sourceIndex: window.startIndex + index } : null;
      })
      .filter(Boolean),
  );
  return {
    messages,
    hasMore: window.hasMore,
    messageStart: window.startIndex,
    totalMessages: window.total,
  };
}

/** 从用户消息里提取大纲文本，不序列化图片、工具结果等大对象。 */
function outlineText(message) {
  const raw = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      : '';
  const parsed = parseAttachmentMarkers(raw);
  const text = parsed.text.replace(/\s+/g, ' ').trim();
  if (text) return text.length > OUTLINE_TEXT_LIMIT ? `${text.slice(0, OUTLINE_TEXT_LIMIT).trimEnd()}…` : text;
  if (parsed.attachments.length > 0) return '附件消息';
  if (Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image')) return '图片消息';
  return '无文本消息';
}

let sessionsIndexedAt = 0;
let sessionsIndexPromise;
let indexRevision = 0;

/**
 * 建立 / 刷新磁盘会话索引。
 * force=true 时忽略 10 秒节流（例如刚分叉完）。
 */
async function indexSessions(force = false) {
  // force 刷新会重建 revision，让正在进行的旧扫描不再标记「已索引」。
  if (force) invalidateIndex();
  if (!force && sessionsIndexedAt > 0 && Date.now() - sessionsIndexedAt < 10_000) return;
  // 强制刷新时，进行中的扫描可能开始于新会话文件落盘之前；等它结束再重扫一次。
  while (sessionsIndexPromise) {
    await sessionsIndexPromise.catch(() => {});
    if (!force && sessionsIndexedAt > 0 && Date.now() - sessionsIndexedAt < 10_000) return;
    if (sessionsIndexPromise) return sessionsIndexPromise;
  }
  const revision = indexRevision;
  sessionsIndexPromise = (async () => {
    const pi = piModule();
    // Let the SDK discover its own agent directory, including linked session folders.
    const infos = await pi.SessionManager.listAll();
    const next = new Map();
    for (const info of infos) {
      next.set(info.id, { id: info.id, path: info.path, cwd: info.cwd,
        // Pi 原生 session_info 名称优先；它是 CLI 与桌面端共享的标题源。
        nativeName: info.name || '',
        // 首条消息可能是展开后的 <skill> 块，标题要剥掉它只留真实问题。
        title: info.name ? sessionTitle(info.name, info.firstMessage) : temporaryTitle(info.firstMessage),
        updatedAt: info.modified.getTime(), messageCount: info.messageCount });
    }
    diskSessions.clear();
    for (const [id, session] of next) diskSessions.set(id, session);
    sessionsIndexedAt = revision === indexRevision ? Date.now() : 0;
  })().finally(() => {
    sessionsIndexPromise = undefined;
  });
  return sessionsIndexPromise;
}


/**
 * 用户切换会话时释放其它空闲 AgentSession。
 *
 * AgentSession 会同时持有 messages、toolResult、图片和扩展运行时，
 * 长时间打开多个大会话会让主进程常驻数百 MB。流式 / 压缩中的会话不释放。
 */
let focusedSessionId = null;
function releaseInactiveSessions(activeId) {
  focusedSessionId = activeId;
  for (const [id, session] of agentSessions) {
    if (id === activeId) continue;
    if (session.isStreaming || session.isCompacting) continue;
    try { session.dispose(); } catch { /* 会话已失效 */ }
    agentSessions.delete(id);
    clearSubagentRuntime(id);
  }
  for (const id of [...detailCache.keys()]) if (id !== activeId) detailCache.delete(id);
}

/** 让索引失效，下次访问时重新扫描磁盘。 */
function invalidateIndex() {
  indexRevision += 1;
  sessionsIndexedAt = 0;
}

/** 丢弃某个会话的详情缓存（发完消息后调用）。 */
function forgetDetail(id) {
  detailCache.delete(id);
}

/** 移除草稿会话（发送成功后它已经变成磁盘会话）。 */
function dropDraft(id) {
  // Keep a manager reachable until a completed disk scan has discovered its file.
  if (diskSessions.has(id)) drafts.delete(id);
}

function updateSessionSummary(id, text) {
  const draft = drafts.get(id);
  if (draft) {
    if (text && !draft.title) draft.title = temporaryTitle(text);
    draft.updatedAt = Date.now();
  }
  invalidateIndex();
  forgetDetail(id);
}

/**
 * 侧边栏需要的工作区列表。
 * 把磁盘会话、草稿会话按 cwd 分组，并合并 config.json 里的重命名 / 置顶 / 归档 / 隐藏元数据。
 */
async function listWorkspaces() {
  await indexSessions();
  const config = readConfig(configPath(), {});
  const byCwd = new Map();

  for (const session of diskSessions.values()) {
    const list = byCwd.get(session.cwd) || [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }

  // 草稿会话也要出现在侧边栏里
  for (const draft of drafts.values()) {
    const list = byCwd.get(draft.cwd) || [];
    if (!list.some((item) => item.id === draft.manager.getSessionId())) {
      list.push({ id: draft.manager.getSessionId(), path: '', cwd: draft.cwd, nativeName: draft.manager.getSessionName() || '', title: draft.title || '新会话', updatedAt: draft.updatedAt || Date.now(), messageCount: draft.title ? 1 : 0 });
    }
    byCwd.set(draft.cwd, list);
  }

  for (const cwd of Object.keys(config.workspaceMetadata || {})) if (!byCwd.has(cwd)) byCwd.set(cwd, []);

  return [...byCwd.entries()]
    .filter(([cwd]) => !config.workspaceMetadata?.[cwd]?.hidden)
    .map(([cwd, sessions]) => ({
      cwd,
      name: config.workspaceMetadata?.[cwd]?.name || path.basename(cwd) || cwd,
      sessions: sessions
        .map((item) => {
          const meta = config.sessionMetadata?.[item.id] || {};
          // 原生名（CLI 也可改）优先；没有时再用桌面端遗留的 metadata 名称。
          return { ...item, title: item.nativeName || meta.name || meta.autoTitle || item.title, pinned: Boolean(meta.pinned), archived: Boolean(meta.archived) };
        })
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 查找会话对应的 SessionManager：先看草稿，再看磁盘索引。 */
async function findManager(id) {
  const draft = drafts.get(id);
  if (draft) return { manager: draft.manager, cwd: draft.cwd };
  if (!diskSessions.has(id)) await indexSessions();
  const session = diskSessions.get(id);
  if (!session) return undefined;
  try {
    return { manager: piModule().SessionManager.open(session.path, undefined, session.cwd), cwd: session.cwd };
  } catch {
    return undefined;
  }
}

/**
 * 读取会话详情（消息列表）。
 * 磁盘会话带 mtime + size 缓存，文件没变就不重复解析 JSONL。
 */
async function detail(id, limit = DEFAULT_HISTORY_LIMIT) {
  const draft = drafts.get(id);
  if (!draft) {
    if (!diskSessions.has(id)) await indexSessions();
    const info = diskSessions.get(id);
    if (info) {
      try {
        const stat = fs.statSync(info.path);
        const cached = detailCache.get(id);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data;

        const manager = piModule().SessionManager.open(info.path, undefined, info.cwd);
        const window = serializeMessageWindow(
          manager.getEntries().filter((entry) => entry.type === 'message'),
          limit,
        );
        const data = {
          id,
          cwd: info.cwd,
          title: info.title,
          nativeName: info.nativeName || manager.getSessionName?.() || '',
          messages: window.messages,
          hasMore: window.hasMore,
          messageStart: window.messageStart,
          totalMessages: window.totalMessages,
          model: await sessionModelInfo(manager, info.cwd),
          turnDiffs: readTurnDiffs(id),
        };
        // 只缓存完整且较小的会话；大会话/分页窗口不在主进程保留第二份副本。
        if (!window.hasMore && window.messages.length <= DEFAULT_HISTORY_LIMIT && stat.size <= MAX_CACHED_FILE_BYTES) {
          if (detailCache.size >= MAX_DETAIL_CACHE) detailCache.delete(detailCache.keys().next().value);
          detailCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data });
        }
        return data;
      } catch {
        /* 文件读不了就退回用 manager 读 */
      }
    }
  }

  const found = await findManager(id);
  if (!found) return undefined;
  const entries = found.manager.getEntries().filter((entry) => entry.type === 'message');
  const window = serializeMessageWindow(entries, limit);
  return {
    id,
    cwd: found.cwd,
    title: drafts.get(id)?.title || diskSessions.get(id)?.title || '新会话',
    nativeName: found.manager.getSessionName?.() || '',
    messages: window.messages,
    hasMore: window.hasMore,
    messageStart: window.messageStart,
    totalMessages: window.totalMessages,
    model: await sessionModelInfo(found.manager, found.cwd),
    turnDiffs: readTurnDiffs(id),
  };
}

/**
 * 读取完整提问大纲。
 * 内容区仍按窗口分页加载，但大纲始终覆盖完整 transcript；只返回提问文本、
 * 原始消息序号和时间戳，避免把图片或工具结果复制到渲染进程。
 */
async function outline(id) {
  const found = await findManager(id);
  if (!found) return undefined;
  const entries = found.manager.getEntries().filter((entry) => entry.type === 'message');
  const items = [];
  for (let sourceIndex = 0; sourceIndex < entries.length; sourceIndex += 1) {
    const message = entries[sourceIndex].message;
    if (message?.role !== 'user') continue;
    items.push({
      sourceIndex,
      text: outlineText(message),
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
    });
  }
  return { id, items, totalMessages: entries.length };
}

/**
 * 新建草稿会话。
 * 只做校验和登记，真正落盘发生在第一次 prompt 时。
 */
function createDraft(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('请先选择一个工作区，再开始对话。');
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error('工作区文件夹不存在，请重新选择。');
  }
  const manager = piModule().SessionManager.create(cwd);
  const id = manager.getSessionId();
  drafts.set(id, { manager, cwd });
  return { id, cwd, title: '新会话', messages: [] };
}

/**
 * 读取一个会话自己的模型与推理等级。
 * Pi 会把 model_change / thinking_level_change 写进 transcript；没有记录时用全局默认。
 */
async function sessionModelInfo(manager, cwd) {
  const runtime = await getRuntime();
  const entries = manager.getEntries();
  const change = [...entries].reverse().find((entry) => entry.type === 'model_change');
  const stored = change ? runtime.getModel(change.provider, change.modelId) : undefined;
  let model = stored;
  if (!model) {
    const [provider, ...parts] = getModelRef().split('/');
    model = provider && parts.length > 0 ? runtime.getModel(provider, parts.join('/')) : undefined;
  }
  if (!model) model = runtime.getModels()[0];
  const thinking = [...entries].reverse().find((entry) => entry.type === 'thinking_level_change')?.thinkingLevel;
  return modelInfoFor(model, cwd, thinking);
}

/** 会话创建时从 transcript 恢复模型与推理等级，不跟随其它会话的切换。 */
function storedSessionModel(manager, runtime) {
  const entries = manager.getEntries();
  const change = [...entries].reverse().find((entry) => entry.type === 'model_change');
  const model = change ? runtime.getModel(change.provider, change.modelId) : undefined;
  const thinking = [...entries].reverse().find((entry) => entry.type === 'thinking_level_change')?.thinkingLevel;
  return { model, thinking };
}

/**
 * 为会话准备 AgentSession（真正能发消息的运行时对象）。
 * 同一个会话只会创建一次，之后复用缓存；打开会话和发送消息可能同时请求，
 * 因此创建过程本身也要去重，否则扩展会被绑定两次。
 */
async function ensureAgent(id, manager, cwd) {
  if (agentSessions.has(id)) {
    // 复用会话时不要用全局偏好覆盖它自己的模型 / 推理等级。
    return agentSessions.get(id);
  }
  const pending = agentPromises.get(id);
  if (pending) return pending;
  const created = createAgent(id, manager, cwd).finally(() => agentPromises.delete(id));
  agentPromises.set(id, created);
  return created;
}

// 真正的创建流程：只在 ensureAgent 去重后执行一次。
async function createAgent(id, manager, cwd) {
  const pi = piModule();
  const runtime = await getRuntime();
  const storedModel = storedSessionModel(manager, runtime);
  const [globalProvider, ...globalParts] = getModelRef().split('/');
  const globalModel = globalProvider && globalParts.length > 0 ? runtime.getModel(globalProvider, globalParts.join('/')) : undefined;
  const model = storedModel.model || globalModel || runtime.getModels()[0];
  if (!model) throw new Error('没有可用的 Pi 模型，请先在设置中配置模型');
  const modelRef = `${model.provider}/${model.id}`;

  // 先确认密钥可用，否则给出比 Pi 原始报错更明确的提示
  const providerId = model.provider;
  const stored = readAuth()[providerId];
  const providerConfig = readConfig(modelsFile(), { providers: {} }).providers?.[providerId];
  const reference = providerConfig?.apiKey ?? (stored?.type === 'api_key' ? stored.key : undefined);
  const envName = envNameOf(reference);
  if (envName && !(providerConfig?.apiKey === undefined && stored?.env?.[envName]) && !process.env[envName]) {
    throw new Error(`无法读取环境变量 ${envName}。请在设置中重新保存该来源的 API Key，或直接填写密钥值。`);
  }

  // Pi Studio 的工具白名单保存在自己的 config.json；每个新 AgentSession
  // 都在创建时读取，确保设置页的修改不会影响已运行会话，但会应用到后续会话。
  const tools = readAgentToolSelection(readConfig(configPath(), {})).enabled;
  const { session } = await pi.createAgentSession({
    cwd,
    model,
    thinkingLevel: storedModel.thinking || reasoningFor(model, cwd).effectiveThinkingLevel,
    modelRuntime: runtime,
    sessionManager: manager,
    // 权限仍由 pi-mode-switcher 在 tool_call 阶段拦截；这里只决定哪些工具
    // 会暴露给模型。扩展工具必须出现在白名单中才会注册并可调用。
    tools,
  });
  try {
    await session.bindExtensions({ uiContext: createExtensionUI(id), mode: 'tui' });
  } catch {
    /* 扩展 UI 绑定失败不影响会话本身 */
  }
  // 用户在「新建对话」阶段切换过权限模式：会话建好后补发一次 /mode，
  // 让 pi-mode-switcher 内存里的模式与配置文件保持一致。
  const pendingMode = consumePendingMode();
  if (pendingMode) {
    try {
      await session.prompt(`/mode ${pendingMode}`);
    } catch {
      /* 扩展未安装或未提供 /mode 命令时忽略 */
    }
  }
  agentSessions.set(id, session);
  return session;
}

/**
 * 分叉会话：把已有会话复制成一个新会话，并自动命名。
 * 必须先发过消息（磁盘上要有 .jsonl 文件）。
 */
async function forkSession(id) {
  const pi = piModule();
  const found = await findManager(id);
  if (!found) throw new Error('会话不存在');
  if (agentSessions.get(id)?.isStreaming) throw new Error('请等待当前回复完成后再分叉');
  const source = found.manager.getSessionFile();
  if (!source || !fs.existsSync(source)) throw new Error('请先发送一条消息，再分叉会话');

  const fork = pi.SessionManager.forkFrom(source, found.cwd);
  const forkId = fork.getSessionId();
  const config = readConfig(configPath(), {});
  const title = config.sessionMetadata?.[id]?.name || config.sessionMetadata?.[id]?.autoTitle || diskSessions.get(id)?.title || '新会话';
  const name = `${title.slice(0, 75)} · 分叉`;
  fork.appendSessionInfo(name);
  writeConfig(configPath(), updateSidebar(config, { kind: 'session', id: forkId, action: 'rename', name }));
  invalidateIndex();
  await indexSessions(true);
  return { id: forkId, cwd: found.cwd, title: name };
}

/** 输入框内置的斜杠命令。 */
const BUILTIN_COMPOSER_COMMANDS = [
  { name: 'new', description: '开始一个新会话', source: 'builtin' },
  { name: 'model', description: '切换当前会话或新对话的模型', source: 'builtin' },
  { name: 'thinking', description: '调整当前会话的思考强度', source: 'builtin' },
  { name: 'settings', description: '打开设置', source: 'builtin' },
  { name: 'mcp', description: '管理 MCP 服务器与连接', source: 'builtin' },
  { name: 'copy', description: '复制最后一条助理回复', source: 'builtin' },
];

/**
 * 输入框斜杠命令列表：
 * 内置命令 + 扩展注册的命令 + prompt 模板 + 技能。
 * 会话已存在时从 AgentSession 里取；只有 cwd 时退回全局技能扫描。
 */
async function composerResources({ sessionId, cwd }) {
  const commands = BUILTIN_COMPOSER_COMMANDS.map((command) =>
    command.name === 'mcp'
      ? {
          ...command,
          description: (() => {
            try {
              const configured = readConfig(mcpFile(), { mcpServers: {} });
              return `管理 MCP 服务器与连接（${Object.keys(configured.mcpServers || {}).length} 个）`;
            } catch {
              return '管理 MCP 服务器与连接';
            }
          })(),
        }
      : command,
  );

  let session;
  if (sessionId) {
    try {
      const found = await findManager(sessionId);
      if (found) session = await ensureAgent(sessionId, found.manager, found.cwd);
    } catch {
      /* 退回全局发现 */
    }
  }

  if (session) {
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: command.invocationName, description: command.description || '', source: 'extension' });
    }
    for (const template of session.promptTemplates) {
      commands.push({ name: template.name, description: template.description, source: 'prompt', argumentHint: template.argumentHint });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill' });
    }
  } else if (cwd) {
    try {
      const loaded = piModule().loadSkills({
        cwd,
        agentDir: agentDir(),
        skillPaths: [path.join(agentDir(), 'skills'), path.join(os.homedir(), '.agents', 'skills')],
        includeDefaults: false,
      });
      for (const skill of loaded.skills) {
        commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill' });
      }
    } catch {
      /* 没有全局技能 */
    }
  }

  return { commands };
}


/** 会话级模型切换：只写当前会话的 transcript，不碰全局默认。 */
async function setSessionModel(id, modelRef) {
  if (typeof id !== 'string' || typeof modelRef !== 'string' || !modelRef.includes('/')) throw new Error('模型参数无效');
  const found = await findManager(id);
  if (!found) throw new Error('会话不存在');
  const runtime = await getRuntime();
  const [provider, ...parts] = modelRef.split('/');
  const model = provider && parts.length > 0 ? runtime.getModel(provider, parts.join('/')) : undefined;
  if (!model) throw new Error('模型已不存在，请刷新后重试');
  const session = await ensureAgent(id, found.manager, found.cwd);
  if (session.isStreaming) throw new Error('回复进行中，暂时不能切换模型。');
  if (session.isCompacting) throw new Error('正在压缩上下文，完成后才能切换模型。');
  await session.setModel(model);
  forgetDetail(id);
  // 用运行中的 session 读结果：findManager 可能拿到的是另一个 manager 实例。
  return modelInfoFor(session.model, found.cwd, session.thinkingLevel);
}

/** 会话级推理等级：不跟随全局默认。 */
async function setSessionThinking(id, level) {
  if (typeof id !== 'string' || typeof level !== 'string') throw new Error('推理等级参数无效');
  const found = await findManager(id);
  if (!found) throw new Error('会话不存在');
  const session = await ensureAgent(id, found.manager, found.cwd);
  session.setThinkingLevel(level);
  forgetDetail(id);
  return modelInfoFor(session.model, found.cwd, session.thinkingLevel);
}

module.exports = {
  releaseInactiveSessions,
  drafts,
  diskSessions,
  indexSessions,
  invalidateIndex,
  listWorkspaces,
  findManager,
  detail,
  outline,
  createDraft,
  ensureAgent,
  setSessionModel,
  setSessionThinking,
  forkSession,
  composerResources,
  forgetDetail,
  dropDraft,
  updateSessionSummary,
};
