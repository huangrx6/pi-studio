/**
 * 会话与输入区共享类型（渲染进程 ↔ 主进程的数据契约）。
 *
 * 这些字段对应 Durable transcript 的投影，以及 electron/preload.cjs 通过
 * `window.piApi` 返回的数据，因此不要随意改名或增删字段。会话历史会被持久化，
 * 破坏性字段变更必须带版本化迁移。
 *
 * 本文件只有类型声明，没有运行时代码，不直接参与 IPC 调用。
 */

/** 文本块：用户输入、助手回复、工具结果里的纯文本都用它承载。 */
export type TextBlock = { type: 'text'; text: string };

/** 图片块：data 是 base64（不含 `data:<mime>;base64,` 前缀，渲染时再拼）。 */
export type ImageBlock = { type: 'image'; data: string; mimeType: string };

/** 思考块：模型推理过程；redacted 为 true 时正文被服务端隐藏，只展示占位提示。 */
export type ThinkingBlock = { type: 'thinking'; thinking: string; redacted?: boolean };

/** 工具调用块：由助手消息发出，执行结果在另一条 toolResult 消息里。 */
export type ToolCallBlock = {
  type: 'toolCall';
  /** 调用唯一 id，用于和 toolResult 消息的 toolCallId 配对。 */
  id: string;
  /** 工具名，如 bash / read / edit / write / grep / todo。 */
  name: string;
  /** 模型给出的原始参数；不同工具结构不同，渲染时按需读取 path、command 等。 */
  arguments: Record<string, unknown>;
  /** 可选命名空间，用于区分扩展提供的同名工具。 */
  namespace?: string;
};

/** 消息内容块联合类型；同一条消息可能混合文本、图片、思考和工具调用。 */
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

/** 已由主进程落盘的附件摘要（用于用户消息里的附件卡片）。 */
export type ChatAttachment = {
  /** 展示用文件名。 */
  name: string;
  /** 绝对路径，同时作为列表 key。 */
  path: string;
  /** 文件字节数，用于展示体积。 */
  bytes: number;
  /** 文本行数；非文本文件可能为 0。 */
  lines: number;
  /** 附件分类，决定展示方式。 */
  kind?: 'text' | 'file';
  /** MIME 类型，用于匹配图标。 */
  mime?: string;
};

/** 输入框中尚未发送的附件；图片可能只在内存里携带 base64 数据。 */
export type ComposerAttachment = {
  /** 本地唯一 id，用于编辑或删除。 */
  id: string;
  /** 图片走缩略图，普通文件走文件卡片。 */
  kind: 'image' | 'file';
  /** 文件名。 */
  name: string;
  /** MIME 类型。 */
  mime: string;
  /** 字节数。 */
  bytes: number;
  /** base64 数据；只有图片在发送前可能携带。 */
  data?: string;
  /** 已落盘文件的绝对路径，未上传时为 undefined。 */
  path?: string;
  /** 文本行数（主进程读取后回填）。 */
  lines?: number;
  /** 发送时插入正文的 @ 引用标记。 */
  marker?: string;
};

/** 任务计划中的一条任务（内置 todo 工具写出的结构）。 */
export type TodoTask = {
  /** 任务编号，展示为 #id，同时被 blockedBy 引用。 */
  id: number;
  /** 任务标题。 */
  subject: string;
  /** 详细说明，界面里只作为 title 提示。 */
  description?: string;
  /** 进行中时展示的另一种描述（如「正在编写测试」）。 */
  activeForm?: string;
  /** 生命周期状态；deleted 为软删除，不再展示。 */
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  /** 依赖的任务 id；任一依赖未完成、未结束即视为被阻塞。 */
  blockedBy?: number[];
  /** 归档时间戳；归档任务不进入分组列表。 */
  archivedAt?: number;
  /** 结束时间戳；已结束任务不计入进度总数。 */
  closedAt?: number;
  /** 结束原因（由 todo 工具记录）。 */
  closedReason?: string;
  /** 创建时间戳。 */
  createdAt?: number;
  /** 最近更新时间戳。 */
  updatedAt?: number;
};

/** 任务计划的整体快照，由 todo 工具结果消息的 details 透传给 TodoDock。 */
export type TodoDetails = {
  /** 结构版本号，用于将来兼容迁移。 */
  schemaVersion?: number;
  /** 全部任务（含已归档、已删除）。 */
  tasks: TodoTask[];
  /** 下一个可用任务编号。 */
  nextId: number;
};

/** 通过系统文件选择器上传并落盘后的附件信息（带发送用 marker）。 */
export type UploadedAttachment = {
  /** 展示用文件名。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 字节数。 */
  bytes: number;
  /** 文本行数。 */
  lines: number;
  /** 上传附件固定归类为 file（图片也走文件路径保存）。 */
  kind: 'file';
  /** MIME 类型。 */
  mime: string;
  /** 插入正文的 @ 引用标记。 */
  marker: string;
};

