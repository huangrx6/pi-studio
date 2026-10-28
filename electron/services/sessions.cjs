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
const { reasoningFor } = require('./models.cjs');
const { createExtensionUI } = require('./extensions.cjs');
const { updateSidebar } = require('../sidebar-state.cjs');
const { envNameOf } = require('../credential-env.cjs');
const { consumePendingMode } = require('./mode.cjs');
const { sessionTitle } = require('./session-title.cjs');
const { temporaryTitle } = require('./auto-title.cjs');

/** 内存中的草稿会话：id → { manager, cwd }。 */
const drafts = new Map();
/** 正在创建的 AgentSession：同一会话的并发请求共享同一次创建。 */
const agentPromises = new Map();
/** 磁盘会话索引：id → { id, path, cwd, title, updatedAt, messageCount }。 */
const diskSessions = new Map();
/** 会话详情缓存：id → { mtimeMs, size, data }，用文件修改时间判断是否需要重读。 */
const detailCache = new Map();

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
      list.push({ id: draft.manager.getSessionId(), path: '', cwd: draft.cwd, title: draft.title || '新会话', updatedAt: draft.updatedAt || Date.now(), messageCount: draft.title ? 1 : 0 });
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
          return { ...item, title: meta.name || meta.autoTitle || item.title, pinned: Boolean(meta.pinned), archived: Boolean(meta.archived) };
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
async function detail(id) {
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
        const messages = visibleSessionMessages(
          manager
            .getEntries()
            .filter((entry) => entry.type === 'message')
            .map((entry) => serializeMessage(entry.message))
            .filter(Boolean),
        );
        const data = { id, cwd: info.cwd, title: info.title, messages };
        detailCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data });
        return data;
      } catch {
        /* 文件读不了就退回用 manager 读 */
      }
    }
  }

  const found = await findManager(id);
  if (!found) return undefined;
  const messages = visibleSessionMessages(
    found.manager
      .getEntries()
      .filter((entry) => entry.type === 'message')
      .map((entry) => serializeMessage(entry.message))
      .filter(Boolean),
  );
  return { id, cwd: found.cwd, title: drafts.get(id)?.title || diskSessions.get(id)?.title || '新会话', messages };
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
 * 为会话准备 AgentSession（真正能发消息的运行时对象）。
 * 同一个会话只会创建一次，之后复用缓存；打开会话和发送消息可能同时请求，
 * 因此创建过程本身也要去重，否则扩展会被绑定两次。
 */
async function ensureAgent(id, manager, cwd) {
  if (agentSessions.has(id)) {
    const session = agentSessions.get(id);
    // 用户可能刚改了推理强度，复用前同步一下
    session.setThinkingLevel(reasoningFor(session.model, cwd).effectiveThinkingLevel);
    return session;
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
  const modelRef = getModelRef();

  // 先确认密钥可用，否则给出比 Pi 原始报错更明确的提示
  const providerId = agentSessions.get(id)?.model?.provider || modelRef.split('/')[0];
  const stored = readAuth()[providerId];
  const providerConfig = readConfig(modelsFile(), { providers: {} }).providers?.[providerId];
  const reference = providerConfig?.apiKey ?? (stored?.type === 'api_key' ? stored.key : undefined);
  const envName = envNameOf(reference);
  if (envName && !(providerConfig?.apiKey === undefined && stored?.env?.[envName]) && !process.env[envName]) {
    throw new Error(`无法读取环境变量 ${envName}。请在设置中重新保存该来源的 API Key，或直接填写密钥值。`);
  }

  const [provider, ...parts] = modelRef.split('/');
  const model = provider && parts.length > 0 ? runtime.getModel(provider, parts.join('/')) : undefined;
  if (!model) throw new Error(`Pi 模型 ${modelRef} 不在本机目录中`);

  const { session } = await pi.createAgentSession({
    cwd,
    model,
    thinkingLevel: reasoningFor(model, cwd).effectiveThinkingLevel,
    modelRuntime: runtime,
    sessionManager: manager,
    // 完整编码工具集：写入/编辑需要 write/edit，执行命令需要 bash。
    // 权限由 pi-mode-switcher 在 tool_call 阶段拦截询问，不靠裁剪工具实现。
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
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
  { name: 'model', description: '打开模型与账号设置', source: 'builtin' },
  { name: 'thinking', description: '调整模型的思考强度', source: 'builtin' },
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

module.exports = {
  drafts,
  diskSessions,
  indexSessions,
  invalidateIndex,
  listWorkspaces,
  findManager,
  detail,
  createDraft,
  ensureAgent,
  forkSession,
  composerResources,
  forgetDetail,
  dropDraft,
  updateSessionSummary,
};
