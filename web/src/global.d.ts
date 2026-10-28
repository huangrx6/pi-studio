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
import type { FooterView, FooterAction, FooterCell } from './components/ExtensionFooter';
import type { ChatAttachment, ChatMessage, ComposerAttachment, ComposerCommand, ComposerFile, TurnDiff, UploadedAttachment } from './chat-types';
import type { ModelCatalog, ModelSelection, ThinkingLevel } from './model-types';

/** 扩展 widget：字符串数组或 pi-tui 组件统一渲染成字符单元。 */
interface ExtensionWidget {
  key: string;
  placement: 'aboveEditor' | 'belowEditor';
  lines: FooterCell[][];
}

/** 扩展 custom() 浮层：终端卡片被整理成原生面板。 */
interface ExtensionCustomPanel {
  id: string;
  overlay: boolean;
  interactive: boolean;
  lines: FooterCell[][];
  rowTypes?: Array<'text' | 'rule'>;
  title?: string;
  close?: { row: number; col: number } | null;
  offset?: { row: number; col: number } | null;
  width?: number | string;
  maxHeight?: number | string;
  contentWidth?: number;
}

/** 扩展 input()/editor() 请求。 */
interface ExtensionDialogRequest {
  id: string;
  kind: 'input' | 'editor';
  title: string;
  placeholder?: string;
  prefill?: string;
}

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
}

/** 一个工作区及其会话列表。 */
interface PiWorkspace {
  /** 工作区绝对路径。 */
  cwd: string;
  /** 文件夹名（展示用）。 */
  name: string;
  /** 该工作区下的会话。 */
  sessions: PiSessionSummary[];
}

/** 打开会话时返回的完整详情。 */
interface PiDetail {
  /** 会话 id。 */
  id: string;
  /** 会话所属工作区路径。 */
  cwd: string;
  /** 会话标题。 */
  title: string;
  /** 完整消息历史（含 toolResult）。 */
  messages: ChatMessage[];
  /** 已持久化的每轮 Git 变更（按轮次结束时间配对）。 */
  turnDiffs?: TurnDiff[];
}

/** 设置面板一次性读取的快照，覆盖模型、来源、MCP、技能、扩展等配置。 */
interface SettingsSnapshot {
  /** 用户手动添加的模型。 */
  customModels: Array<{ providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean }>;
  /** 模型来源列表。 */
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number }>;
  /** MCP 服务器列表。 */
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  /** 已安装技能。 */
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  /** 已安装扩展。 */
  extensions: Array<{ name: string; scope: string; path: string; kind: string; source?: string }>;
  /** 已安装包。 */
  packages: Array<{ source: string; name: string }>;
  /** 扩展通过 settings 暴露的附加数据（原始字符串行）。 */
  extensionData: string[];
  /** 当前启用的模型 id。 */
  enabledModels: string[];
  /** 认证文件路径（只读展示）。 */
  authPath: string;
  /** MCP 配置文件路径。 */
  mcpPath: string;
  /** 模型配置文件路径。 */
  modelsPath: string;
  /** 当前模型与推理等级。 */
  model: ModelSelection;
}

