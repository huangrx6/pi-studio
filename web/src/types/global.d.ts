/**
 * `window.piApi` 的全局类型声明（渲染进程 ↔ Electron 主进程的唯一契约）。
 *
 * 实现位于 electron/preload/index.cjs：它用 contextBridge 白名单暴露方法，每个方法
 * 对应一个 ipcRenderer.invoke 通道；事件类方法（onXxx）注册 ipcRenderer.on
 * 监听并返回取消订阅函数，调用方必须在 effect cleanup 中调用，避免重复累积。
 *
 * 约定：invoke 方法失败会 reject（错误信息通常直接可展示）；事件回调是推模式，
 * 渲染进程需自行按 sessionId / requestId 过滤。本文件只声明类型，不产生运行时代码。
 */

export {};
import type { ProviderQuotaConfig, ProviderQuotaSnapshot, QuotaFieldSuggestion, QuotaMetric, QuotaPreviewInput } from './provider-quota';
import type { CommittedProjection, MutationProjection } from './mutation-types';
import type { ExtensionInstallResult, ExtensionMutationResult } from './extension-types';
import type { ChatAttachment, ChatMessage, ComposerAttachment, ComposerCapability, ComposerCommand, ComposerFile, RequestTrace, TurnDiff, UploadedAttachment } from './chat-types';
import type { ConcreteThinkingLevel, ModelCatalog, ModelSelection, ThinkingLevel } from './model-types';
import type {
  AgentToolCatalog,
  AgentToolProfilePatch,
  AgentToolSelection,
  TemporaryCapabilitiesSnapshot,
  ToolProfilesSnapshot,
} from './agent-tool-types';
import type { ManagedWorktree, SubagentBudgetSnapshot, SubagentChild, SubagentConfig, SubagentProfile, SubagentProfileResources, SubagentSettingsSnapshot, SubagentTranscript } from './subagent-types';
import type { NetworkSettings, NetworkRoute, NetworkTestResult } from './network-types';
import type { DeviceStorageCleanupResult, DeviceStorageSnapshot } from './device-storage';
import type {
  HarnessProfileDraft,
  HarnessSettingsSnapshot,
  RuntimePolicy,
} from './harness-types';
import type {
  ConversationEvent,
  ConversationEditInput,
  ConversationEditResult,
  ConversationOutline,
  ConversationSearchResult,
  ConversationPage,
  ConversationPageCursor,
  ConversationPosition,
  ConversationSnapshot,
  ConversationSubmitInput,
  ConversationSubmitResult,
  ConversationSummary,
  ConversationTaskGraph,
  LongTaskState,
} from './durable-types';
import type { BackgroundMedia } from '../shared/preferences';
import type { FilePreviewResult } from './file-preview-types';
import type { UpdateSnapshot } from './update-types';
import type { RuntimeRefreshSnapshot, StudioRuntimeVersions } from './runtime-types';
import type { GitAction, GitHead, GitReadParams, GitReadResult, GitRepository, GitWorkspaceStatus, WorktreeInputs, WorktreeResults } from './git-types';
import type {
  RuntimeServiceSnapshot,
  RuntimeServiceStopResult,
  TerminalEvent,
  TerminalSessionSnapshot,
} from './runtime-panel-types';
import type { UsageAnalyticsSnapshot, UsageModelMix, UsageProjectScope } from './usage-types';
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
  ConversationExtensionUiPreferences,
} from './extension-types';
import type {
  PermissionConfirmRequest,
  PermissionConfirmResponse,
  PermissionEvaluation,
  PermissionPolicy,
  PermissionPolicyState,
  PermissionProfilePatch,
  PermissionProfilesSnapshot,
  PermissionScope,
} from './permission-types';

export type McpConnectionTestResult = {
  ok: boolean;
  durationMs: number;
  instructions: string;
  capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  tools: Array<{
    name: string;
    title: string;
    description: string;
    argumentCount: number;
    requiredCount: number;
    exposure: string;
  }>;
  resources: Array<{ uri: string; name: string; mimeType: string }>;
  prompts: Array<{ name: string; description: string }>;
  stderr: string;
};

export type SkillSource = {
  id: string;
  name: string;
  type: 'directory' | 'registry' | 'github';
  location: string;
  enabled: boolean;
  lastSyncedAt?: number;
  itemCount: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
};

export type SkillCatalogItem = {
  id: string;
  listingId: string;
  sourceId: string;
  sourceName: string;
  sourceType: 'directory' | 'registry' | 'github';
  name: string;
  description: string;
  version: string;
  invocation: 'automatic' | 'explicit';
  repository: string;
  homepage: string;
  resourceCount?: number;
  totalBytes?: number;
  promptTokens: number;
  installed: boolean;
  installedVersion?: string;
  installedPath?: string;
  updateAvailable: boolean;
};

export type SkillHubSnapshot = {
  refreshedAt: number;
  sources: SkillSource[];
  catalogs: Array<{
    source: SkillSource;
    items: SkillCatalogItem[];
    diagnostics: Array<{ path: string; message: string }>;
  }>;
};

export type SkillInstallPreview = {
  token: string;
  sourceId: string;
  listingId: string;
  sourceName: string;
  sourceType: 'directory' | 'registry' | 'github';
  /** user = Studio 应用目录，shared = ~/.agents/skills，project = 工作区 .pi-studio/skills。 */
  scope: 'user' | 'shared' | 'project';
  requiresTrust: boolean;
  canUpdate: boolean;
  installedVersion: string;
  name: string;
  description: string;
  version: string;
  invocation: 'automatic' | 'explicit';
  resourceCount: number;
  totalBytes: number;
  promptTokens: number;
  files: Array<{ path: string; size: number }>;
  sha256: string;
};

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

export type StudioPluginSummary = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  icon: string;
  iconDataUrl?: string;
  category: string;
  homepage: string;
  sourcePath: string;
  installPath: string;
  provides: {
    mcp?: Array<{ name: string; transport?: string; description?: string }>;
    skills?: Array<{ path: string; name?: string }>;
    cli?: Array<{ id: string; name: string; kind?: string; description?: string; pathEnv?: boolean; commands?: Array<{ summary?: string; example?: string }> }>;
    extension?: { path: string; tools?: string[] } | null;
  };
  enabled: boolean;
  contentHash: string;
  installedAt: number;
  updatedAt: number;
};

export type PluginMarketSource = {
  id: string;
  name: string;
  type: 'official' | 'registry' | 'directory';
  location: string;
  enabled: boolean;
  builtin?: boolean;
};

