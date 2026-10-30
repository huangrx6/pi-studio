/**
 * `window.piApi` 的全局类型声明（渲染进程 ↔ Electron 主进程的唯一契约）。
 *
 * 实现位于 electron/preload.cjs：它用 contextBridge 白名单暴露方法，每个方法
 * 对应一个 ipcRenderer.invoke 通道；事件类方法（onXxx）注册 ipcRenderer.on
 * 监听并返回取消订阅函数，调用方必须在 effect cleanup 中调用，避免重复累积。
 *
 * 约定：invoke 方法失败会 reject（错误信息通常直接可展示）；事件回调是推模式，
 * 渲染进程需自行按 sessionId / requestId 过滤。本文件只声明类型，不产生运行时代码。
 */

export {};
import type { ChatAttachment, ChatMessage, ComposerAttachment, ComposerCommand, ComposerFile, TurnDiff, UploadedAttachment } from './types/chat-types';
import type { ConcreteThinkingLevel, ModelCatalog, ModelSelection, ThinkingLevel } from './types/model-types';
import type { AgentToolCatalog, AgentToolSelection } from './types/agent-tool-types';
import type { SubagentChild, SubagentConfig, SubagentSettingsSnapshot, SubagentTranscript } from './types/subagent-types';
import type {
  HarnessProfileDraft,
  HarnessSettingsSnapshot,
  RuntimePolicy,
} from './types/harness-types';
import type {
  ConversationEvent,
  ConversationKind,
  ConversationOutline,
  ConversationPage,
  ConversationPageCursor,
  ConversationSnapshot,
  ConversationSubmitInput,
  ConversationSubmitResult,
  ConversationSummary,
  ConversationTaskGraph,
  LongTaskState,
} from './types/durable-types';
import type { BackgroundMedia } from './lib/preferences';
import type { UpdateSnapshot } from './types/update-types';
import type { RuntimeRefreshSnapshot } from './types/runtime-types';
import type { UsageAnalyticsSnapshot } from './types/usage-types';
import type {
  ExtensionCommandResult,
  ExtensionDataViewEvent,
  ExtensionDataViewOpenRequest,
  ExtensionDataViewOpenResult,
  ExtensionHostSnapshot,
  ExtensionInstallPreview,
  ExtensionInstallScope,
  ExtensionUpdateCheckSnapshot,
  ExtensionUiSnapshot,
  ConversationExtensionLayout,
  ConversationExtensionUiPreferences,
} from './types/extension-types';
import type {
  PermissionConfirmRequest,
  PermissionConfirmResponse,
  PermissionEvaluation,
  PermissionPolicy,
  PermissionPolicyState,
  PermissionScope,
} from './types/permission-types';

/** 侧边栏里的会话摘要（不含消息正文）。 */
interface PiSessionSummary {
  /** 会话 id，所有会话级 IPC 的主键。 */
  id: string;
  /** 所属工作区绝对路径。 */
  cwd: string;
  /** 会话标题（取首条用户消息或用户重命名）。 */
  title: string;
  /** 最后更新时间戳（毫秒）。 */
  updatedAt: number;
  /** 消息数量，用于侧边栏展示。 */
  messageCount: number;
  /** 是否置顶；置顶会话排在列表前部。 */
  pinned?: boolean;
  /** 是否已归档；归档会话从默认列表隐藏。 */
  archived?: boolean;
  /** 工作项类型；旧会话缺省为普通对话。 */
  kind?: 'conversation' | 'durable';
  /** 主进程当前是否仍有该会话的 Durable 任务在运行。 */
  running?: boolean;
}

/** 一个工作区及其会话列表。 */
interface PiWorkspace {
  /** 工作区绝对路径。 */
  cwd: string;
  /** 文件夹名（展示用）。 */
  name: string;
  /** 该工作区下的会话。 */
  sessions: ConversationSummary[];
  /** 当前工作区中的会话总数，包含归档会话。 */
  sessionCount?: number;
  /** 当前工作区中的归档会话数。 */
  archivedCount?: number;
}