declare global {
  interface Window {
    /**
     * 预加载脚本注入的主进程 API。
     * 所有 invoke 方法都是异步的；事件订阅方法返回取消订阅函数。
     */
    piApi: {
      // ---- 主题、状态与会话 ----
      /** 切换原生窗口主题，并持久化到主进程配置。 */
      setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>;
      /** 读取 pi-mode-switcher 的批准方式；available=false 时不显示入口。 */
      modeGet(): Promise<{ available: boolean; mode: 'ask' | 'smart' | 'full' }>;
      /** 切换批准方式；有会话时立即下发 /mode，没有会话时等会话建立后补发。 */
      modeSet(payload: { mode: 'ask' | 'smart' | 'full'; sessionId?: string }): Promise<{ mode: string; applied?: boolean; reason?: string }>;
      /** 扩展请求确认工具操作时触发；需要调用 confirmResponse 回传结果。 */
      onConfirmRequest(listener: (payload: { id: string; sessionId?: string; title: string; message: string }) => void): () => void;
      /** 回传确认结果；超时或窗口关闭视为拒绝。 */
      confirmResponse(payload: { id: string; accepted: boolean }): void;
      /** 读取侧边栏工作区/会话列表、当前模型与工作目录。 */
      state(cwd?: string): Promise<{ workspaces: PiWorkspace[]; model: ModelSelection; cwd: string }>;
      /** 在指定工作区新建会话。 */
      createSession(cwd: string): Promise<PiDetail>;
      /** 读取会话详情；会话不存在时返回 undefined。 */
      session(id: string): Promise<PiDetail | undefined>;
      /**
       * 侧边栏操作：重命名、移除、置顶、归档、分叉。
       * 成功返回可能是新建会话的信息（fork 时用）。
       */
      sidebarAction(payload: { kind: 'workspace' | 'session'; id: string; action: 'rename' | 'remove' | 'pin' | 'archive' | 'fork'; name?: string }): Promise<{ id?: string; cwd?: string; title?: string }>;

      // ---- 聊天发送 ----
      /**
       * 发送一条消息并开始新一轮请求。
       * requestId 由渲染进程生成，用于把 onPrompt 事件过滤到本次请求；
       * mentions 是 @ 文件路径，attachments 是已落盘附件路径，images 是内联图片。
       */
      prompt(payload: { sessionId: string; text: string; requestId: string; mentions?: string[]; attachments?: string[]; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<void>;
      /** 繁忙时的排队/插话通道；disposition 描述主进程实际采取的处理方式。 */
      queuePrompt(payload: { sessionId: string; text: string; behavior: 'queue' | 'steer'; mentions?: string[]; attachments?: string[]; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<{ disposition: string }>;

      // ---- 文件浏览 ----
      /** 列出工作区某目录下的条目。 */
      files(cwd: string, path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }> }>;
      /** 读取单个文件文本；binary 为 true 时 text 不可直接展示。 */
      file(cwd: string, path: string): Promise<{ path: string; size: number; binary: boolean; text: string }>;
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
      composerResources(payload: { sessionId?: string; cwd?: string }): Promise<{ commands: ComposerCommand[] }>;
      /** 按关键字搜索工作区文件，供 @ 提及补全。 */
      searchFiles(payload: { cwd: string; query: string }): Promise<{ files: ComposerFile[] }>;

      // ---- 附件 ----
      /** 把长文本保存成附件文件，返回路径与可直接插回输入框的 promptText。 */
      saveAttachment(payload: { sessionId: string; text: string }): Promise<ChatAttachment & { notice: string; promptText: string }>;
      /** 打开系统文件选择器挑选附件。 */
      pickAttachments(payload: { sessionId?: string }): Promise<{ attachments: ComposerAttachment[] }>;
      /** 保存粘贴/拖入的上传文件，返回带 marker 的落盘信息。 */
      saveUpload(payload: { sessionId?: string; name: string; mime: string; data: string }): Promise<UploadedAttachment>;
      /** 打开系统目录选择器，返回所选工作区路径。 */
      chooseWorkspace(): Promise<string | undefined>;

      // ---- 模型 ----
      /** 读取模型目录、启用列表与当前选择。 */
      models(cwd?: string): Promise<ModelCatalog>;
      /** 读取某来源下可选模型及启用状态。 */
      providerModels(providerId: string): Promise<{ models: Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }> }>;
      /** 读取来源的 baseUrl、API 类型与图标。 */
      providerConfig(providerId: string): Promise<{ providerId: string; baseUrl: string; api: string; icon: string }>;
      /** 切换模型，返回新的选择快照。 */
      setModel(modelRef: string, cwd?: string): Promise<ModelSelection>;
      /** 切换推理等级，返回新的选择快照。 */
      setThinkingLevel(payload: { modelRef: string; level: ThinkingLevel; cwd?: string }): Promise<ModelSelection>;
      /** 设置启用的模型 id 列表。 */
      setEnabledModels(models: string[]): Promise<any>;
      /** 添加或编辑自定义模型，成功后返回最新设置快照。 */
      addCustomModel(payload: { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; editing?: boolean }): Promise<SettingsSnapshot>;
      /** 删除自定义模型。 */
      removeCustomModel(payload: { providerId: string; modelId: string }): Promise<any>;

      // ---- 设置：MCP / 技能 / 扩展 / 包 ----
      /** 读取完整设置快照。 */
      settings(cwd?: string): Promise<SettingsSnapshot>;
      /** 保存某来源的 API Key。 */
      setKey(payload: { providerId: string; apiKey: string }): Promise<any>;
      /** 保存来源配置（baseUrl、API 类型、首个模型、可选 API Key）。 */
      addProvider(payload: { providerId: string; baseUrl: string; api: string; modelId: string; modelName: string; apiKey?: string; editing?: boolean }): Promise<{ settings: SettingsSnapshot; models: ModelCatalog }>;
      /** 读取 MCP 服务器配置详情。 */
      mcpConfig(name: string): Promise<{ name: string; transport: string; command: string; args: string[]; url: string; description: string; env: string }>;
      /** 保存 MCP 服务器；originalName 用于编辑时重命名。 */
      addMcp(payload: { name: string; transport: string; command?: string; args: string[]; url?: string; description?: string; env?: string; originalName?: string }): Promise<SettingsSnapshot>;
      /** 启用/停用 MCP 服务器。 */
      setMcpEnabled(payload: { name: string; enabled: boolean }): Promise<any>;
      /** 删除 MCP 服务器。 */
      removeMcp(name: string): Promise<any>;
      /** 添加技能（scope 决定用户级还是工作区级）。 */
      addSkill(payload: { scope: string; cwd?: string }): Promise<any>;
      /** 删除技能目录。 */
      removeSkill(path: string): Promise<any>;
      /** 添加扩展。 */
      addExtension(payload: { scope: string; cwd?: string }): Promise<any>;
      /** 删除扩展。 */
      removeExtension(path: string): Promise<any>;
      /** 安装包。 */
      addPackage(source: string): Promise<any>;
      /** 卸载包。 */
      removePackage(source: string): Promise<any>;

      // ---- 事件订阅（返回取消订阅函数） ----
      /** 应用菜单「设置…」被点击。 */
      onOpenSettings(listener: () => void): () => void;
      /** 读取扩展状态栏与页脚快照（含扩展自己的浮层）。 */
      extensionState(sessionId: string): Promise<{ statuses: Array<[string, string]>; footer: string; view?: FooterView; widgets?: ExtensionWidget[]; custom?: ExtensionCustomPanel | null; header?: { lines: FooterCell[][]; interactive: boolean } | null; working?: { message: string; visible: boolean } }>;
      /** 把 footer 的尺寸 / 点击 / 滚轮输入交给扩展，返回更新后的快照。 */
      footerAction(payload: FooterAction): Promise<FooterView | undefined>;
      /** 通用扩展 surface 输入：footer / widget / custom 共用。 */
      extensionAction(payload: { sessionId: string; surface: 'footer' | 'widget' | 'custom' | 'header'; type: 'resize' | 'click' | 'wheel' | 'key' | 'close'; target?: string; key?: string; ctrl?: boolean; columns?: number; rows?: number; appearance?: string; x?: number; y?: number; delta?: number }): Promise<unknown>;
      /** 回传 input()/editor() 的结果。 */
      extensionDialogResult(payload: { id: string; value: string | undefined }): Promise<boolean>;
      /** 回传扩展 select 的选择结果。 */
      extensionSelectResult(payload: { id: string; value: string | undefined }): Promise<boolean>;
      /** 把输入框当前文本同步给主进程，供扩展 getEditorText() 读取。 */
      editorTextChanged(payload: { sessionId: string; text: string }): void;
      /** 会话索引变化（草稿、标题或排序更新）时刷新侧边栏。 */
      onSessionsChanged(listener: () => void): () => void;
      /** 扩展状态项更新。 */
      onExtensionStatus(listener: (payload: { sessionId: string; key: string; text: string }) => void): () => void;
      /** 扩展页脚文本更新。 */
      onExtensionFooter(listener: (payload: { sessionId: string; text: string; view?: FooterView }) => void): () => void;
      /** 扩展 widget 更新。 */
      onExtensionWidgets(listener: (payload: { sessionId: string; widgets: ExtensionWidget[] }) => void): () => void;
      /** 扩展 custom() 浮层更新；custom 为 null 表示关闭。 */
      onExtensionCustom(listener: (payload: { sessionId: string; custom: ExtensionCustomPanel | null }) => void): () => void;
      /** 扩展请求输入框 / 多行编辑器。 */
      onExtensionDialog(listener: (payload: { sessionId: string } & ExtensionDialogRequest) => void): () => void;
      /** 扩展 select 请求。 */
      onExtensionSelect(listener: (payload: { sessionId: string; id: string; title: string; options: string[] }) => void): () => void;
      /** select 被超时 / AbortSignal 取消。 */
      onExtensionSelectClose(listener: (payload: { sessionId: string; id: string }) => void): () => void;
      /** 扩展工作状态（setWorkingMessage / setWorkingVisible）。 */
      /** 扩展 setHeader 的通用头部。 */
      onExtensionHeader(listener: (payload: { sessionId: string; header: { lines: FooterCell[][]; interactive: boolean } | null }) => void): () => void;
      onExtensionWorking(listener: (payload: { sessionId: string; working: { message: string; visible: boolean } }) => void): () => void;
      /** 扩展要求替换输入框文本。 */
      onExtensionEditorSet(listener: (payload: { sessionId: string; text: string }) => void): () => void;
      /** 扩展要求把文本插入输入框。 */
      onExtensionEditorPaste(listener: (payload: { sessionId: string; text: string }) => void): () => void;
      /** 扩展弹出通知（toast）。 */
      onExtensionNotify(listener: (payload: { sessionId: string; message: string; type: 'info' | 'warning' | 'error' }) => void): () => void;
      /**
       * 一轮请求的流式事件。type 覆盖消息开始/增量/结束、自动重试开始与结束、
       * 整体完成与失败；渲染进程按 requestId 过滤出本次请求的事件。
       */
      onPrompt(listener: (payload: { requestId: string; type: 'message_start' | 'message_update' | 'message_end' | 'retry-start' | 'retry-end' | 'compaction-start' | 'compaction-end' | 'compaction-interrupted' | 'turn-diff' | 'done' | 'error'; message?: ChatMessage; error?: string; attempt?: number; maxAttempts?: number; delayMs?: number; success?: boolean; finalError?: string; errorMessage?: string; diff?: TurnDiff; at?: number; reason?: 'manual' | 'threshold' | 'overflow'; aborted?: boolean }) => void): () => void;

      // ---- 扩展命令 ----
      /** 运行扩展提供的命令。 */
      runExtensionCommand(payload: { sessionId: string; command: string }): Promise<{ ok: boolean }>;
    };
  }
}