export type PluginMarketItem = {
  id: string;
  name: string;
  publisher: string;
  summary: string;
  description: string;
  category: string;
  icon: string;
  iconDataUrl?: string;
  homepage: string;
  repository: string;
  keywords: string[];
  provides: {
    mcp: number;
    skills: number;
    cli: number;
    extension: boolean;
    mcpNames?: string[];
    skillNames?: string[];
    cliNames?: string[];
  };
  versions: Array<{
    version: string;
    packagePath?: string;
    download?: string;
    sha256?: string;
    size?: number;
    publishedAt?: string;
  }>;
  latestVersion: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  installed: boolean;
  installedVersion: string | null;
  installedEnabled: boolean | null;
  updateAvailable: boolean;
};

export type PluginMarketSnapshot = {
  sources: PluginMarketSource[];
  catalogs: Array<{
    source: PluginMarketSource;
    count: number;
    name?: string;
    updatedAt?: string;
    diagnostics?: Array<{ path: string; message: string }>;
    error: string;
    plugins: PluginMarketItem[];
  }>;
  plugins: PluginMarketItem[];
  categories: string[];
  errors: Array<{ sourceId: string; message: string }>;
  query: string;
  category: string;
  sourceId: string;
  updatedAt: number;
};

export type PluginInstallPreview = {
  token: string;
  sourceKind: string;
  source: string;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  category: string;
  icon: string;
  iconDataUrl?: string;
  contentHash: string;
  provides: StudioPluginSummary['provides'];
  existingVersion: string | null;
  upgrade: boolean;
  alreadyInstalled: boolean;
  collisions: Array<{ kind: string; name: string; origin?: string; ownerPluginId?: string }>;
  canInstall: boolean;
};

export interface SettingsSnapshot {
  /** 用户手动添加的模型。 */
  customModels: Array<{ providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels?: ConcreteThinkingLevel[]; enabled?: boolean; origin?: 'configured' | 'override' }>;
  /** 模型来源列表。 */
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; quotaEnabled?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number; mediaModelCount?: number; modelsUrl?: string; enabled: boolean; builtin: boolean }>;
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
    ownerPluginId: string;
    origin: 'plugin' | 'user' | 'builtin';
    managed: boolean;
    userOverride: boolean;
    oauthConnected: boolean;
    connected: boolean;
    toolCount: number;
    error: string;
    stderr: string;
    tools: Array<{ name: string; originalName: string; description: string; exposure: 'direct' | 'deferred' | 'hidden'; enabled: boolean }>;
  }>;
  /** 已安装插件包。 */
  plugins: StudioPluginSummary[];
  /** 已安装技能。 */
  skills: Array<{
    name: string;
    description: string;
    path: string;
    baseDir: string;
    scope: 'user' | 'project';
    origin: 'studio' | 'agents' | 'plugin';
    ownerPluginId?: string;
    managed?: boolean;
    userOverride?: boolean;
    bytes: number;
    version: string;
    promptTokens: number;
    resourceCount: number;
    totalBytes: number;
    fingerprint: string;
    trusted: boolean;
    trustChanged: boolean;
    available: boolean;
    disableModelInvocation: boolean;
    warnings: string[];
  }>;
  skillErrors: Array<{ path: string; message: string }>;
  skillSources: SkillSource[];
  /** 已安装扩展。 */
  extensions: ExtensionHostSnapshot['extensions'];
  officialExtensions: import('./extension-types').OfficialExtensionCatalogItem[];
  extensionErrors: ExtensionHostSnapshot['errors'];
  extensionApiVersion: number;
  extensionRegistryUrl: string;
  /** 当前启用的模型 id。 */
  enabledModels: string[];
  /** Pi Studio 的智能体工具白名单。 */
  agentTools: AgentToolSelection;
  /** 多方案工具配置（主对话/工作区/临时对话）。 */
  toolProfiles: ToolProfilesSnapshot;
  /** 多方案权限策略配置（主对话/工作区/临时对话）。 */
  permissionProfiles: PermissionProfilesSnapshot;
  /** 当前临时对话可用能力快照。 */
  temporaryCapabilities?: TemporaryCapabilitiesSnapshot;
  /** 当前工作区生效的 Harness 配置与全部可切换 profile。 */
  harness: HarnessSettingsSnapshot;
  /** Studio 的 SQLite 数据库与私有资源目录。 */
  storagePath: string;
  runtimeVersions: StudioRuntimeVersions;
  databasePath: string;
  attachmentsPath: string;
  backupsPath: string;
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

/** Refreshed catalog and settings from the same explicit workspace request. */
export interface ModelResourceSnapshot {
  settings: SettingsSnapshot;
  models: ModelCatalog;
}

/** Native menu-bar integration exposed by the main process. */
interface MenuBarSettings {
  available: boolean;
  enabled: boolean;
  platform: string;
}

/**
 * Native window chrome state. Native fullscreen also hides the macOS traffic
 * lights, so the shell stops reserving their gutter.
 */
interface NativeWindowState {
  fullscreen: boolean;
}

type BrowserPreferences = {
  agentControlEnabled: boolean;
  showFullUrl: boolean;
  webLinkOpenTarget: 'workbench' | 'system' | string;
  localLinkOpenTarget: 'workbench' | 'system' | string;
  linkOpenInstructAgent?: boolean;
  linkOpenBlockExternal?: boolean;
  annotatedScreenshots: 'always' | 'never' | string;
  askDownloadPath: boolean;
  downloadDirectory: string;
  historyAccess: 'allow' | 'ask' | 'deny' | string;
  evaluateEnabled: boolean;
  cdpEnabled: boolean;
  externalChromeEnabled: boolean;
  externalChromeEndpoint: string;
  defaultDownloadDirectory?: string;
};

type DesktopAllowApp = {
  id: string;
  name: string;
  bundleId?: string;
  path?: string;
  icon?: string;
  blocked?: boolean;
  running?: boolean;
};

type DesktopActivityEntry = {
  id: string;
  at: number;
  tool: string;
  ok: boolean;
  code?: string;
  appName?: string;
  bundleId?: string;
  windowId?: number | null;
  title?: string;
  detail?: string;
};

type DesktopPermissionStatus = {
  platform: string;
  supported: boolean;
  screenRecording: string;
  accessibility: boolean;
  ready: boolean;
  message?: string;
};

type DesktopControlPreferences = {
  enabled: boolean;
  allowAnyApp: boolean;
  alwaysAllow: DesktopAllowApp[];
};

type DesktopControlStatus = DesktopControlPreferences & {
  alwaysAllowCount: number;
  permission: DesktopPermissionStatus;
  platform: string;
  supported: boolean;
  ready: boolean;
  self?: { name?: string; bundleId?: string; path?: string };
  activity?: DesktopActivityEntry[];
};