/** 打开会话时返回的完整详情。 */
interface PiDetail {
  /** 会话 id。 */
  id: string;
  /** 会话所属工作区路径。 */
  cwd: string;
  /** 会话标题。 */
  title: string;
  /** 工作项类型；旧会话缺省为普通对话。 */
  kind?: 'conversation' | 'durable';
  /** 完整消息历史（含 toolResult）。 */
  messages: ChatMessage[];
  /** 该会话自己的模型与推理等级（会话级，不跟随全局）。 */
  model?: ModelSelection;
  /** 已持久化的每轮 Git 变更（按轮次结束时间配对）。 */
  turnDiffs?: TurnDiff[];
  /** 是否还有更早的历史消息未加载。 */
  hasMore?: boolean;
  /** 当前窗口第一条消息在完整 transcript 中的绝对序号。 */
  messageStart?: number;
  /** 完整 transcript 的消息总数（不是当前窗口长度）。 */
  totalMessages?: number;
  running?: boolean;
  compacting?: boolean;
  requestId?: string;
}

/** 右侧对话大纲中的一条用户提问（轻量，不含消息正文对象）。 */
interface PiSessionOutlineItem {
  /** 在完整 transcript 中的绝对消息序号，作为稳定 DOM 锚点。 */
  sourceIndex: number;
  /** 压缩空白后的纯文本。 */
  text: string;
  timestamp?: number;
}

interface PiSessionOutline {
  id: string;
  items: PiSessionOutlineItem[];
  /** 完整 transcript 的消息总数。 */
  totalMessages: number;
}

/** 设置面板一次性读取的快照，覆盖模型、来源、MCP、技能、扩展等配置。 */
interface SettingsSnapshot {
  /** 用户手动添加的模型。 */
  customModels: Array<{ providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels?: ConcreteThinkingLevel[]; enabled?: boolean; origin?: 'configured' | 'override' }>;
  /** 模型来源列表。 */
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number; modelsUrl?: string; enabled: boolean; builtin: boolean }>;
  /** MCP 服务器列表。 */
  mcp: Array<{
    name: string;
    transport: string;
    enabled: boolean;
    target: string;
    cwd: string;
    description: string;
    exposure: 'direct' | 'deferred' | 'hidden';
    toolExposure: Record<string, 'direct' | 'deferred' | 'hidden'>;
    timeoutSeconds: number;
    envKeys: string[];
    headerKeys: string[];
    connected: boolean;
    toolCount: number;
    error: string;
    stderr: string;
  }>;
  /** 已安装技能。 */
  skills: Array<{
    name: string;
    description: string;
    path: string;
    baseDir: string;
    scope: 'user' | 'project';
    origin: 'studio' | 'agents';
    bytes: number;
    fingerprint: string;
    trusted: boolean;
    trustChanged: boolean;
    available: boolean;
    disableModelInvocation: boolean;
    warnings: string[];
  }>;
  skillErrors: Array<{ path: string; message: string }>;
  /** 已安装扩展。 */
  extensions: ExtensionHostSnapshot['extensions'];
  officialExtensions: import('./types/extension-types').OfficialExtensionCatalogItem[];
  extensionErrors: ExtensionHostSnapshot['errors'];
  extensionApiVersion: number;
  extensionRegistryUrl: string;
  /** 当前启用的模型 id。 */
  enabledModels: string[];
  /** Pi Studio 的 Agent 工具白名单。 */
  agentTools: AgentToolSelection;
  /** 当前工作区生效的 Harness 配置与全部可切换 profile。 */
  harness: HarnessSettingsSnapshot;
  /** Agent 工具白名单在 Studio SQLite 中的位置。 */
  agentToolsPath: string;
  /** Studio 的 SQLite 数据库与私有资源目录。 */
  storagePath: string;
  databasePath: string;
  skillsPath: string;
  agentsSkillsPath: string;
  projectSkillsPath: string;
  projectAgentsSkillsPath: string;
  extensionsPath: string;
  projectExtensionsPath: string;
  /** 当前模型与推理等级。 */
  model: ModelSelection;
  /** 保存配置后，主进程热更新会话运行时的结果。 */
  runtimeRefresh?: RuntimeRefreshSnapshot;
}