/** 会话中的一条消息。assistant 消息可能被合并成一轮展示，见 ChatMessage.tsx。 */
export type ChatMessage = {
  /** 消息角色；toolResult 不会渲染成独立气泡，而是折叠进对应工具调用。 */
  role: 'user' | 'assistant' | 'toolResult';
  /** 内容块列表，顺序即模型的输出顺序。 */
  content: ContentBlock[];
  /** 毫秒时间戳，用于显示时间，也常被用作列表 key。 */
  timestamp?: number;
  /** 在完整会话消息数组中的绝对序号；分页后保持不变，供跨页跳转使用。 */
  sourceIndex?: number;
  /** 助手是否仍在流式输出。 */
  streaming?: boolean;
  /** 结束原因（stop / length / toolUse / aborted / error 等，由 Pi 提供）。 */
  stopReason?: string;
  /** 失败原因；非空即视为该轮请求失败，界面展示错误卡片。 */
  errorMessage?: string;
  /** 产生该助手消息的模型标识。 */
  model?: string;
  /** 模型来源（provider id）。 */
  provider?: string;
  /** token 用量原始数据；前端只透传，不解析。 */
  usage?: unknown;
  /** 本轮使用的推理等级。 */
  thinkingLevel?: string;
  /** 工具结果消息对应的工具调用 id，用于和 ToolCallBlock 配对。 */
  toolCallId?: string;
  /** 工具名（如 todo），用于识别特殊结果。 */
  toolName?: string;
  /** 工具结果是否失败。 */
  isError?: boolean;
  /** 工具执行耗时（毫秒）。 */
  durationMs?: number;
  /** 用户消息附带的、已落盘的文件。 */
  attachments?: ChatAttachment[];
  /** 工具结果的结构化细节（例如 TodoDetails），类型由工具自行约定。 */
  details?: unknown;
};

export type RequestTraceContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | {
      type: 'toolCall';
      id?: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: 'image';
      mimeType: string;
      bytes: number;
      omitted: true;
    }
  | { type: 'unknown'; originalType?: string; value?: unknown };

/** One provider-bound message, reduced to a JSON-safe and redacted trace. */
export type RequestTraceMessage = {
  index: number;
  role: string;
  content: RequestTraceContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  truncated?: boolean;
};

export type RequestTraceTool = {
  name: string;
  description: string;
  parameters?: unknown;
};

/**
 * Snapshot of one actual model request captured immediately before the
 * provider call. This is a Studio-owned UI projection; Durable still owns the
 * live request and transcript.
 */
export type RequestTrace = {
  id: string;
  requestId: string;
  conversationId: string;
  taskId: string;
  attempt: number;
  createdAt: number;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  messages: RequestTraceMessage[];
  tools: RequestTraceTool[];
  stats: {
    messageCount: number;
    systemChars: number;
    userChars: number;
    assistantChars: number;
    toolResultChars: number;
    imageCount: number;
    toolCallCount: number;
    toolDefinitionCount: number;
    estimatedChars: number;
  };
  truncated: boolean;
};

/** 斜杠命令来源，决定菜单里显示的图标。 */
export type ComposerCommandSource = 'builtin' | 'extension' | 'prompt' | 'skill';

/** 输入框可用的斜杠命令或提示词模板。 */
export type ComposerCommand = {
  /** 命令名（不含前导斜杠）。 */
  name: string;
  /** 说明文字，参与搜索过滤。 */
  description: string;
  /** 来源分类。 */
  source: ComposerCommandSource;
  /** 参数提示，如 `<path>`，展示在命令名后。 */
  argumentHint?: string;
  /** 扩展命令的稳定 contribution id；内置命令没有该字段。 */
  commandId?: string;
  /** 提供该命令的 Studio 扩展稳定 id。 */
  extensionId?: string;
};

/** 输入框 @ 搜索到的文件或目录候选。 */
export type ComposerFile = {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 相对工作区的路径。 */
  path: string;
  /** 文件或目录，用于决定图标与插入方式。 */
  type: 'file' | 'directory';
};

/** 一轮对话中单个文件的 Git 变更；patch 为统一 diff 文本。 */
export type TurnDiffFile = {
  /** 文件绝对路径。 */
  path: string;
  /** 相对会话工作区的展示路径。 */
  label: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  binary?: boolean;
  /** 补丁是否因体积被截断。 */
  truncated?: boolean;
  /** 统一 diff 文本；二进制或读取失败时为空。 */
  patch?: string;
  /** false 表示无法准确统计行数（二进制）。 */
  completeCounts?: boolean;
};

/** 一轮对话结束后的 Git 变更汇总。 */
export type TurnDiff = {
  snapshot?: { root: string; before: string; after: string };
  /** 该轮最后一条助手消息的时间戳，用于和回合配对。 */
  at: number;
  files: TurnDiffFile[];
  totalAdded: number;
  totalRemoved: number;
  /** 文件数是否被上限截断。 */
  truncated?: boolean;
};