declare global {
  interface Window {
    /**
     * 预加载脚本注入的主进程 API。
     * 所有 invoke 方法都是异步的；事件订阅方法返回取消订阅函数。
     */
    piApi: {
      networkSettings(): Promise<NetworkSettings>;
      saveNetworkSettings(settings: NetworkSettings): Promise<NetworkSettings>;
      detectNetworkProxy(settings: NetworkSettings): Promise<NetworkRoute>;
      testNetworkConnection(settings: NetworkSettings): Promise<NetworkTestResult>;
      /** 主进程的平台标识（process.platform），渲染层不再靠 navigator 猜。 */
      readonly platform: 'darwin' | 'win32' | 'linux' | string;
      // ---- 主题、状态与会话 ----
      /** 切换原生窗口、菜单栏与全局组件圆角。 */
      setAppearance(
        theme: 'light' | 'dark' | 'system',
        palette: import('../shared/preferences').PalettePreference,
        radiusStyle: 'square' | 'compact' | 'standard' | 'soft',
      ): Promise<void>;
      /** Read the native window chrome state used by the shell layout. */
      windowState(): Promise<NativeWindowState>;
      deviceStorage(): Promise<DeviceStorageSnapshot>;
      deviceStorageLocation(id: string, action: 'open' | 'copy'): Promise<void>;
      deviceStorageCleanup(): Promise<DeviceStorageCleanupResult>;
      /** Follow native fullscreen changes; returns an unsubscribe function. */
      onWindowState(listener: (state: NativeWindowState) => void): () => void;
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
      /** Mark one completed result as seen after its conversation is actually visible. */
      markMenuBarSessionSeen?(id: string): void;
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
      /** 读取权限策略方案列表及主对话/工作区/临时对话绑定。 */
      permissionProfiles(cwd?: string): Promise<PermissionProfilesSnapshot>;
      /** 创建或保存一个权限策略方案。 */
      savePermissionProfile(payload: {
        cwd?: string;
        mode?: 'create' | 'edit';
        profile: PermissionProfilePatch;
      }): Promise<PermissionProfilesSnapshot>;
      /** 将指定权限方案绑定到主对话全局、当前工作区、继承或临时对话。 */
      selectPermissionProfile(payload: {
        cwd?: string;
        id: string;
        scope: 'global' | 'workspace' | 'inherit' | 'temporary';
      }): Promise<PermissionProfilesSnapshot>;
      /** 将内置权限方案重置为默认值。 */
      resetPermissionProfile(payload: { cwd?: string; id: string }): Promise<PermissionProfilesSnapshot>;
      /** 删除自定义权限方案，引用它的作用域自动回退。 */
      deletePermissionProfile(payload: { cwd?: string; id: string }): Promise<PermissionProfilesSnapshot>;
      /** 用指定权限策略对象直接预览一次工具调用结果（用于方案编辑器）。 */
      permissionEvaluateProfile(payload: {
        cwd?: string;
        policy: PermissionPolicy;
        call: { name: string; arguments?: Record<string, unknown> };
      }): Promise<PermissionEvaluation>;
      /** 扩展请求确认工具操作时触发；需要调用 confirmResponse 回传结果。 */
      onConfirmRequest(listener: (payload: PermissionConfirmRequest) => void): () => void;
      /** 回传确认结果；超时或窗口关闭视为拒绝。 */
      confirmResponse(payload: PermissionConfirmResponse): void;
      /** 读取侧边栏工作区/会话列表、当前模型与工作目录。 */
      waitForStartup(): Promise<void>;
      workspaceReady(): void;
      state(cwd?: string): Promise<{ workspaces: PiWorkspace[]; model: ModelSelection; cwd: string }>;
      /** 当前会话目录的 Git 分支、提交、改动和 worktree 状态。 */
      gitRepositories(cwd: string): Promise<GitRepository[]>;
      gitWorkspaceStatus(cwd?: string, repository?: string): Promise<GitWorkspaceStatus>;
      gitWorkspaceChanges(cwd: string, repository: string): Promise<import('./git-types').GitFile[]>;
      gitWorktree<K extends keyof WorktreeInputs>(cwd: string, input: { kind: K; repository?: string } & WorktreeInputs[K]): Promise<WorktreeResults[K]>;
      gitRead<K extends keyof GitReadResult>(id: string, input: { kind: K; repository?: string } & GitReadParams[K]): Promise<GitReadResult[K]>;
      gitWrite(id: string, input: GitAction & GitHead & { repository?: string }): Promise<void>;
      /** 新建一条 Durable 会话；持久目标由 /goal 在同一会话中按需启用。 */
      createConversation(payload: {
        cwd: string;
        title?: string;
        goal?: string;
      }): Promise<ConversationPage>;
      /** 读取固定大小的历史窗口；around 按稳定 entry ID 直接返回目标前后的一窗。 */
      conversationPage(payload: {
        id: string;
        limit?: number;
        turnLimit?: number;
        cursor?: ConversationPageCursor;
        before?: ConversationPosition;
        after?: ConversationPosition;
        /** 直接读取目标附近；指定 turnLimit 时保留目标所在的完整轮次。 */
        around?: number;
      }): Promise<ConversationPage | undefined>;
      /** 获取完整提问大纲；仅用于导航，不参与消息窗口渲染。 */
      conversationOutline(id: string): Promise<ConversationOutline | undefined>;
      /** 搜索整段会话内容（含尚未加载进窗口的历史），返回条目 id 与片段。 */
      conversationSearch(payload: {
        id: string;
        query: string;
        limit?: number;
      }): Promise<ConversationSearchResult | undefined>;
      /** Full request snapshot; the page only carries summaries. */
      conversationRequestTrace(id: string, requestId: string): Promise<RequestTrace | undefined>;
      /** 获取会话当前运行、压缩和任务快照。 */
      conversationTodoHistory(options: { id: string; cursor?: number; limit?: number }): Promise<import('./chat-types').TodoHistoryPage>;
      conversationTodo(id: string): Promise<import('./chat-types').TodoDetails | undefined>;
      conversationSnapshot(id: string): Promise<ConversationSnapshot | undefined>;
      /** 订阅一条会话；返回与事件流同一一致性边界的初始快照。 */
      subscribeConversation(id: string): Promise<ConversationSnapshot>;
      unsubscribeConversation(id: string): Promise<{ ok: boolean }>;
      /** 提交输入。繁忙策略直接映射 Durable 的 steer / followUp / reject。 */
      conversationSubmit(payload: ConversationSubmitInput): Promise<ConversationSubmitResult>;
      /** 原位编辑一条用户消息，并重新生成该分支。 */
      conversationEdit(payload: ConversationEditInput): Promise<ConversationEditResult>;
      /** 热切换模型与 thinking；繁忙时只影响下一请求。 */
      conversationConfigure(payload: {
        id: string;
        modelRef?: string;
        thinkingLevel?: ThinkingLevel;
      }): Promise<ModelSelection>;
      conversationInterrupt(id: string): Promise<{ ok: boolean }>;
      /** 手动压缩上下文：空闲时立即应用，运行中在下一个边界应用，不中断当前回合。 */
      conversationCompact(payload: { id: string; instructions?: string }): Promise<{ ok: boolean; taskId: string }>;
      conversationAction(payload: {
        kind: 'workspace' | 'session';
        id: string;
        action:
          | 'rename'
          | 'remove'
          | 'pin'
          | 'archive'
          | 'fork'
          | 'remove-archived'
          | 'long-task-set'
          | 'long-task-edit'
          | 'long-task-complete'
          | 'long-task-clear'
          | 'long-task-pause'
          | 'long-task-resume';
        name?: string;
        sessionIds?: string[];
        entryId?: string;
        goal?: string;
        completionCriteria?: string;
        summary?: string;
      }): Promise<ConversationSummary | {
        ok: boolean;
        longTask?: LongTaskState;
        wasRunning?: boolean;
        started?: boolean;
        deletedSessionIds?: string[];
        pendingFileCleanups?: number;
      }>;
      conversationTaskGraph(id: string): Promise<ConversationTaskGraph>;
      /** 读取当前会话的子智能体总览，包含已完成记录与实时快照。 */
      sessionSubagents(id: string): Promise<SubagentChild[]>;
      /** 读取一个受信任子智能体 session 的只读 transcript。 */
      subagentTranscript(payload: { sessionId: string; childKey: string; limit?: number; cursor?: string }): Promise<SubagentTranscript>;
      /** 永久删除当前父会话中的一个子智能体及其独立上下文。 */
      deleteSubagent(payload: { sessionId: string; childKey: string }): Promise<{ ok: boolean; name: string; deletedConversations: number; pendingFileCleanups?: number }>;
      replySubagentSupervisor(payload: { sessionId: string; childKey: string; requestId: string; message: string }): Promise<{ ok: boolean; requestId: string; childKey: string; reporterTaskId: string }>;
      // ---- 聊天发送 ----
      // ---- 文件浏览 ----
      /** 列出工作区某目录下的条目。 */
      files(cwd: string, path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }> }>;
      /** 读取单个文件文本；binary 为 true 时 text 不可直接展示。 */
      file(cwd: string, path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      /** 读取有大小上限、可直接交给统一预览组件的数据。 */
      filePreview(cwd: string, path: string): Promise<FilePreviewResult>;
      onFilesChanged(listener: (keys: string[]) => void): () => void;
      onWorkbenchRefresh?(listener: (event: {
        scope: 'all' | 'extensions' | 'files' | 'git' | 'sessions';
        extensionId?: string;
        sourceId?: string;
      }) => void): () => void;
      writeFile(payload: { cwd: string; path: string; text: string; expectedText: string }): Promise<{ ok: boolean; path: string; size: number }>;
      /** 只读打开当前会话已记录的轮次变更文件。 */
      temporaryModel(payload?: { modelRef?: string; thinkingLevel?: import('./model-types').ThinkingLevel }): Promise<import('./model-types').ModelSelection>;
      temporaryPrompt(payload: { id: string; text: string; images: { data: string; mimeType: string }[]; modelRef: string; thinkingLevel: string }): Promise<{ ok: boolean }>;
      temporaryStop(id: string): Promise<void>;
      temporaryClose(id: string): Promise<void>;
      onTemporary(listener: (event:
        | { id: string; type: 'message' | 'done'; message?: ChatMessage }
        | { id: string; type: 'error'; message: string }
      ) => void): () => void;
      undoTurnDiff(payload: { sessionId: string; at: number }): Promise<void>;
      turnDiffFile(payload: { sessionId: string; at: number; path: string; full?: boolean; ignoreWhitespace?: boolean }): Promise<import('./chat-types').TurnDiffFile>;
      turnFilePreview(payload: { sessionId: string; at: number; path: string; side: 'before' | 'after' }): Promise<import('./file-preview-types').FilePreviewResult>;
      turnDiffAbsoluteFile(payload: { sessionId: string; path: string }): Promise<{ path: string; size: number; binary: boolean; text: string; changeKey: string }>;
      /** 打开聊天里出现的任意文件引用：`~`、相对路径与工作区外绝对路径都由主进程解析。 */
      filePreviewAbsolute(payload: { path: string; cwd?: string; sessionId?: string }): Promise<FilePreviewResult>;
      /** 只读打开 Studio 自己管理的附件文件；主进程会拒绝附件目录之外的路径。 */
      attachmentFile(payload: { path: string }): Promise<{ path: string; size: number; binary: boolean; text: string }>;
      /** 查询系统里可用来打开该文件的应用。 */
      fileActions(payload: { cwd?: string; path: string; source?: 'workspace' | 'attachment' | 'diff' | 'external'; sessionId?: string }): Promise<{ apps: Array<{ name: string; path: string; icon?: string }> }>;
      /** 用指定应用（或系统默认应用）打开文件。 */
      openWith(payload: { cwd?: string; path: string; appPath?: string; source?: 'workspace' | 'attachment' | 'diff' | 'external'; sessionId?: string }): Promise<{ ok: boolean }>;
      /** 在 Finder 中定位文件。 */
      revealFile(payload: { cwd?: string; path: string; source?: 'workspace' | 'attachment' | 'diff' | 'external'; sessionId?: string }): Promise<{ ok: boolean }>;
      /** 用系统浏览器打开任意 http(s) 链接。 */
      openExternal(url: string): Promise<{ ok: boolean }>;
      /** 按偏好打开链接：external 走系统浏览器，window 走应用内子窗口。 */
      openLink(url: string, mode: 'external' | 'window'): Promise<{ ok: boolean }>;
      /** 内嵌浏览器下载列表与目录。 */
      browserDownloads(): Promise<{
        downloads: Array<{
          id: string;
          url: string;
          filename: string;
          path: string;
          state: string;
          receivedBytes: number;
          totalBytes: number;
          mimeType: string;
          risky: boolean;
          error: string;
          startedAt: number;
          endedAt: number | null;
        }>;
        directory: string;
      }>;
      browserDownloadCancel(id: string): Promise<{ ok: boolean; error?: string; download?: unknown }>;
      browserDownloadClear(id?: string): Promise<{ ok: boolean; error?: string; downloads?: unknown }>;
      browserDownloadReveal(id: string): Promise<{ ok: boolean }>;
      browserDownloadOpen(id: string): Promise<{ ok: boolean }>;
      browserDownloadsFolder(): Promise<{ ok: boolean; path?: string }>;
      /** 清除内嵌浏览器 Cookie、缓存与站点存储（不删下载文件）。 */
      browserClearData(): Promise<{ ok: boolean }>;
      browserTabs(): Promise<{ tabs: Array<{
        id: string;
        url: string;
        title: string;
        active: boolean;
        loading: boolean;
        webContentsId: number | null;
      }> }>;
      browserTabRegister(payload: {
        id?: string;
        webContentsId: number;
        url?: string;
        title?: string;
        loading?: boolean;
        active?: boolean;
      }): Promise<{ ok: boolean; tab?: unknown }>;
      browserTabUpdate(payload: {
        id: string;
        url?: string;
        title?: string;
        loading?: boolean;
        active?: boolean;
      }): Promise<{ ok: boolean; tab?: unknown }>;
      browserTabUnregister(id: string): Promise<{ ok: boolean }>;
      browserTabActivate(id: string): Promise<{ ok: boolean; tab?: unknown }>;
      browserCommandAck(payload: {
        requestId: string;
        tabId?: string;
        tab?: {
          id?: string;
          webContentsId?: number;
          url?: string;
          title?: string;
          loading?: boolean;
        };
        error?: string;
      }): Promise<{ ok: boolean; tab?: unknown }>;
      browserControlState(): Promise<{
        paused: boolean;
        pausedTabs: string[];
        activity?: { active: boolean; tabId?: string; action?: string; label?: string; startedAt?: number };
      }>;
      browserControlPause(payload: { paused?: boolean; tabId?: string }): Promise<{
        paused: boolean;
        pausedTabs: string[];
        activity?: { active: boolean; tabId?: string; action?: string; label?: string; startedAt?: number };
      }>;
      browserSitePolicies(): Promise<{ policies: Array<{
        id: string;
        originPattern: string;
        actionClass: string;
        decision: string;
        note?: string;
        updatedAt?: number;
      }> }>;
      browserSitePolicyUpsert(payload: {
        originPattern: string;
        actionClass: string;
        decision: 'allow' | 'ask' | 'deny' | string;
        note?: string;
      }): Promise<{ policies: unknown }>;
      browserSitePolicyRemove(payload: {
        id?: string;
        originPattern?: string;
        actionClass?: string;
      }): Promise<{ policies: unknown }>;
      browserSitePolicyResolve(payload: {
        url?: string;
        actionClass?: string;
      }): Promise<{ decision: string; source?: string; origin?: string }>;
      browserAdvancedSettings(): Promise<BrowserPreferences>;
      browserSetEvaluateEnabled(payload: { enabled?: boolean }): Promise<BrowserPreferences & { evaluateEnabled: boolean }>;
      browserSetPreferences(payload: Partial<BrowserPreferences>): Promise<{ ok: boolean; preferences: BrowserPreferences } & BrowserPreferences>;
      browserPickDownloadDirectory(): Promise<{ ok: boolean; cancelled?: boolean; path?: string; preferences?: BrowserPreferences }>;
      browserExternalTargets(): Promise<{
        ok: boolean;
        endpoint?: string;
        browser?: string;
        targets?: Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }>;
        attached?: Array<{ sessionId: string; targetId: string; title: string; url: string }>;
        warning?: string;
      }>;
      browserExternalAttach(payload: { targetId: string }): Promise<{ ok: boolean; session?: unknown; warning?: string }>;
      browserExternalDetach(payload?: { sessionId?: string }): Promise<{ ok: boolean; sessionId?: string; detached?: string; error?: string }>;
      browserExternalSessions(): Promise<{ sessions: Array<{ sessionId: string; targetId: string; title: string; url: string; attachedAt?: number }> }>;
      browserPasswords(): Promise<{ ok: boolean; available?: boolean; passwords: Array<{ id: string; origin: string; username: string; note?: string; updatedAt?: number }> }>;
      browserPasswordUpsert(payload: { id?: string; origin: string; username: string; password?: string; note?: string }): Promise<{ ok: boolean; passwords?: unknown }>;
      browserPasswordRemove(payload: { id: string }): Promise<{ ok: boolean; passwords?: unknown }>;
      browserPasswordReveal(payload: { id: string }): Promise<{ ok: boolean; password?: { id: string; origin: string; username: string; password: string } }>;
      browserContacts(): Promise<{ ok: boolean; contacts: Array<{ id: string; name: string; phone?: string; email?: string; address?: string; updatedAt?: number }> }>;
      browserContactUpsert(payload: { id?: string; name: string; phone?: string; email?: string; address?: string }): Promise<{ ok: boolean; contacts?: unknown }>;
      browserContactRemove(payload: { id: string }): Promise<{ ok: boolean; contacts?: unknown }>;
      browserExtensions(): Promise<{ ok: boolean; supported?: boolean; extensions: Array<{ id: string; name: string; version?: string; path?: string; enabled?: boolean; loaded?: boolean }> }>;
      browserExtensionLoad(payload?: { path?: string }): Promise<{ ok: boolean; cancelled?: boolean; extensions?: unknown }>;
      browserExtensionRemove(payload: { id?: string; path?: string }): Promise<{ ok: boolean; extensions?: unknown }>;
      desktopControlStatus(): Promise<DesktopControlStatus>;
      desktopControlPreferences(): Promise<DesktopControlPreferences>;
      desktopControlSetPreferences(payload: Partial<DesktopControlPreferences>): Promise<{ ok: boolean; preferences: DesktopControlPreferences; status?: DesktopControlStatus }>;
      desktopControlPermissions(): Promise<DesktopPermissionStatus>;
      desktopControlOpenPermissionSettings(payload?: { kind?: 'screen' | 'accessibility' | string } | string): Promise<{ ok: boolean; kind?: string; url?: string }>;
      desktopControlInstalledApps(): Promise<{ ok: boolean; apps: DesktopAllowApp[]; error?: string; code?: string }>;
      desktopControlAlwaysAllowAdd(payload: Partial<DesktopAllowApp>): Promise<{ ok: boolean; preferences: DesktopControlPreferences; status?: DesktopControlStatus }>;
      desktopControlAlwaysAllowRemove(payload: { id?: string } | string): Promise<{ ok: boolean; preferences: DesktopControlPreferences; status?: DesktopControlStatus }>;
      desktopControlActivity(payload?: { limit?: number } | number): Promise<{ ok: boolean; activity: DesktopActivityEntry[] }>;
      desktopControlActivityClear(): Promise<{ ok: boolean; activity: DesktopActivityEntry[]; status?: DesktopControlStatus }>;
      onBrowserEvent(listener: (event: {
        type: string;
        preferences?: BrowserPreferences;
        sessions?: Array<{ sessionId: string; targetId: string; title: string; url: string; attachedAt?: number }>;
        paused?: boolean;
        pausedTabs?: string[];
        active?: boolean;
        tabId?: string;
        action?: string;
        label?: string;
        startedAt?: number;
        activity?: { active: boolean; tabId?: string; action?: string; label?: string; startedAt?: number };
        reason?: string;
        download?: {
          id: string;
          url: string;
          filename: string;
          path: string;
          state: string;
          receivedBytes: number;
          totalBytes: number;
          mimeType: string;
          risky: boolean;
          error: string;
          startedAt: number;
          endedAt: number | null;
        };
        tab?: unknown;
        tabs?: unknown;
      }) => void): () => void;
      onBrowserCommand(listener: (command: {
        type: 'open' | 'focus' | 'reveal' | 'close-tab' | 'viewport' | string;
        requestId?: string;
        url?: string;
        tabId?: string;
        newTab?: boolean;
        viewport?: { width: number; height: number; label?: string } | null;
      }) => void): () => void;
      /** 创建或重新连接当前窗口独占的 PTY 会话。 */
      terminalCreate(payload: {
        id: string;
        cwd: string;
        cols: number;
        rows: number;
        /** 是否注入 OSC 133 shell 集成钩子（目前仅 zsh）。 */
        shellIntegration?: boolean;
      }): Promise<TerminalSessionSnapshot>;
      /** 单向写入 PTY，不阻塞按键路径。 */
      terminalWrite(id: string, data: string): void;
      /** 单向同步几何，失败时主进程静默丢弃。 */
      terminalResize(id: string, cols: number, rows: number): void;
      terminalClose(id: string): Promise<{ ok: boolean }>;
      /** 拖放文件的真实路径；非 Electron 环境返回空串。 */
      filePathOf(file: File): string;
      onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
      /** 扫描 TCP 监听端口，并按当前任务/工作区标记归属依据。 */
      runtimeServices(payload: { cwd?: string; roots?: string[] }): Promise<RuntimeServiceSnapshot>;
      /** 终止已经通过主进程身份与操作系统用户校验的服务。 */
      runtimeServiceStop(payload: {
        pid: number;
        port: number;
        startedAt: number;
      }): Promise<RuntimeServiceStopResult>;

      // ---- 输入框辅助 ----
      /** 读取斜杠命令、提示词、技能等输入资源。 */
      composerResources(payload: { sessionId?: string; cwd?: string; includeCapabilities?: boolean }): Promise<{
        commands: ComposerCommand[];
        skills: ComposerCommand[];
        capabilities?: ComposerCapability[];
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
      /** 把受支持的内联图片 data URI 写入系统剪贴板。 */
      copyImage(payload: { src: string }): Promise<{ ok: boolean }>;
      /** 把消息正文与内联图片一起写入剪贴板：text 给纯文本输入框，html 保留图片。 */
      copyRichText(payload: { text: string; html: string }): Promise<{ ok: boolean }>;
      /** 打开系统目录选择器，返回所选工作区路径。 */
      chooseWorkspace(): Promise<string | undefined>;

      // ---- 模型 ----
      /** 读取模型目录、启用列表与当前选择。 */
      models(cwd?: string): Promise<ModelCatalog>;
      /** 当前模型的上下文窗口与自动压缩阈值（只读）。 */
      contextPolicy(payload?: { modelRef?: string }): Promise<{ modelRef: string; contextWindow: number; autoCompactPercent: number; compactAtTokens: number | null }>;
      /** Read aggregate token usage from Studio SQLite for the last N local days. */
      usageSummary(payload?: UsageProjectScope & { days?: number }): Promise<UsageAnalyticsSnapshot>;
      /** Read the model mix for an explicit window: every stored day, a N-day window, or an inclusive local-day range. */
      usageModels(payload?: UsageProjectScope & { all?: boolean; days?: number; sinceDay?: string; untilDay?: string }): Promise<UsageModelMix>;
      /** 读取某来源下可选模型及启用状态。 */
      providerModels(providerId: string): Promise<{ models: Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; thinkingLevels?: ConcreteThinkingLevel[]; origin: 'builtin' | 'configured' | 'override'; deletable: boolean }> }>;
      /** 从来源的 /models 接口读取模型，不保存到 Pi 配置。 */
      discoverProviderModels(providerId: string): Promise<{ endpoint: string; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels: ConcreteThinkingLevel[] }> }>;
      /** 把发现的模型合并到来源，已有模型保持不变。 */
      importProviderModels(payload: { providerId: string; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; thinkingLevels?: ConcreteThinkingLevel[] }>; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** 读取来源的 baseUrl、API 类型与图标。 */
      providerQuota(providerId: string, refresh?: boolean): Promise<ProviderQuotaSnapshot>;
      onProviderQuotaInvalidated(listener: (providerId: string) => void): () => void;
      providerQuotaFields(input: Pick<ProviderQuotaConfig, 'endpoint' | 'auth' | 'authName' | 'headers'> & { providerId: string; apiKey?: string }): Promise<QuotaFieldSuggestion[]>;
      previewQuotaMapping(input: QuotaPreviewInput): Promise<QuotaMetric[]>;
      providerConfig(providerId: string): Promise<{ providerId: string; name: string; baseUrl: string; api: string; icon: string; modelsUrl: string; mediaModels?: { speech: string[]; image: string[] }; quota: ProviderQuotaConfig | null; builtin: boolean; enabled: boolean }>;
      /** 切换模型，返回新的选择快照。 */
      setModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      /** 设置 Studio 新对话的默认模型。 */
      setDefaultModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      /** 切换推理等级，返回新的选择快照。 */
      setThinkingLevel(payload: { modelRef: string; level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      /** 设置 Studio 新对话的默认推理等级。 */
      setDefaultThinkingLevel(payload: { level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      /** 设置启用的模型 id 列表。 */
      setEnabledModels(payload: { models: string[]; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** 添加或编辑自定义模型，成功后返回最新设置快照。 */
      addCustomModel(payload: { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; thinkingLevels?: ConcreteThinkingLevel[]; editing?: boolean; origin?: 'builtin' | 'configured' | 'override'; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** 删除自定义模型。 */
      removeCustomModel(payload: { providerId: string; modelId: string; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;

      // ---- 设置：MCP / 技能 / 扩展 / 包 ----
      /** 读取完整设置快照。 */
      settings(cwd?: string): Promise<SettingsSnapshot>;
      /** 读取扩展的全局显示顺序。 */
      conversationExtensionUiPreferences(): Promise<ConversationExtensionUiPreferences>;
      /** 保存扩展的全局显示顺序。 */
      saveConversationExtensionUiPreferences(payload: { globalOrder: string[] }): Promise<ConversationExtensionUiPreferences>;
      /** 扫描当前工作区可用的核心、扩展包与本地扩展工具。 */
      agentToolCatalog(payload?: { cwd?: string; refresh?: boolean }): Promise<AgentToolCatalog>;
      /** 保存智能体工具白名单与来源快照。 */
      setAgentTools(payload: { tools: AgentToolSelection; cwd?: string }): Promise<SettingsSnapshot>;
      /** 读取工具方案列表及主对话/工作区/临时对话绑定。 */
      toolProfiles(cwd?: string): Promise<ToolProfilesSnapshot>;
      /** 创建或保存一个工具方案，并返回更新后的临时对话可用能力。 */
      saveToolProfile(payload: {
        cwd?: string;
        mode?: 'create' | 'edit';
        profile: AgentToolProfilePatch;
      }): Promise<{
        toolProfiles: ToolProfilesSnapshot;
        temporaryCapabilities: TemporaryCapabilitiesSnapshot;
        runtimeRefresh?: RuntimeRefreshSnapshot;
      }>;
      /** 将工具方案绑定到主对话全局、当前工作区、继承或临时对话。 */
      selectToolProfile(payload: {
        cwd?: string;
        id: string;
        scope: 'global' | 'workspace' | 'inherit' | 'temporary';
      }): Promise<{
        toolProfiles: ToolProfilesSnapshot;
        temporaryCapabilities: TemporaryCapabilitiesSnapshot;
        runtimeRefresh?: RuntimeRefreshSnapshot;
      }>;
      /** 重置内置工具方案并同步临时对话能力快照。 */
      resetToolProfile(payload: { cwd?: string; id: string }): Promise<{
        toolProfiles: ToolProfilesSnapshot;
        temporaryCapabilities: TemporaryCapabilitiesSnapshot;
        runtimeRefresh?: RuntimeRefreshSnapshot;
      }>;
      /** 删除自定义工具方案。 */
      deleteToolProfile(payload: { cwd?: string; id: string }): Promise<{
        toolProfiles: ToolProfilesSnapshot;
        temporaryCapabilities: TemporaryCapabilitiesSnapshot;
        runtimeRefresh?: RuntimeRefreshSnapshot;
      }>;
      /** 读取当前临时对话实际可调用的内置工具、扩展工具与 MCP 服务。 */
      temporaryCapabilities(): Promise<TemporaryCapabilitiesSnapshot>;
      /** 读取 Harness 配置 profile、section 定义与当前工作区选择。 */
      harnessSettings(cwd?: string): Promise<HarnessSettingsSnapshot>;
      /** 保存当前 profile；变更在下一请求生效。 */
      saveHarnessProfile(payload: {
        cwd?: string;
        mode?: 'create' | 'edit';
        profile: HarnessProfileDraft;
      }): Promise<HarnessSettingsSnapshot>;
      /** 为全局默认、当前工作区或临时对话选择 profile。 */
      selectHarnessProfile(payload: {
        cwd?: string;
        id: string;
        scope: 'global' | 'workspace' | 'inherit' | 'temporary';
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
      /** 读取 Studio 子智能体的模型、thinking 与工具权限。 */
      subagentSettings(cwd?: string): Promise<SubagentSettingsSnapshot>;
      subagentProfiles(): Promise<SubagentProfile[]>;
      subagentProfileResources(cwd: string): Promise<SubagentProfileResources>;
      saveSubagentProfile(profile: SubagentProfile): Promise<SubagentProfile[]>;
      removeSubagentProfile(payload: Pick<SubagentProfile, 'id' | 'revision'>): Promise<SubagentProfile[]>;
      subagentBudget(payload: { id: string; cwd?: string }): Promise<SubagentBudgetSnapshot>;
      /** 保存一个范围的模型、thinking 与子智能体工具白名单。 */
      saveSubagentSettings(payload: { cwd: string; scope: 'user' | 'project'; settings: SubagentConfig }): Promise<SubagentSettingsSnapshot>;
      managedWorktrees(payload?: { cwd?: string; includeTerminal?: boolean }): Promise<ManagedWorktree[]>;
      managedWorktree(id: string): Promise<ManagedWorktree & { patch: string }>;
      applyManagedWorktree(id: string): Promise<{ ok: boolean; changedFiles: number; removed?: boolean; cleanupError?: string }>;
      discardManagedWorktree(payload: { id: string; force?: boolean }): Promise<{ ok: boolean; alreadyTerminal?: boolean }>;
      cleanupManagedWorktrees(): Promise<{ removed: number; failures: string[] }>;
      revealManagedWorktree(id: string): Promise<{ ok: boolean }>;
      /** 保存某来源的 API Key。 */
      setKey(payload: { providerId: string; apiKey: string; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** 保存来源配置（baseUrl、API 类型、首个模型、可选 API Key）。 */
      addProvider(payload: { providerId: string; name: string; baseUrl: string; api: string; apiKey?: string; icon?: string; modelsUrl?: string; mediaModels?: { speech: string[]; image: string[] }; quota?: ProviderQuotaConfig | null; editing?: boolean; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** Retry runtime/catalog refresh without writing provider metadata or credentials. */
      refreshModels(cwd?: string): Promise<ModelResourceSnapshot>;
      /** 启用或停用一个模型来源；停用后其模型不会进入新的模型目录。 */
      setProviderEnabled(payload: { providerId: string; enabled: boolean; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** 永久删除来源连接、模型配置和已保存凭据。 */
      removeProvider(payload: { providerId: string; cwd?: string }): Promise<CommittedProjection<ModelResourceSnapshot>>;
      /** Renderer-visible names only; secret values never cross IPC. */
      listSecrets(): Promise<Array<{ name: string; updatedAt: number }>>;
      /** Store or replace one safeStorage-encrypted test credential. */
      setSecret(payload: { name: string; value: string }): Promise<{ name: string; updatedAt: number }>;
      removeSecret(name: string): Promise<{ ok: boolean }>;
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
      testMcp(input: Record<string, unknown>): Promise<McpConnectionTestResult>;
      testSavedMcp(name: string): Promise<McpConnectionTestResult>;
      startMcpOAuth(name: string, cwd?: string): Promise<CommittedProjection<SettingsSnapshot>>;
      logoutMcpOAuth(name: string, cwd?: string): Promise<CommittedProjection<SettingsSnapshot>>;
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
      }): Promise<CommittedProjection<SettingsSnapshot>>;
      /** 启用/停用 MCP 服务器。 */
      setMcpEnabled(payload: { name: string; enabled: boolean; cwd?: string }): Promise<CommittedProjection<SettingsSnapshot>>;
      setMcpMethodEnabled(payload: { server: string; method: string; enabled: boolean; cwd?: string }): Promise<CommittedProjection<SettingsSnapshot>>;
      /** 只重建 MCP 运行时并读取状态，不重复保存或删除配置。 */
      refreshMcp(cwd?: string): Promise<SettingsSnapshot>;
      /** 删除 MCP 服务器。 */
      removeMcp(name: string, cwd?: string): Promise<CommittedProjection<SettingsSnapshot>>;
      /** 添加技能（scope 决定用户级还是工作区级）。 */
      addSkill(payload: { scope: 'user' | 'project'; cwd?: string }): Promise<CommittedProjection<SettingsSnapshot> | undefined>;
      refreshSkills(cwd?: string): Promise<SettingsSnapshot>;
      pickWorktreeParent(): Promise<string | undefined>;
      pickSkillSourceDirectory(): Promise<string | undefined>;
      pickSkillRegistryFile(): Promise<string | undefined>;
      skillHub(payload?: { refresh?: boolean }): Promise<SkillHubSnapshot>;
      addSkillSource(payload: {
        id?: string;
        name?: string;
        type: 'directory' | 'registry' | 'github';
        location: string;
        enabled?: boolean;
      }): Promise<SkillSource>;
      setSkillSourceEnabled(payload: { id: string; enabled: boolean }): Promise<SkillSource>;
      removeSkillSource(id: string): Promise<{ ok: boolean }>;
      prepareSkillInstall(payload: {
        sourceId: string;
        listingId: string;
        scope: 'user' | 'shared' | 'project';
        cwd?: string;
      }): Promise<SkillInstallPreview>;
      installPreparedSkill(payload: { token: string; cwd?: string }): Promise<{
        committed: true;
        installed: {
          name: string;
          version: string;
          scope: 'user' | 'shared' | 'project';
          path: string;
          baseDir: string;
        };
        projection: MutationProjection<SettingsSnapshot>;
      }>;
      disposePreparedSkill(token: string): Promise<{ ok: boolean }>;
      /** 删除技能目录。 */
      removeSkill(path: string, cwd?: string): Promise<CommittedProjection<SettingsSnapshot>>;
      /** 信任或撤销当前工作区中的项目技能。 */
      setSkillTrusted(payload: { path: string; trusted: boolean; cwd?: string }): Promise<CommittedProjection<SettingsSnapshot>>;
      /** 添加扩展。 */
      addExtension(payload: { scope: string; cwd?: string }): Promise<any>;
      pickPluginSource(kind: 'directory' | 'package'): Promise<string | undefined>;
      preparePluginInstall(payload: { source: string }): Promise<PluginInstallPreview>;
      installPlugin(payload: { token: string; cwd?: string }): Promise<{ plugin: StudioPluginSummary; installed: { mcp: string[]; skills: Array<{ name: string; path: string }>; extension: string[]; cli: string[] }; settings: SettingsSnapshot }>;
      disposePluginInstall(token: string): Promise<{ ok: boolean }>;
      uninstallPlugin(payload: { id: string; cwd?: string; keepOverrides?: boolean }): Promise<{ id: string; removed: unknown; settings: SettingsSnapshot }>;
      setPluginEnabled(payload: { id: string; enabled: boolean; cwd?: string }): Promise<{ plugin: StudioPluginSummary; settings: SettingsSnapshot }>;
      listPlugins(): Promise<StudioPluginSummary[]>;
      pluginMarket(payload?: { query?: string; category?: string; sourceId?: string }): Promise<PluginMarketSnapshot>;
      pluginSources(): Promise<PluginMarketSource[]>;
      addPluginSource(payload: { name?: string; type: 'registry' | 'directory'; location: string }): Promise<PluginMarketSource>;
      setPluginSourceEnabled(payload: { id: string; enabled: boolean }): Promise<PluginMarketSource>;
      removePluginSource(id: string): Promise<{ ok: boolean; id: string }>;
      prepareMarketPlugin(payload: { id: string; version?: string; sourceId?: string }): Promise<PluginInstallPreview>;
      pickPluginRegistryFile(): Promise<string | undefined>;
      pickPluginSourceDirectory(): Promise<string | undefined>;

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
      officialExtensions(payload?: { cwd?: string }): Promise<import('./extension-types').OfficialExtensionCatalogSnapshot>;
      /** Prepare an official extension through the same quarantine and integrity pipeline as user extensions. */
      prepareOfficialExtension(id: string): Promise<ExtensionInstallPreview>;
      /** Persist whether a non-expanding official update may be applied automatically. */
      setOfficialExtensionAutoUpdate(payload: {
        id: string;
        enabled: boolean;
      }): Promise<import('./extension-types').OfficialExtensionCatalogItem>;
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
      }): Promise<ExtensionInstallResult>;
      /** Continue only the unfinished post-install phases owned by this window. */
      refreshExtensionInstall(token: string): Promise<ExtensionInstallResult>;
      disposeExtensionInstallRecovery(token: string): Promise<void>;
      /** 丢弃未提交的安装预览与 quarantine 文件。 */
      disposeExtensionInstall(token: string): Promise<void>;
      /** 切换到一个已保留的历史版本，无需重新下载。 */
      rollbackExtension(payload: { id: string; scope: ExtensionInstallScope; cwd?: string }): Promise<ExtensionMutationResult>;
      refreshExtensionMutation(token: string): Promise<ExtensionMutationResult>;
      disposeExtensionMutationRecovery(token: string): Promise<void>;
      extensionPublisherTrust(): Promise<import('./extension-types').ExtensionPublisherTrustSnapshot>;
      revokeExtensionPublisherKey(payload: {
        publisher: string;
        keyId: string;
      }): Promise<import('./extension-types').ExtensionPublisherTrustSnapshot>;
      /** 保存 registry 地址；仅接受 HTTPS 与本机回环 HTTP。 */
      setExtensionRegistryUrl(url: string): Promise<{ extensionRegistryUrl: string }>;
      /** 删除扩展。 */
      removeExtension(payload: { id: string; cwd?: string }): Promise<ExtensionMutationResult>;
      /** 读取扩展宿主与声明式 UI contribution 快照。 */
      extensionsSnapshot(cwd?: string): Promise<ExtensionHostSnapshot>;
      /** 重新扫描并热加载用户、项目与 MCP 扩展。 */
      reloadExtensions(cwd?: string): Promise<{ status: string; refreshedAt: number; studio: ExtensionHostSnapshot }>;
      /** 启用或停用一个扩展；下一请求生效。 */
      setExtensionEnabled(payload: { id: string; enabled: boolean; cwd?: string }): Promise<ExtensionMutationResult>;
      /** 信任或撤销一个项目扩展。 */
      setExtensionTrusted(payload: { id: string; trusted: boolean; cwd?: string }): Promise<ExtensionMutationResult>;
      /** 读取 JSON-safe 的声明式 UI contribution 快照。 */
      extensionsUi(cwd?: string): Promise<ExtensionUiSnapshot>;
      /** 打开一个有引用计数和生命周期清理保证的实时扩展数据视图。 */
      openExtensionDataView(payload: ExtensionDataViewOpenRequest): Promise<ExtensionDataViewOpenResult>;
      /** 关闭当前窗口持有的实时扩展数据视图。 */
      closeExtensionDataView(subscriptionId: string): Promise<{ closed: boolean }>;
      /** 扩展实时数据更新；调用方按 subscriptionId 或 sourceId 过滤。 */
      onExtensionDataView(listener: (event: ExtensionDataViewEvent) => void): () => void;
      /** 通用插件视图 RPC 调用；输入和输出都必须可序列化为 JSON。 */
      invokeExtensionView(payload: {
        subscriptionId: string;
        method: string;
        params?: unknown;
      }): Promise<unknown>;
      onExtensionPanelRequested(listener: (event: { sessionId: string; panelId: string }) => void): () => void;
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