/** Native menu-bar integration exposed by the main process. */
interface MenuBarSettings {
  available: boolean;
  enabled: boolean;
  platform: string;
}

declare global {
  interface Window {
    /**
     * 预加载脚本注入的主进程 API。
     * 所有 invoke 方法都是异步的；事件订阅方法返回取消订阅函数。
     */
    piApi: {
      // ---- 主题、状态与会话 ----
      /** 切换原生窗口主题与全局配色，并同步到主进程及菜单栏。 */
      setTheme(theme: 'light' | 'dark' | 'system', palette: 'lime' | 'ocean' | 'amber' | 'berry'): Promise<void>;
      /** Read the current updater snapshot. */
      updateState(): Promise<UpdateSnapshot>;
      /** Check the latest public GitHub Release. */
      checkForUpdates(options?: { interactive?: boolean }): Promise<UpdateSnapshot>;
      /** Download the currently available release. */
      downloadUpdate(): Promise<UpdateSnapshot>;
      /** Restart and install a downloaded release. */
      installUpdate(): Promise<{ started: boolean }>;
      /** Read the persisted menu-bar visibility preference. */
      menuBarSettings(): Promise<MenuBarSettings>;
      /** Show or remove the native menu-bar status item. */
      setMenuBarVisible(enabled: boolean): Promise<MenuBarSettings>;
      /** 打开系统文件选择器，并把图片或视频复制到应用私有背景目录。 */
      chooseBackgroundMedia(payload?: { replaceUrl?: string }): Promise<BackgroundMedia | null>;
      /** 删除应用私有背景目录中的媒体文件；无效地址会被安全忽略。 */
      removeBackgroundMedia(url: string): Promise<{ removed: boolean }>;
      /** 读取 Studio SQLite 中的工具批准方式。 */
      modeGet(payload?: { cwd?: string; sessionId?: string }): Promise<PermissionPolicyState>;
      /** 切换批准方式；Durable 权限 hook 在下一次工具调用前热读取。 */
      modeSet(payload: {
        mode: PermissionPolicyState['mode'];
        scope?: PermissionScope;
        cwd?: string;
        sessionId?: string;
      }): Promise<PermissionPolicyState & { applied: boolean }>;
      /** 读取按作用域继承后的完整权限策略。 */
      permissionPolicyGet(payload?: { cwd?: string; sessionId?: string }): Promise<PermissionPolicyState>;
      /** 保存一个完整作用域的声明式策略。 */
      permissionPolicySet(payload: {
        scope: PermissionScope;
        cwd?: string;
        sessionId?: string;
        policy: PermissionPolicy;
      }): Promise<PermissionPolicyState>;
      /** 删除工作区或会话覆盖，恢复为继承更宽作用域；user 重置为 smart。 */
      permissionPolicyReset(payload: {
        scope: PermissionScope;
        cwd?: string;
        sessionId?: string;
      }): Promise<PermissionPolicyState>;
      /** 用与运行时完全相同的规则引擎预览一次工具调用。 */
      permissionEvaluate(payload: {
        scope: PermissionScope;
        cwd?: string;
        sessionId?: string;
        policy: PermissionPolicy;
        call: { name: string; arguments?: Record<string, unknown> };
      }): Promise<PermissionEvaluation>;
      /** 扩展请求确认工具操作时触发；需要调用 confirmResponse 回传结果。 */
      onConfirmRequest(listener: (payload: PermissionConfirmRequest) => void): () => void;
      /** 回传确认结果；超时或窗口关闭视为拒绝。 */
      confirmResponse(payload: PermissionConfirmResponse): void;
      /** 读取侧边栏工作区/会话列表、当前模型与工作目录。 */
      state(cwd?: string): Promise<{ workspaces: PiWorkspace[]; model: ModelSelection; cwd: string }>;
      /** 新建一条 Durable 会话；长期任务同时启用持久目标续跑。 */
      createConversation(payload: {
        cwd: string;
        kind?: ConversationKind;
        title?: string;
        goal?: string;
      }): Promise<ConversationPage>;
      /** 读取一页 fork-aware 的 Durable 历史，cursor 来自上一页的 page.nextCursor。 */
      conversationPage(payload: {
        id: string;
        limit?: number;
        cursor?: ConversationPageCursor;
      }): Promise<ConversationPage | undefined>;
      /** 获取完整提问大纲；仅用于导航，不参与消息窗口渲染。 */
      conversationOutline(id: string): Promise<ConversationOutline | undefined>;
      /** 获取会话当前运行、压缩和任务快照。 */
      conversationSnapshot(id: string): Promise<ConversationSnapshot | undefined>;
      /** 订阅一条会话；返回与事件流同一一致性边界的初始快照。 */
      subscribeConversation(id: string): Promise<ConversationSnapshot>;
      unsubscribeConversation(id: string): Promise<{ ok: boolean }>;
      /** 提交输入。繁忙策略直接映射 Durable 的 steer / followUp / reject。 */
      conversationSubmit(payload: ConversationSubmitInput): Promise<ConversationSubmitResult>;
      /** 热切换模型与 thinking；繁忙时只影响下一请求。 */
      conversationConfigure(payload: {
        id: string;
        modelRef?: string;
        thinkingLevel?: ThinkingLevel;
      }): Promise<ModelSelection>;
      conversationInterrupt(id: string): Promise<{ ok: boolean }>;
      conversationAction(payload: {
        kind: 'workspace' | 'session';
        id: string;
        action: 'rename' | 'remove' | 'pin' | 'archive' | 'fork' | 'long-task-pause' | 'long-task-resume';
        name?: string;
        entryId?: string;
      }): Promise<ConversationSummary | { ok: boolean; longTask?: LongTaskState; wasRunning?: boolean }>;
      conversationTaskGraph(id: string): Promise<ConversationTaskGraph>;
      /** 读取当前会话的子 Agent 总览，包含已完成记录与实时快照。 */
      sessionSubagents(id: string): Promise<SubagentChild[]>;
      /** 读取一个受信任子 Agent session 的只读 transcript。 */
      subagentTranscript(payload: { sessionId: string; childKey: string; limit?: number; cursor?: string }): Promise<SubagentTranscript>;
      /** 永久删除当前父会话中的一个子智能体及其独立上下文。 */
      deleteSubagent(payload: { sessionId: string; childKey: string }): Promise<{ ok: boolean; name: string; deletedConversations: number }>;
      // ---- 聊天发送 ----
      // ---- 文件浏览 ----
      /** 列出工作区某目录下的条目。 */
      files(cwd: string, path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }> }>;
      /** 读取单个文件文本；binary 为 true 时 text 不可直接展示。 */
      file(cwd: string, path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      /** 只读打开工作区外的绝对路径（文件变更卡片）。 */
      temporaryModel(payload?: { modelRef?: string; thinkingLevel?: import('./types/model-types').ThinkingLevel }): Promise<import('./types/model-types').ModelSelection>;
      temporaryPrompt(payload: { id: string; text: string; images: { data: string; mimeType: string }[]; modelRef: string; thinkingLevel: string }): Promise<{ ok: boolean }>;
      temporaryStop(id: string): Promise<void>;
      temporaryClose(id: string): Promise<void>;
      onTemporary(listener: (event:
        | { id: string; type: 'message' | 'done'; message?: ChatMessage }
        | { id: string; type: 'error'; message: string }
      ) => void): () => void;
      turnDiffFile(payload: { sessionId: string; at: number; path: string; full?: boolean; ignoreWhitespace?: boolean }): Promise<import('./types/chat-types').TurnDiffFile>;
      fileAbsolute(path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      /** 查询系统里可用来打开该文件的应用。 */
      fileActions(payload: { cwd: string; path: string }): Promise<{ apps: Array<{ name: string; path: string; icon?: string }> }>;
      /** 用指定应用（或系统默认应用）打开文件。 */
      openWith(payload: { cwd: string; path: string; appPath?: string }): Promise<{ ok: boolean }>;
      /** 在 Finder 中定位文件。 */
      revealFile(payload: { cwd: string; path: string }): Promise<{ ok: boolean }>;
      /** 用系统浏览器打开任意 http(s) 链接。 */
      openExternal(url: string): Promise<{ ok: boolean }>;
      /** 按偏好打开链接：external 走系统浏览器，window 走应用内子窗口。 */
      openLink(url: string, mode: 'external' | 'window'): Promise<{ ok: boolean }>;

      // ---- 输入框辅助 ----
      /** 读取斜杠命令、提示词、技能等输入资源。 */
      composerResources(payload: { sessionId?: string; cwd?: string }): Promise<{
        commands: ComposerCommand[];
        skills: ComposerCommand[];
      }>;
      /** 按关键字搜索工作区文件，供 @ 提及补全。 */
      searchFiles(payload: { cwd: string; query: string }): Promise<{ files: ComposerFile[] }>;

      // ---- 附件 ----
      /** 把长文本保存成附件文件，返回路径与可直接插回输入框的 promptText。 */
      saveAttachment(payload: { sessionId: string; text: string }): Promise<ChatAttachment & { notice: string; promptText: string; marker: string }>;
      /** 打开系统文件选择器挑选附件。 */
      pickAttachments(payload: { sessionId?: string }): Promise<{ attachments: ComposerAttachment[] }>;
      /** 保存粘贴/拖入的上传文件，返回带 marker 的落盘信息。 */
      saveUpload(payload: { sessionId?: string; name: string; mime: string; data: string }): Promise<UploadedAttachment>;
      /** 打开系统目录选择器，返回所选工作区路径。 */
      chooseWorkspace(): Promise<string | undefined>;

      // ---- 模型 ----
      /** 读取模型目录、启用列表与当前选择。 */
      models(cwd?: string): Promise<ModelCatalog>;
      /** Read aggregate token usage from Studio SQLite for the last N local days. */
      usageSummary(payload?: { days?: number }): Promise<UsageAnalyticsSnapshot>;
      /** 读取某来源下可选模型及启用状态。 */
      providerModels(providerId: string): Promise<{ models: Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; thinkingLevels?: ConcreteThinkingLevel[]; origin: 'builtin' | 'configured' | 'override'; deletable: boolean }> }>;
      /** 从来源的 /models 接口读取模型，不保存到 Pi 配置。 */
      discoverProviderModels(providerId: string): Promise<{ endpoint: string; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels: ConcreteThinkingLevel[] }> }>;
      /** 把发现的模型合并到来源，已有模型保持不变。 */
      importProviderModels(payload: { providerId: string; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels?: ConcreteThinkingLevel[] }>; cwd?: string }): Promise<SettingsSnapshot>;
      /** 读取来源的 baseUrl、API 类型与图标。 */
      providerConfig(providerId: string): Promise<{ providerId: string; name: string; baseUrl: string; api: string; icon: string; modelsUrl: string; builtin: boolean; enabled: boolean }>;
      /** 切换模型，返回新的选择快照。 */
      setModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      /** 设置 Studio 新对话的默认模型。 */
      setDefaultModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      /** 切换推理等级，返回新的选择快照。 */
      setThinkingLevel(payload: { modelRef: string; level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      /** 设置 Studio 新对话的默认推理等级。 */
      setDefaultThinkingLevel(payload: { level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      /** 设置启用的模型 id 列表。 */
      setEnabledModels(payload: { models: string[]; cwd?: string }): Promise<SettingsSnapshot>;
      /** 添加或编辑自定义模型，成功后返回最新设置快照。 */
      addCustomModel(payload: { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; thinkingLevels?: ConcreteThinkingLevel[]; editing?: boolean; origin?: 'builtin' | 'configured' | 'override'; cwd?: string }): Promise<SettingsSnapshot>;
      /** 删除自定义模型。 */
      removeCustomModel(payload: { providerId: string; modelId: string; cwd?: string }): Promise<SettingsSnapshot>;

      // ---- 设置：MCP / 技能 / 扩展 / 包 ----
      /** 读取完整设置快照。 */
      settings(cwd?: string): Promise<SettingsSnapshot>;
      /** 读取会话扩展的全局顺序、布局和会话级覆盖。 */
      conversationExtensionUiPreferences(): Promise<ConversationExtensionUiPreferences>;
      /** 保存全局或单个会话的扩展顺序，并更新全局卡片布局。 */
      saveConversationExtensionUiPreferences(payload: {
        layout?: ConversationExtensionLayout;
        globalOrder?: string[];
        sessionId?: string;
        /** null 删除当前会话覆盖，恢复全局顺序。 */
        sessionOrder?: string[] | null;
      }): Promise<ConversationExtensionUiPreferences>;
      /** 扫描当前工作区可用的核心、扩展包与本地扩展工具。 */
      agentToolCatalog(payload?: { cwd?: string; refresh?: boolean }): Promise<AgentToolCatalog>;
      /** 保存 Agent 工具白名单与来源快照。 */
      setAgentTools(payload: { tools: AgentToolSelection; cwd?: string }): Promise<SettingsSnapshot>;
      /** 读取 Harness 配置 profile、section 定义与当前工作区选择。 */
      harnessSettings(cwd?: string): Promise<HarnessSettingsSnapshot>;
      /** 保存当前 profile；变更在下一请求生效。 */
      saveHarnessProfile(payload: {
        cwd?: string;
        profile: HarnessProfileDraft;
      }): Promise<HarnessSettingsSnapshot>;
      /** 为全局默认或当前工作区选择 profile。 */
      selectHarnessProfile(payload: {
        cwd?: string;
        id: string;
        scope: 'global' | 'workspace' | 'inherit';
      }): Promise<HarnessSettingsSnapshot>;
      /** 恢复内置或自定义 profile 的 Studio 基线内容。 */
      resetHarnessProfile(payload: {
        cwd?: string;
        id: string;
      }): Promise<HarnessSettingsSnapshot>;
      /** 删除自定义 profile，并清理指向它的工作区选择。 */
      deleteHarnessProfile(payload: {
        cwd?: string;
        id: string;
      }): Promise<HarnessSettingsSnapshot>;
      /** 保存所有 Durable 会话共享的运行策略；下一任务边界生效。 */
      saveRuntimePolicy(payload: {
        cwd?: string;
        policy: RuntimePolicy;
      }): Promise<HarnessSettingsSnapshot>;
      /** 读取 Studio 子 Agent 的模型、thinking 与工具权限。 */
      subagentSettings(cwd?: string): Promise<SubagentSettingsSnapshot>;
      /** 保存一个范围的模型、thinking 与子 Agent 工具白名单。 */
      saveSubagentSettings(payload: { cwd: string; scope: 'user' | 'project'; settings: SubagentConfig }): Promise<SubagentSettingsSnapshot>;
      /** 保存某来源的 API Key。 */
      setKey(payload: { providerId: string; apiKey: string }): Promise<any>;
      /** 保存来源配置（baseUrl、API 类型、首个模型、可选 API Key）。 */
      addProvider(payload: { providerId: string; name: string; baseUrl: string; api: string; apiKey?: string; icon?: string; modelsUrl?: string; editing?: boolean; cwd?: string }): Promise<{ settings: SettingsSnapshot; models: ModelCatalog }>;
      /** 启用或停用一个模型来源；停用后其模型不会进入新的模型目录。 */
      setProviderEnabled(payload: { providerId: string; enabled: boolean; cwd?: string }): Promise<SettingsSnapshot>;
      /** 永久删除来源连接、模型配置和已保存凭据。 */
      removeProvider(payload: { providerId: string; cwd?: string }): Promise<SettingsSnapshot>;
      /** 读取 MCP 服务器配置详情。 */
      mcpConfig(name: string): Promise<{
        name: string;
        transport: string;
        command: string;
        args: string[];
        cwd: string;
        url: string;
        description: string;
        env: string;
        headers: string;
        envKeys: string[];
        headerKeys: string[];
        exposure: 'direct' | 'deferred' | 'hidden';
        toolExposure: Record<string, 'direct' | 'deferred' | 'hidden'>;
        timeoutSeconds: number;
        enabled: boolean;
      }>;
      /** 保存 MCP 服务器；originalName 用于编辑时重命名。 */
      addMcp(payload: {
        name: string;
        transport: string;
        command?: string;
        args: string[];
        mcpCwd?: string;
        url?: string;
        description?: string;
        env?: string;
        headers?: string;
        clearEnv?: boolean;
        clearHeaders?: boolean;
        exposure?: 'direct' | 'deferred' | 'hidden';
        toolExposure?: Record<string, 'direct' | 'deferred' | 'hidden'>;
        timeoutSeconds?: number;
        originalName?: string;
        cwd?: string;
      }): Promise<SettingsSnapshot>;
      /** 启用/停用 MCP 服务器。 */
      setMcpEnabled(payload: { name: string; enabled: boolean; cwd?: string }): Promise<any>;
      /** 删除 MCP 服务器。 */
      removeMcp(name: string, cwd?: string): Promise<any>;
      /** 添加技能（scope 决定用户级还是工作区级）。 */
      addSkill(payload: { scope: string; cwd?: string }): Promise<any>;
      /** 删除技能目录。 */
      removeSkill(path: string, cwd?: string): Promise<any>;
      /** 信任或撤销当前工作区中的项目技能。 */
      setSkillTrusted(payload: { path: string; trusted: boolean; cwd?: string }): Promise<SettingsSnapshot>;
      /** 添加扩展。 */
      addExtension(payload: { scope: string; cwd?: string }): Promise<any>;
      /** 打开系统选择器，返回扩展目录或 `.pi-extension.zip` 的本地路径。 */
      pickExtensionSource(kind: 'directory' | 'package'): Promise<string | undefined>;
      /** 在 quarantine 中校验来源并生成安装预览；此时不会修改活动版本。 */
      prepareExtensionInstall(payload: {
        source: string;
        scope: ExtensionInstallScope;
        cwd?: string;
        registryUrl?: string;
        expectedSha256?: string;
        allowPrerelease?: boolean;
      }): Promise<ExtensionInstallPreview>;
      /** Check stable registry, GitHub, official, or HTTPS sources without installing. */
      checkExtensionUpdates(payload: {
        scope: ExtensionInstallScope;
        cwd?: string;
        registryUrl?: string;
        allowPrerelease?: boolean;
      }): Promise<ExtensionUpdateCheckSnapshot>;
      /** Read the signed/current packaged official catalog and safely apply compatible, non-expanding updates. */
      officialExtensions(payload?: { cwd?: string }): Promise<import('./types/extension-types').OfficialExtensionCatalogSnapshot>;
      /** Prepare an official extension through the same quarantine and integrity pipeline as user extensions. */
      prepareOfficialExtension(id: string): Promise<ExtensionInstallPreview>;
      /** Persist whether a non-expanding official update may be applied automatically. */
      setOfficialExtensionAutoUpdate(payload: {
        id: string;
        enabled: boolean;
      }): Promise<import('./types/extension-types').OfficialExtensionCatalogItem>;
      /** 确认预览后原子安装或升级扩展。 */
      installExtension(payload: {
        token: string;
        scope: ExtensionInstallScope;
        cwd?: string;
        acceptedPermissions: string[];
        acceptedProviderAccess?: string[];
        acceptedRequirements?: boolean;
        acceptedExecution?: boolean;
        acceptedPublisherKey?: boolean;
      }): Promise<{
        installed: {
          id: string;
          version: string;
          activeCodePath: string;
          dataPath: string;
          contentChanged: boolean;
          trustRevoked: boolean;
        };
        settings: SettingsSnapshot;
      }>;
      /** 丢弃未提交的安装预览与 quarantine 文件。 */
      disposeExtensionInstall(token: string): Promise<void>;
      /** 切换到一个已保留的历史版本，无需重新下载。 */
      rollbackExtension(payload: {
        id: string;
        scope: ExtensionInstallScope;
        cwd?: string;
      }): Promise<{
        installed: {
          id: string;
          version: string;
          activeCodePath: string;
          dataPath: string;
          contentChanged: boolean;
          trustRevoked: boolean;
        };
        settings: SettingsSnapshot;
      }>;
      extensionPublisherTrust(): Promise<import('./types/extension-types').ExtensionPublisherTrustSnapshot>;
      revokeExtensionPublisherKey(payload: {
        publisher: string;
        keyId: string;
      }): Promise<import('./types/extension-types').ExtensionPublisherTrustSnapshot>;
      /** 保存 registry 地址；仅接受 HTTPS 与本机回环 HTTP。 */
      setExtensionRegistryUrl(url: string): Promise<{ extensionRegistryUrl: string }>;
      /** 删除扩展。 */
      removeExtension(payload: { id: string; cwd?: string }): Promise<any>;
      /** 读取扩展宿主与声明式 UI contribution 快照。 */
      extensionsSnapshot(cwd?: string): Promise<ExtensionHostSnapshot>;
      /** 重新扫描并热加载用户、项目与 MCP 扩展。 */
      reloadExtensions(cwd?: string): Promise<{ status: string; refreshedAt: number; studio: ExtensionHostSnapshot }>;
      /** 启用或停用一个扩展；下一请求生效。 */
      setExtensionEnabled(payload: { id: string; enabled: boolean; cwd?: string }): Promise<SettingsSnapshot>;
      /** 信任或撤销一个项目扩展。 */
      setExtensionTrusted(payload: { id: string; trusted: boolean; cwd?: string }): Promise<SettingsSnapshot>;
      /** 读取 JSON-safe 的声明式 UI contribution 快照。 */
      extensionsUi(cwd?: string): Promise<ExtensionUiSnapshot>;
      /** 打开一个有引用计数和生命周期清理保证的实时扩展数据视图。 */
      openExtensionDataView(payload: ExtensionDataViewOpenRequest): Promise<ExtensionDataViewOpenResult>;
      /** 关闭当前窗口持有的实时扩展数据视图。 */
      closeExtensionDataView(subscriptionId: string): Promise<{ closed: boolean }>;
      /** 扩展实时数据更新；调用方按 subscriptionId 或 sourceId 过滤。 */
      onExtensionDataView(listener: (event: ExtensionDataViewEvent) => void): () => void;
      /** 执行扩展命令；命令内声明的 UI 动作仍由白名单校验。 */
      runExtensionCommand(payload: {
        commandId: string;
        sessionId?: string;
        cwd?: string;
        input?: string;
      }): Promise<ExtensionCommandResult>;
      /** 扩展启停、信任或热加载后通知所有槽位刷新。 */
      onExtensionsChanged(listener: () => void): () => void;

      // ---- 事件订阅（返回取消订阅函数） ----
      /** 应用菜单「设置…」被点击。 */
      onOpenSettings(listener: () => void): () => void;
      /** App menu, tray, notification or brand action asked to show updates. */
      onOpenUpdate(listener: () => void): () => void;
      /** Updater state changed in the main process. */
      onUpdateState(listener: (snapshot: UpdateSnapshot) => void): () => void;
      /** The menu-bar panel asked to reveal the main workspace. */
      onOpenMain(listener: () => void): () => void;
      /** A menu-bar completion card asked to open one exact session. */
      onOpenSession(listener: (session: { id: string; cwd: string; title: string }) => void): () => void;
      /** A saved setting refreshed idle runtimes or queued a busy session for its next idle boundary. */
      onRuntimeRefresh(listener: (snapshot: RuntimeRefreshSnapshot) => void): () => void;
      /** 会话索引变化（草稿、标题或排序更新）时刷新侧边栏。 */
      onConversationListChanged(listener: () => void): () => void;
      /** Durable 会话的已提交事件；只能处理已订阅的 conversationId。 */
      onConversationEvent(listener: (event: ConversationEvent) => void): () => void;
    };
  }
}
