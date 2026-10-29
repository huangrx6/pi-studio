/**
 * Pi Studio 渲染进程的主界面。
 *
 * 这个文件负责整个窗口的「数据 + 交互 + 布局」，按下面的顺序组织：
 *  1. 常量与纯函数：设置页定义、API 协议、格式化与本地存储工具
 *  2. 类型：会话摘要、提交内容、排队消息、设置快照
 *  3. App 组件
 *     - 状态：工作区/会话、输入与附件、模型、设置页、右侧文件面板
 *     - 数据加载：loadState / openSession / 设置快照
 *     - 交互：发送与排队、拖拽排序、斜杠命令与 @ 文件、附件
 *     - 渲染：侧边栏、对话区、输入区、设置覆盖层、右侧工作台
 *
 * 所有系统能力都通过 window.piApi 调用主进程（见 electron/preload.cjs），
 * 渲染进程本身不直接访问 Node / 文件系统。
 */

import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Clock3, Command, Cpu, ExternalLink, FileCode2, FileDiff, FileText, Folder, FolderOpen, Github, Info, Sparkles, UserRound,
  AppWindow, Bot, Columns2, Compass, Eye, Film, Globe2, Image as ImageIcon, Keyboard, Layers3, LayoutGrid, LoaderCircle, Maximize2, MessageCirclePlus, MessageSquare, Minimize2, Monitor, Moon, MoreHorizontal, PanelLeft, PanelRight, PanelRightOpen, Pencil, Plus, Plug, RotateCw, Search, Settings, ShieldCheck, SquarePen, Sun, Terminal, Trash2, X,
  Wrench,
} from 'lucide-react';
import appIcon from '../../assets/icon.png';
import { ExtensionCustomOverlay, ExtensionDialogHost, ExtensionHeader, ExtensionSelectDialog, ExtensionWidgets } from './components/ExtensionSurfaces';
import { StatusDock } from './components/StatusDock';
import { Select } from './components/Select';
import { FullPermissionDialog, ToolConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { DiffView } from './components/DiffView';
import { TemporaryChat } from './components/TemporaryChat';
import { destroyTemporary } from './temporary-chat-store';
import { ChangesView } from './components/ChangesView';
import { ActionMenu } from './components/ActionMenu';
import { splitComposerText } from './references';
import type { ChatMessage, ComposerAttachment, ComposerCommand, ComposerCommandSource, ComposerFile, TodoDetails, TurnDiff, TurnDiffFile } from './chat-types';
import { AttachmentIcon } from './components/AttachmentIcon';
import { AssistantTurnView, ChatMessageView } from './components/ChatMessage';
import { TodoDock } from './components/TodoDock';
import { QueuedMessages, type QueuedPreview } from './components/QueuedMessages';
import { DetailDialog } from './components/DetailDialog';
import { ProviderIcon } from './components/ProviderIcon';
import { SettingsDialog } from './components/SettingsDialog';
import { AgentToolsSettings } from './components/AgentToolsSettings';
import { SubagentSettings } from './components/SubagentSettings';
import { SubagentOverview, SubagentTranscriptView } from './components/SubagentViews';
import { BackgroundLayer, BackgroundMediaPreview } from './components/BackgroundLayer';
import { UpdateDialog } from './components/UpdateDialog';
import type { AgentToolSelection } from './agent-tool-types';
import type { SubagentChild, SubagentTranscript } from './subagent-types';
import { ModelPicker, type ModelPickerRequest } from './components/ModelPicker';
import { WorkspacePicker } from './components/WorkspacePicker';
import { SidebarActions, type SidebarAction } from './components/SidebarActions';
import { thinkingLabels, type ModelOption, type ModelSelection, type ThinkingLevel } from './model-types';
import { PALETTE_PRESETS, RADIUS_PRESETS, loadPreferences, resolveTheme, savePreferences, setActivePreferences, type Preferences } from './preferences';
import { pasteExceedsBudget, isLongMessage } from './composer-budget.mjs';
import {
  SCROLL_INTENT_WINDOW_MS,
  isNearBottom,
  resolveAutoFollow,
  shouldReleaseFollowOnWheel,
} from './chat-scroll.mjs';
import { HISTORY_PAGE_SIZE, resolveHistoryScroll } from './history-scroll.mjs';
import { sampleOutlineIndices } from './outline-samples.mjs';
import { normalizeThinkingLevelArgument, parseStudioCommand } from './composer-command-routes.mjs';
import type { UpdateSnapshot } from './update-types';
import type { RuntimeRefreshSnapshot } from './runtime-types';

// 设置页导航：顺序、图标与描述同时用于设置侧栏和页面标题。
const settingsPages = [
  { id: 'general', label: '通用', icon: Settings, description: '外观、工作步骤、链接与输入行为。' },
  { id: 'tools', label: 'Agent 工具', icon: Wrench, description: '控制模型可以调用哪些工具，并查看它们来自哪里。' },
  { id: 'subagents', label: '子 Agent', icon: Bot, description: '配置子 Agent 的模型、思考强度与角色覆盖。' },
  { id: 'models', label: '模型与账号', icon: Cpu, description: '连接模型来源，选择适合当前工作的模型。' },
  { id: 'mcp', label: 'MCP 服务器', icon: Plug, description: '连接外部工具，让 Pi 更好地理解你的工作环境。' },
  { id: 'skills', label: '技能', icon: FileCode2, description: '管理可复用的工作方法，为 Pi 扩展专业能力。' },
  { id: 'extensions', label: '扩展', icon: Layers3, description: '统一管理已安装的 Pi 扩展和扩展包。' },
  { id: 'about', label: '关于', icon: Info, description: '一个专注、轻巧的 AI 开发工作台。' },
] as const;

// 新增模型来源时可选的上游 API 协议。
const apiTypeOptions = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

// 输入框左侧的权限模式；实际拦截由 pi-mode-switcher 扩展在 tool_call 阶段执行。
const permissionOptions = [
  { value: 'ask', label: '请求批准', description: '编辑文件或联网前询问' },
  { value: 'smart', label: '帮我批准', description: '仅对风险操作请求批准' },
  { value: 'full', label: '完全权限', description: '不再询问，直接执行' },
];
type PermissionMode = 'ask' | 'smart' | 'full';

function BrandMark({ className = '' }: { className?: string }) {
  return <img className={`brand-mark ${className}`} src={appIcon} alt="" draggable={false} />;
}

// ---------- 类型定义 ----------

/** 侧边栏里的会话条目（来自主进程的会话索引）。 */
type PiSessionSummary = { pinned?: boolean; archived?: boolean; id: string; cwd: string; title: string; updatedAt: number; messageCount: number };
type ImagePayload = { type: 'image'; data: string; mimeType: string };
type OutlineItem = { sourceIndex: number; text: string; timestamp?: number };
type OutlineData = { items: OutlineItem[]; totalMessages: number };
/**
 * 发送前的完整提交内容：
 *  - displayText：给界面看（长消息已替换成摘要）
 *  - outgoingText：真正发给模型（包含附件标记）
 *  - mentions / attachmentPaths：交给主进程读取文件上下文
 */
type PreparedSubmission = {
  sessionId: string;
  displayText: string;
  outgoingText: string;
  content: ChatMessage['content'];
  persistentAttachments: NonNullable<ChatMessage['attachments']>;
  imagePayload: ImagePayload[];
  mentions: string[];
  attachmentPaths: string[];
};
/** 排队中的消息：保留原始文本与附件，便于撤回后继续编辑。 */
type QueuedPrompt = { id: string; order: number; text: string; attachments: ComposerAttachment[]; submission: PreparedSubmission };
type PiWorkspace = { cwd: string; name: string; sessions: PiSessionSummary[] };
type ModelOrigin = 'builtin' | 'configured' | 'override';
type CustomModelConfig = { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean; origin?: Exclude<ModelOrigin, 'builtin'> };
type ProviderModelInfo = { id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean; reasoning?: boolean; origin: ModelOrigin; deletable?: boolean };
type DiscoveredModel = { id: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean };
type ProviderDiscoveryState = { loading?: boolean; importing?: boolean; imported?: number; endpoint?: string; models?: DiscoveredModel[]; error?: string };
type MenuBarPreference = { available: boolean; enabled: boolean; platform: string };

function packageSourceLabel(source: string) {
  if (source.startsWith('npm:')) return 'npm 扩展包';
  if (/^(git:|https?:|ssh:)/.test(source)) return 'Git 扩展包';
  if (source.startsWith('.') || source.startsWith('/')) return '本地扩展包';
  return '扩展包';
}

/** 设置页当前打开的编辑弹窗；editId 为空表示新建。 */
type SettingsEditor = { kind: 'provider' | 'model' | 'mcp' | 'package' | 'skill' | 'extension' | 'extension-install'; editId?: string; providerId?: string };
type SettingsSnapshot = {
  customModels: CustomModelConfig[];
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number; modelsUrl?: string }>;
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  extensions: Array<{ name: string; scope: string; path: string; kind: string; source?: string }>;
  packages: Array<{ source: string; name: string; scope: 'user' | 'project' }>;
  enabledModels: string[];
  agentTools: AgentToolSelection;
  agentToolsPath: string;
  authPath: string;
  mcpPath: string;
  modelsPath: string;
  model: { modelRef: string; label: string };
  runtimeRefresh?: RuntimeRefreshSnapshot;
};

type SkillInfo = SettingsSnapshot['skills'][number];
type McpInfo = SettingsSnapshot['mcp'][number];
type SkillDetailState = SkillInfo & { baseDir: string };

/** 文件大小的紧凑展示，用于文件列表与附件卡片。 */
function filesize(size: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 1024) * 10) / 10} MB`;
}

/** 把未知异常转成可展示的一行文本（IPC 抛出的错误不一定是 Error 实例）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取出消息内容里的纯文本块；separator 用于区分「按行拼接」和「按空格拼接」。 */
function textOfBlocks(content: ChatMessage['content'], separator = '\n'): string {
  return content
    .filter((block): block is Extract<ChatMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(separator);
}

/** 旧版主进程或测试桩没有大纲接口时，用当前窗口生成可用的降级大纲。 */
function outlineFromMessages(messages: ChatMessage[], messageStart = 0): OutlineData {
  const items = messages.flatMap((message, index): OutlineItem[] => {
    if (message.role !== 'user') return [];
    return [{
      sourceIndex: message.sourceIndex ?? messageStart + index,
      text: textOfBlocks(message.content, ' ').replace(/\s+/g, ' ').trim() || '消息',
      timestamp: message.timestamp,
    }];
  });
  return { items, totalMessages: messageStart + messages.length };
}

/** 当前窗口底部附近的最后一条提问，用于初次打开会话时同步大纲位置。 */
function lastLoadedOutlineIndex(data: OutlineData, messages: ChatMessage[]): number {
  const sourceIndexes = messages
    .map((message) => message.sourceIndex)
    .filter((value): value is number => typeof value === 'number');
  if (sourceIndexes.length === 0) return Math.max(0, data.items.length - 1);
  const loaded = new Set(sourceIndexes);
  for (let index = data.items.length - 1; index >= 0; index -= 1) {
    if (loaded.has(data.items[index].sourceIndex)) return index;
  }
  return 0;
}

/** 会话列表使用的相对时间：刚刚 / N 分钟 / N 小时 / N 天。 */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  return `${Math.floor(diff / 86_400_000)} 天`;
}

/** 侧边栏展开状态、手动排序与上次打开的会话都存在 localStorage。 */
const UI_KEYS = {
  expanded: 'pi-studio:expanded-workspaces',
  workspaceOrder: 'pi-studio:workspace-order',
  sessionOrder: 'pi-studio:session-order',
  activeSession: 'pi-studio:active-session',
} as const;

/** 读本地存储；解析失败时退回默认值。 */
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

/** 写本地存储；隐私模式下写入失败则静默忽略。 */
function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/** 模型状态装载前的占位快照；新对话和当前会话各自持有一份。 */
function emptyModelSelection(): ModelSelection {
  return {
    modelRef: '',
    label: '',
    thinkingLevel: 'default',
    thinkingLevels: ['default'],
    effectiveThinkingLevel: 'off',
    defaultThinkingLevel: 'off',
  };
}

// ---------- 视图辅助类型 ----------
type DragItem = { kind: 'workspace' | 'session'; cwd: string; sessionId?: string };
type PanelFile = { path: string; size: number; binary: boolean; text: string };
type PanelTab = { id: string; kind: 'start' | 'files' | 'file' | 'diff' | 'changes' | 'temporary'; title: string; path?: string; diff?: TurnDiffFile; review?: { sessionId: string; initial: TurnDiff; turns: TurnDiff[]; focusPath?: string } };
type ComposerMenuState = { kind: 'slash' | 'file'; query: string; start: number; end: number };
type AgentView = { kind: 'conversation' } | { kind: 'agents' } | { kind: 'child'; child: SubagentChild };

/** 上下文窗口的短标签（128K / 1M），避免卡片被长数字撑开。 */
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** 输入框命令列表里，用图标区分命令来源。 */
function ComposerSourceIcon({ source }: { source: ComposerCommandSource }) {
  if (source === 'skill') return <Sparkles />;
  if (source === 'prompt') return <FileText />;
  if (source === 'extension') return <Plug />;
  return <Command />;
}

/** 按上下文窗口大小切换颜色档位，用于模型卡片上的 token 标签。 */
function contextTone(tokens?: number): string {
  if (!tokens) return 'is-small';
  if (tokens >= 1_000_000) return 'is-million';
  if (tokens >= 200_000) return 'is-large';
  if (tokens >= 100_000) return 'is-medium';
  return 'is-small';
}

type StreamMessageType = 'message_start' | 'message_update' | 'message_end';

/**
 * 把一条流式消息合并进列表。
 * 同角色 + 同 timestamp 视为同一条消息；message_start 会先结束上一段
 * 仍在流式的助手消息，避免多个气泡同时出现。
 */
function mergeStreamMessage(current: ChatMessage[], incoming: ChatMessage, type: StreamMessageType): ChatMessage[] {
  const copy = [...current];
  if (incoming.role === 'assistant' && type === 'message_start') {
    for (let index = 0; index < copy.length; index += 1) {
      if (copy[index].streaming) copy[index] = { ...copy[index], streaming: false };
    }
  }
  const streaming = incoming.role === 'assistant' && type !== 'message_end';
  const next = { ...incoming, ...(streaming ? { streaming: true } : { streaming: false }) };
  // 并行工具结果会共享同一个时间戳；toolResult 必须按 toolCallId 合并，
  // 否则后一个结果会覆盖前一个，另一条工具调用永远停在「执行中」。
  let index = copy.findIndex((message) => incoming.role === 'toolResult' && incoming.toolCallId
    ? message.role === 'toolResult' && message.toolCallId === incoming.toolCallId
    : message.role === incoming.role && message.timestamp === incoming.timestamp);
  if (index < 0 && incoming.role === 'assistant' && type !== 'message_start') {
    index = copy.findIndex((message) => message.role === 'assistant' && message.streaming);
  }
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return copy;
}

/**
 * A wheel event can bubble out of an overflowing code block or tool result.
 * While that inner element can still scroll in the requested direction, the
 * transcript itself must remain pinned.
 */
function nestedScrollableConsumesWheel(target: EventTarget | null, viewport: HTMLElement | null, deltaY: number): boolean {
  if (!viewport || !(target instanceof Element) || !deltaY) return false;
  let node: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
  while (node && node !== viewport) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        if (deltaY < 0 && node.scrollTop > 1) return true;
        if (deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

const SUBAGENT_FINAL_STATUSES = new Set<SubagentChild['status']>(['completed', 'failed', 'stopped', 'paused']);

/** 实时事件只更新字段，不能用迟到的 running 覆盖已经落地的终态。 */
function mergeSubagentChild(current: SubagentChild, incoming: SubagentChild): SubagentChild {
  const fields = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as Partial<SubagentChild>;
  const next: SubagentChild = {
    ...current,
    ...fields,
    status: SUBAGENT_FINAL_STATUSES.has(current.status) ? current.status : incoming.status,
  };
  if (current.hasTranscript && !incoming.hasTranscript) next.hasTranscript = true;
  return next;
}

function mergeSubagentChildren(current: SubagentChild[], incoming: SubagentChild[]): SubagentChild[] {
  if (incoming.length === 0) return current;
  const merged = new Map(current.map((child) => [child.key, child]));
  for (const child of incoming) {
    const previous = merged.get(child.key);
    merged.set(child.key, previous ? mergeSubagentChild(previous, child) : child);
  }
  return [...merged.values()].slice(-100);
}

/**
 * 应用根组件。
 *
 * 状态大致分五组：
 *  - 工作区 / 会话：workspaces、workspace、session、messages、expanded、排序
 *  - 输入区：prompt、附件、斜杠命令菜单、排队消息
 *  - 模型：modelSelection、models、设置页的模型草稿
 *  - 设置：settingsOpen / settingsTab / settingsData / editor
 *  - 右侧工作台：面板标签、文件树、文件预览、打开方式菜单
 *
 * 状态之间通过「主进程快照 + 本地乐观更新」保持同步：
 * 发送消息或修改设置后，再调用 loadState() 拉一次最新数据。
 */

export function App() {
  const [workspaces, setWorkspaces] = useState<PiWorkspace[]>([]);
  const [stateLoading, setStateLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyAnchorRef = useRef<{ sessionId: string; bottomOffset: number } | null>(null);
  const historyLoadingRef = useRef(false);
  const historyRequestRef = useRef(0);
  const historyArmedRef = useRef(true);
  const historyUserScrollRef = useRef(false);
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [menuBarPreference, setMenuBarPreference] = useState<MenuBarPreference>({ available: false, enabled: true, platform: '' });
  const [menuBarBusy, setMenuBarBusy] = useState(false);
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot>({ currentVersion: '', state: 'idle' });
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [extensionToast, setExtensionToast] = useState<{ message: string; type: 'info' | 'warning' | 'error' } | null>(null);
  const [extensionWorking, setExtensionWorking] = useState<{ message: string; visible: boolean }>({ message: '', visible: true });
  const [compaction, setCompaction] = useState<{ active: boolean; reason?: string }>({ active: false });
  const [permission, setPermission] = useState<{ available: boolean; mode: PermissionMode }>({ available: false, mode: 'smart' });
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [fullPermissionOpen, setFullPermissionOpen] = useState(false);
  const [fullPermissionAck, setFullPermissionAck] = useState(false);
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedDrainRef = useRef(false);
  const queuedOrderRef = useRef(0);
  const [outlineActive, setOutlineActive] = useState(0);
  const [outlineHover, setOutlineHover] = useState<number | null>(null);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [outlineTotalMessages, setOutlineTotalMessages] = useState(0);
  const outlineRequestRef = useRef(0);
  const pendingOutlineJumpRef = useRef<{ sessionId: string; sourceIndex: number; index: number } | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelSelection>(emptyModelSelection);
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection>(emptyModelSelection);
  const [modelPickerRequest, setModelPickerRequest] = useState<ModelPickerRequest | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readStored<string[]>(UI_KEYS.expanded, [])));
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => readStored<string[]>(UI_KEYS.workspaceOrder, []));
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => readStored<Record<string, string[]>>(UI_KEYS.sessionOrder, {}));
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [draggingItem, setDraggingItem] = useState<DragItem | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const [session, setSession] = useState<{ id: string; cwd: string; title: string; turnDiffs?: TurnDiff[]; hasMore?: boolean; messageStart?: number; totalMessages?: number } | null>(null);
  const sessionRef = useRef(session);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentView, setAgentView] = useState<AgentView>({ kind: 'conversation' });
  const [subagentChildren, setSubagentChildren] = useState<SubagentChild[]>([]);
  const [subagentTranscript, setSubagentTranscript] = useState<SubagentTranscript | null>(null);
  const [subagentLoading, setSubagentLoading] = useState(false);
  const [subagentError, setSubagentError] = useState<string | null>(null);
  const subagentRequestRef = useRef(0);
  const mainScrollPositionRef = useRef(0);
  useEffect(() => {
    sessionRef.current = session;
    // 切走后主进程可以释放旧会话的 AgentSession；流式中的会自己跳过。
    window.piApi.sessionFocus?.(session?.id ?? null);
  }, [session]);
  // 切换会话时取消旧分页请求，并重新允许一次顶部自动加载。
  useEffect(() => {
    historyRequestRef.current += 1;
    historyLoadingRef.current = false;
    historyAnchorRef.current = null;
    historyArmedRef.current = true;
    setHistoryLoading(false);
    ++subagentRequestRef.current;
    setAgentView({ kind: 'conversation' });
    setSubagentChildren([]);
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(false);
  }, [session?.id]);
  const [prompt, setPrompt] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [composerMenu, setComposerMenu] = useState<ComposerMenuState | null>(null);
  const [composerCommands, setComposerCommands] = useState<ComposerCommand[]>([]);
  const [composerFiles, setComposerFiles] = useState<ComposerFile[]>([]);
  const [composerMenuIndex, setComposerMenuIndex] = useState(0);
  const [composerMenuLoading, setComposerMenuLoading] = useState(false);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const composerResourcesRequestRef = useRef(0);
  const composerFileRequestRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelView, setModelView] = useState<'all' | 'provider'>('all');
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({});
  const [providerDiscovery, setProviderDiscovery] = useState<Record<string, ProviderDiscoveryState>>({});
  const [customModel, setCustomModel] = useState({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false, origin: 'configured' as ModelOrigin });
  const [packageDraft, setPackageDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'tools' | 'subagents' | 'models' | 'mcp' | 'skills' | 'extensions' | 'about'>('general');
  const [settingsData, setSettingsData] = useState<SettingsSnapshot | null>(null);
  const [editor, setEditor] = useState<SettingsEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [resourceScope, setResourceScope] = useState<'user' | 'project'>('user');
  const [extensionInstallMode, setExtensionInstallMode] = useState<'package' | 'local'>('package');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [defaultModelBusy, setDefaultModelBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState({ providerId: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', icon: '', modelsUrl: '' });
  const [mcpDraft, setMcpDraft] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
  const [treePath, setTreePath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [file, setFile] = useState<PanelFile | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, PanelFile>>({});
  const [panelTabs, setPanelTabs] = useState<PanelTab[]>([{ id: 'start', kind: 'start', title: '开始' }]);
  const [liveDiff, setLiveDiff] = useState<TurnDiff | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const [activePanelTabId, setActivePanelTabId] = useState('start');
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);
  const panelTabsRef = useRef<HTMLDivElement>(null);
  const tabDragRef = useRef<string | null>(null);
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => readStored<number>('pi-studio:panel-width', 700));
  const [panelResizing, setPanelResizing] = useState(false);
  const panelDrag = useRef<{ x: number; width: number } | null>(null);
  const resizePanel = (width: number) => {
    const next = Math.round(Math.max(320, Math.min(window.innerWidth - 48, width)));
    setPanelWidth(next); writeStored('pi-studio:panel-width', next);
  };
  const [panelEntered, setPanelEntered] = useState(false);
  const panelCloseTimerRef = useRef<number | null>(null);
  const [panelSplit, setPanelSplit] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileApps, setFileApps] = useState<Array<{ name: string; path: string; icon?: string }>>([]);
  const [skillDetail, setSkillDetail] = useState<SkillDetailState | null>(null);
  const [skillEntries, setSkillEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [skillTreePath, setSkillTreePath] = useState('');
  const [skillFile, setSkillFile] = useState<PanelFile | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
  const [mcpDetail, setMcpDetail] = useState<McpInfo | null>(null);
  const fileActionsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const outlineSyncRef = useRef<number | null>(null);
  const followBottomRef = useRef(true);
  const autoScrollFrameRef = useRef(0);
  const scrollIntentTimerRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef(false);
  const lastTranscriptScrollTopRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerHighlightRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const settingsContentRef = useRef<HTMLElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<string | null>(null);
  const modelPickerRequestRef = useRef(0);
  const sessionLoadRef = useRef(0);
  const prefetchedSessionsRef = useRef<Set<string>>(new Set());
  const editorRequestRef = useRef(0);
  const originalMcpArgsRef = useRef<string[] | null>(null);
  const workspaceOrderRef = useRef(workspaceOrder);
  const sessionOrderRef = useRef(sessionOrder);
  const dragRef = useRef<DragItem | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);
  const openFileHandlerRef = useRef<(path: string) => void>(() => {});
  const openChangesHandlerRef = useRef<(file: TurnDiffFile | undefined, turn: TurnDiff) => void>(() => {});
  openFileHandlerRef.current = (path) => { void openFile(path); };
  openChangesHandlerRef.current = (nextFile, turn) => openChangesTab(nextFile, turn);
  const handleOpenFile = useCallback((path: string) => {
    openFileHandlerRef.current(path);
  }, []);
  const handleOpenChanges = useCallback((nextFile: TurnDiffFile | undefined, turn: TurnDiff) => {
    openChangesHandlerRef.current(nextFile, turn);
  }, []);

  function markUserScrollIntent() {
    userScrollIntentRef.current = true;
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    scrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      scrollIntentTimerRef.current = null;
    }, SCROLL_INTENT_WINDOW_MS);
  }

  function pinTranscriptToBottom() {
    const node = scrollRef.current;
    if (!node || !followBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
    lastTranscriptScrollTopRef.current = node.scrollTop;
  }

  function scheduleTranscriptPin() {
    if (autoScrollFrameRef.current || !followBottomRef.current) return;
    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = 0;
      pinTranscriptToBottom();
    });
  }

  function pauseTranscriptFollow() {
    followBottomRef.current = false;
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = 0;
    }
  }

  function resumeTranscriptFollow() {
    followBottomRef.current = true;
    scheduleTranscriptPin();
  }

  // ---------- 偏好与主题 ----------

  // 偏好变化时同步到 localStorage、CSS 变量和原生窗口主题。
  useEffect(() => {
    savePreferences(preferences);
    setActivePreferences(preferences);
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(preferences.theme);
    root.dataset.palette = preferences.palette;
    void window.piApi.setTheme(preferences.theme).catch(() => { /* Renderer palette remains available. */ });
    root.style.setProperty('--chat-font-size', `${preferences.fontSize}px`);
    const radii = RADIUS_PRESETS[preferences.radiusStyle] || RADIUS_PRESETS.standard;
    root.style.setProperty('--radius-tag', `${radii.tag}px`);
    root.style.setProperty('--radius-control', `${radii.control}px`);
    root.style.setProperty('--radius-card', `${radii.card}px`);
    root.style.setProperty('--radius-panel', `${radii.panel}px`);
    root.style.setProperty('--radius-round', `${radii.round}px`);
    if (preferences.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { root.dataset.theme = media.matches ? 'dark' : 'light'; };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  // ---------- 初始化与工作区数据 ----------

  /**
   * 拉取工作区与会话列表，并合并本地保存的手动排序。
   * 置顶会话始终排在前面，其余按主进程给出的 updatedAt 排序。
   */
  const loadState = useCallback(async () => {
    const loadGeneration = sessionLoadRef.current;
    setStateLoading(true);
    try {
      const next = await window.piApi.state(workspace);
      const savedWorkspaceOrder = workspaceOrderRef.current;
      const savedSessionOrder = sessionOrderRef.current;
      // 主进程给出的顺序是「最近活跃优先」，这里用本地保存的顺序覆盖它，
      // 再把新出现的工作区 / 会话追加到后面。
      const byCwd = new Map(next.workspaces.map((item) => [item.cwd, item]));
      const ordered = [
        ...savedWorkspaceOrder.flatMap((cwd) => byCwd.has(cwd) ? [byCwd.get(cwd)!] : []),
        ...next.workspaces.filter((item) => !savedWorkspaceOrder.includes(item.cwd)),
      ];
      const nextSessionOrder: Record<string, string[]> = {};
      const orderedSessions = ordered.map((item) => {
        const byId = new Map(item.sessions.map((entry) => [entry.id, entry]));
        const saved = savedSessionOrder[item.cwd] ?? [];
        const sessions = [
          ...saved.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
          ...item.sessions.filter((entry) => !saved.includes(entry.id)),
        ].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
        nextSessionOrder[item.cwd] = sessions.map((entry) => entry.id);
        return { ...item, sessions };
      });
      workspaceOrderRef.current = ordered.map((item) => item.cwd);
      sessionOrderRef.current = nextSessionOrder;
      setWorkspaceOrder(ordered.map((item) => item.cwd));
      setSessionOrder(nextSessionOrder);
      setWorkspaces(orderedSessions);
      setSession(current => {
        if (!current) return current;
        const title = orderedSessions.flatMap(item => item.sessions).find(item => item.id === current.id)?.title;
        return title && title !== current.title ? { ...current, title } : current;
      });
      setDefaultModelSelection(next.model);
      // 会话切换会使 generation 增长；旧请求不得覆盖已恢复的历史模型。
      if (!sessionRef.current && sessionLoadRef.current === loadGeneration) setModelSelection(next.model);
    } finally {
      setStateLoading(false);
    }
  }, [workspace]);

  // ---------- 设置页：数据与编辑弹窗 ----------

  /**
   * 打开设置页并刷新快照。
   * 设置页与对话共用同一个窗口，所以关闭后把焦点还给触发元素。
   */
  async function openSettings(tab?: typeof settingsTab) {
    if (!settingsOpen) settingsReturnFocusRef.current = document.activeElement as HTMLElement;
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
    setSettingsError(null);
    try {
      const [snapshot, modelResult] = await Promise.all([window.piApi.settings(workspace), window.piApi.models(workspace)]);
      setSettingsData(snapshot);
      setModels(modelResult.models);
      setEnabledModels(modelResult.enabled ?? []);
      setDefaultModelSelection(modelResult.defaultSelection ?? modelResult.selection);
      if (!sessionRef.current) setModelSelection(modelResult.defaultSelection ?? modelResult.selection);
    } catch (error) {
      setSettingsError(errorText(error));
    }
  }

  function closeEditor() {
    if (settingsBusy) return;
    editorRequestRef.current += 1;
    setEditor(null);
    setEditorError(null);
  }

  /**
   * 打开某个资源的编辑弹窗。
   * 用 request id 防竞态：用户在加载完成前关掉弹窗，旧请求的结果会被丢弃。
   */
  async function openEditor(kind: SettingsEditor['kind'], editId?: string, providerId?: string) {
    const request = ++editorRequestRef.current;
    setEditor({ kind, editId, providerId });
    setEditorError(null);
    setEditorLoading(Boolean(editId && (kind === 'provider' || kind === 'mcp')));
    setResourceScope('user');
    setPackageDraft('');
    setExtensionInstallMode('package');
    originalMcpArgsRef.current = null;
    setProviderDraft({ providerId: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', icon: '', modelsUrl: '' });
    setMcpDraft({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
    setCustomModel({ providerId: providerId || '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false, origin: 'configured' });
    try {
      if (kind === 'provider' && editId) {
        const config = await window.piApi.providerConfig(editId);
        if (request === editorRequestRef.current) setProviderDraft({ ...config, apiKey: '' });
      }
      if (kind === 'mcp' && editId) {
        const config = await window.piApi.mcpConfig(editId);
        if (request === editorRequestRef.current) {
          originalMcpArgsRef.current = config.args;
          setMcpDraft({ ...config, args: config.args.join('\n') });
        }
      }
      if (kind === 'model' && editId && providerId) {
        const model = providerModels[providerId]?.find((item) => item.model === editId);
        const config = settingsData?.customModels?.find((item) => item.providerId === providerId && item.modelId === editId);
        const effective = model || config;
        if (effective) setCustomModel({
          providerId,
          modelId: editId,
          name: effective.name || editId,
          contextWindow: effective.contextWindow?.toString() || '',
          maxTokens: effective.maxTokens?.toString() || '',
          supportsImages: Boolean(effective.supportsImages),
          reasoning: Boolean(effective.reasoning),
          origin: model?.origin || config?.origin || 'builtin',
        });
      }
    } catch (error) {
      if (request === editorRequestRef.current) setEditorError(errorText(error));
    } finally { if (request === editorRequestRef.current) setEditorLoading(false); }
  }

  function openModelEditor(providerId: string, model?: ProviderModelInfo) {
    void openEditor('model', model?.model, providerId);
  }

  async function refreshProviderModels(providerId: string) {
    const result = await window.piApi.providerModels(providerId);
    setProviderModels((current) => ({ ...current, [providerId]: result.models }));
    return result.models;
  }

  /** 展开某个来源下的模型列表；同一来源只请求一次。 */
  async function loadProviderModels(providerId: string) {
    if (expandedProvider === providerId) { setExpandedProvider(null); return; }
    setExpandedProvider(providerId);
    setModelQuery('');
    if (!providerModels[providerId]) {
      try {
        await refreshProviderModels(providerId);
      } catch (error) { setSettingsError(errorText(error)); }
    }
  }

  async function setEnabled(next: string[]) {
    setSettingsBusy(true); setSettingsError(null);
    try {
      const snapshot = await window.piApi.setEnabledModels(next);
      setSettingsData(snapshot);
      setEnabledModels(snapshot.enabledModels);
      setProviderModels((current) => Object.fromEntries(Object.entries(current).map(([providerId, list]) => [
        providerId,
        list.map((model) => ({ ...model, enabled: next.includes(model.id) })),
      ])));
    } catch (error) {
      setSettingsError(errorText(error));
    } finally { setSettingsBusy(false); }
  }

  /** 保存自定义模型，并刷新设置快照与模型目录。 */
  async function saveCustomModel() {
    setSettingsBusy(true); setEditorError(null);
    try {
      const snapshot = await window.piApi.addCustomModel({
        editing: Boolean(editor?.editId),
        providerId: customModel.providerId,
        modelId: customModel.modelId,
        name: customModel.name || customModel.modelId,
        contextWindow: Number(customModel.contextWindow) || undefined,
        maxTokens: Number(customModel.maxTokens) || undefined,
        supportsImages: customModel.supportsImages,
        reasoning: customModel.reasoning,
        origin: customModel.origin,
      });
      setSettingsData(snapshot);
      setEnabledModels(snapshot.enabledModels);
      setCustomModel({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false, origin: 'configured' });
      if (customModel.providerId) await refreshProviderModels(customModel.providerId);
      const catalog = await window.piApi.models(workspace);
      setModels(catalog.models);
      setEditor(null);
      await loadState();
    } catch (error) { setEditorError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function addPackage() {
    if (!packageDraft.trim()) return;
    setSettingsBusy(true); setEditorError(null);
    try {
      const snapshot = await window.piApi.addPackage(packageDraft.trim());
      setSettingsData(snapshot);
      setPackageDraft('');
      setEditor(null);
    } catch (error) { setEditorError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function removePackage(source: string) {
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removePackage(source)); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteMcp(name: string) {
    if (!window.confirm(`删除 MCP 服务器「${name}」？`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removeMcp(name)); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteExtension(extensionPath: string, name: string) {
    if (!window.confirm(`删除扩展「${name}」？`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removeExtension(extensionPath)); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteCustomModel(providerId: string, model: ProviderModelInfo) {
    const message = model.origin === 'override'
      ? `移除「${model.name}」的自定义配置，并恢复 Pi 内置参数？`
      : `从「${providerId}」删除模型「${model.name}」？`;
    if (!window.confirm(message)) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const snapshot = await window.piApi.removeCustomModel({ providerId, modelId: model.model });
      setSettingsData(snapshot);
      setEnabledModels(snapshot.enabledModels);
      await refreshProviderModels(providerId);
      setModels((await window.piApi.models(workspace)).models);
    } catch (error) { setSettingsError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  async function discoverProviderModels(providerId: string) {
    setProviderDiscovery((current) => ({ ...current, [providerId]: { loading: true } }));
    try {
      const result = await window.piApi.discoverProviderModels(providerId);
      setProviderDiscovery((current) => ({
        ...current,
        [providerId]: { endpoint: result.endpoint, models: result.models },
      }));
    } catch (error) {
      setProviderDiscovery((current) => ({
        ...current,
        [providerId]: { error: errorText(error) },
      }));
    }
  }

  async function importProviderModels(providerId: string, discovered: DiscoveredModel[]) {
    setProviderDiscovery((current) => ({
      ...current,
      [providerId]: { ...current[providerId], importing: true, error: undefined },
    }));
    try {
      const snapshot = await window.piApi.importProviderModels({ providerId, models: discovered });
      setSettingsData(snapshot);
      setEnabledModels(snapshot.enabledModels);
      await refreshProviderModels(providerId);
      setModels((await window.piApi.models(workspace)).models);
      setProviderDiscovery((current) => ({
        ...current,
        [providerId]: { ...current[providerId], importing: false, imported: discovered.length },
      }));
    } catch (error) {
      setProviderDiscovery((current) => ({
        ...current,
        [providerId]: { ...current[providerId], importing: false, error: errorText(error) },
      }));
    }
  }

  /** 保存模型来源（新建或编辑），完成后重建模型目录。 */
  async function saveProvider() {
    setSettingsBusy(true);
    setEditorError(null);
    try {
      const providerId = providerDraft.providerId.trim();
      const result = await window.piApi.addProvider({ ...providerDraft, editing: Boolean(editor?.editId) });
      setSettingsData(result.settings);
      setModels(result.models.models);
      setEnabledModels(result.models.enabled);
      setProviderDraft({ providerId: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', icon: '', modelsUrl: '' });
      setProviderModels((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      setProviderDiscovery((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      setEditor(null);
      setExpandedProvider(providerId);
      setModelQuery('');
      await refreshProviderModels(providerId);
      await loadState();
    } catch (error) {
      setEditorError(errorText(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  /**
   * 保存 MCP 服务器。
   * 编辑时如果参数文本没有改动就沿用原始数组，参数里的空格不会被重新切分。
   */
  async function saveMcp() {
    setSettingsBusy(true);
    setEditorError(null);
    try {
      const originalArgs = originalMcpArgsRef.current;
      const args = originalArgs && mcpDraft.args === originalArgs.join('\n') ? originalArgs : mcpDraft.args.split('\n').filter((arg) => arg.length > 0);
      const next = await window.piApi.addMcp({ ...mcpDraft, args, env: mcpDraft.env, originalName: editor?.editId });
      setSettingsData(next);
      setEditor(null);
      setMcpDraft({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
    } catch (error) {
      setEditorError(errorText(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  /** 从本机导入技能或扩展；取消选择时返回 undefined，不关闭弹窗。 */
  async function importResource(kind: 'skill' | 'extension', scope: 'user' | 'project') {
    setSettingsBusy(true);
    setEditorError(null);
    try {
      const next = kind === 'skill'
        ? await window.piApi.addSkill({ scope, cwd: workspace })
        : await window.piApi.addExtension({ scope, cwd: workspace });
      if (next) { setSettingsData(next); setEditor(null); }
    } catch (error) {
      setEditorError(errorText(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleMcp(name: string, enabled: boolean) {
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.setMcpEnabled({ name, enabled })); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  /** 供模型选择器使用：拉取目录并同步到本地状态。 */
  async function loadModelCatalog() {
    const result = await window.piApi.models(workspace);
    setModels(result.models);
    setEnabledModels(result.enabled ?? []);
    const nextDefault = result.defaultSelection ?? result.selection;
    setDefaultModelSelection(nextDefault);
    if (!sessionRef.current) setModelSelection(nextDefault);
    return result;
  }

  async function selectModel(next: string) {
    // 只要当前正在一条会话中，就只切换该会话的模型；新对话才更新默认值。
    if (session) {
      const result = await window.piApi.setSessionModel({ sessionId: session.id, modelRef: next });
      setModelSelection(result);
      return;
    }
    const result = await window.piApi.setDefaultModel(next, workspace);
    setDefaultModelSelection(result);
    setModelSelection(result);
  }

  async function selectThinking(level: ThinkingLevel) {
    // `/thinking` 和底部选择器都遵守同一范围：当前会话只写会话 transcript。
    if (session) {
      const result = await window.piApi.setSessionThinking({ sessionId: session.id, level });
      setModelSelection(result);
      return;
    }
    const result = await window.piApi.setDefaultThinkingLevel({ level, cwd: workspace });
    setDefaultModelSelection(result);
    setModelSelection(result);
  }

  /** 设置页明确修改新对话默认值，不误改当前打开的历史会话。 */
  async function selectDefaultModel(next: string) {
    if (defaultModelBusy) return;
    setDefaultModelBusy(true);
    setSettingsError(null);
    try {
      const result = await window.piApi.setDefaultModel(next, workspace);
      setDefaultModelSelection(result);
      if (!sessionRef.current) setModelSelection(result);
    } catch (error) {
      setSettingsError(errorText(error));
    } finally {
      setDefaultModelBusy(false);
    }
  }

  async function selectDefaultThinking(level: ThinkingLevel) {
    if (defaultModelBusy) return;
    setDefaultModelBusy(true);
    setSettingsError(null);
    try {
      const result = await window.piApi.setDefaultThinkingLevel({ level, cwd: workspace });
      setDefaultModelSelection(result);
      if (!sessionRef.current) setModelSelection(result);
    } catch (error) {
      setSettingsError(errorText(error));
    } finally {
      setDefaultModelBusy(false);
    }
  }

  // ---------- 本地持久化与启动恢复 ----------

  useEffect(() => { void loadState().catch((error) => setError(errorText(error))); }, [loadState]);

  useEffect(() => {
    workspaceOrderRef.current = workspaceOrder;
    writeStored(UI_KEYS.workspaceOrder, workspaceOrder);
  }, [workspaceOrder]);

  useEffect(() => {
    sessionOrderRef.current = sessionOrder;
    writeStored(UI_KEYS.sessionOrder, sessionOrder);
  }, [sessionOrder]);

  useEffect(() => {
    writeStored(UI_KEYS.expanded, [...expanded]);
  }, [expanded]);

  useEffect(() => {
    if (!restoredRef.current) return;
    writeStored(UI_KEYS.activeSession, session ? { id: session.id, cwd: session.cwd } : null);
  }, [session]);

  useEffect(() => {
    if (stateLoading || restoredRef.current || workspaces.length === 0) return;
    restoredRef.current = true;
    const saved = readStored<{ id: string; cwd: string } | null>(UI_KEYS.activeSession, null);
    if (!saved?.id) return;
    const summary = workspaces.flatMap((item) => item.sessions).find((item) => item.id === saved.id && !item.archived);
    if (!summary) return;
    setWorkspace(summary.cwd);
    setExpanded((current) => {
      if (current.has(summary.cwd)) return current;
      const next = new Set(current);
      next.add(summary.cwd);
      return next;
    });
    void openSession(summary);
  }, [stateLoading, workspaces]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; }
  }, [prompt]);

  // 读取扩展当前的批准方式；扩展未安装时 available=false，界面不显示入口。
  useEffect(() => {
    void window.piApi.modeGet()
      .then((state) => setPermission({ available: state.available, mode: state.mode }))
      .catch(() => { /* 扩展未安装或尚未初始化 */ });
  }, []);

  useEffect(() => {
    let active = true;
    void window.piApi.menuBarSettings()
      .then((settings) => { if (active && settings) setMenuBarPreference(settings); })
      .catch(() => { /* Menu-bar support is optional in browser-only development. */ });
    return () => { active = false; };
  }, []);

  // The updater lives in the main process so background checks continue while
  // the main window is hidden. The renderer mirrors its snapshot for all entry
  // points: brand button, app menu, tray menu and native notifications.
  useEffect(() => {
    let disposed = false;
    const applySnapshot = (next: UpdateSnapshot | undefined) => {
      if (disposed || !next || typeof next !== 'object') return;
      setUpdateSnapshot(next);
      if (next.state === 'downloaded') setUpdateDialogOpen(true);
    };
    void window.piApi.updateState?.().then(applySnapshot).catch(() => { /* Updater is optional in browser-only previews. */ });
    const offState = window.piApi.onUpdateState?.(applySnapshot) ?? (() => {});
    const offOpen = window.piApi.onOpenUpdate?.(() => setUpdateDialogOpen(true)) ?? (() => {});
    return () => {
      disposed = true;
      offState();
      offOpen();
    };
  }, []);

  // 扩展请求工具确认时，渲染进程负责显示统一样式的弹窗。
  useEffect(() => window.piApi.onConfirmRequest((request) => setConfirmRequest(request)), []);

  useEffect(() => window.piApi.onOpenSettings(() => { void openSettings(); }), [workspace]);
  useEffect(() => window.piApi.onOpenMain(() => { setSettingsOpen(false); }), []);
  useEffect(() => window.piApi.onOpenSession((target) => {
    if (!target?.id) return;
    const summary = workspaces
      .flatMap((item) => item.sessions)
      .find((item) => item.id === target.id)
      ?? {
        id: target.id,
        cwd: target.cwd,
        title: target.title || '会话',
        updatedAt: Date.now(),
        messageCount: 0,
      };
    setSettingsOpen(false);
    void openSession(summary);
  }), [workspaces]);

  useEffect(() => {
    if (!settingsOpen || editor) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, editor]);

  useEffect(() => { settingsContentRef.current?.scrollTo({ top: 0 }); }, [settingsTab, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) settingsReturnFocusRef.current?.focus();
  }, [settingsOpen]);

  // ---------- 扩展状态 ----------

  useLayoutEffect(() => {
    followBottomRef.current = true;
    userScrollIntentRef.current = false;
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = 0;
    }
    if (scrollIntentTimerRef.current !== null) {
      window.clearTimeout(scrollIntentTimerRef.current);
      scrollIntentTimerRef.current = null;
    }
    setTodoPanelOpen(false);
    setQueuedPrompts([]);
    setCompaction({ active: false });
  }, [session?.id]);

  useEffect(() => window.piApi.onSessionsChanged?.(() => { void loadState(); }), [loadState]);
  useEffect(() => window.piApi.onRuntimeRefresh((snapshot) => {
    const type = snapshot.status === 'error'
      ? 'error'
      : snapshot.status === 'partial'
        ? 'warning'
        : 'info';
    setExtensionToast({ message: snapshot.message, type });
  }), []);
  useEffect(() => window.piApi.onExtensionNotify(event => {
    if (event.sessionId === session?.id) setExtensionToast({ message: event.message, type: event.type });
  }), [session?.id]);

  // 扩展的工作状态：setWorkingMessage / setWorkingVisible。
  useEffect(() => {
    if (!session?.id) { setExtensionWorking({ message: '', visible: true }); return; }
    let disposed = false;
    void window.piApi.extensionState(session.id).then((state) => {
      if (!disposed && state?.working) setExtensionWorking(state.working);
    }).catch(() => { /* 扩展未绑定 */ });
    const off = window.piApi.onExtensionWorking?.((event) => {
      if (event.sessionId === session.id) setExtensionWorking(event.working);
    }) ?? (() => {});
    return () => { disposed = true; off(); };
  }, [session?.id]);

  // 把输入框文本同步给主进程，扩展的 getEditorText() 才能读到当前内容。
  useEffect(() => {
    if (!session?.id) return;
    const timer = window.setTimeout(() => window.piApi.editorTextChanged?.({ sessionId: session.id, text: prompt }), 80);
    return () => window.clearTimeout(timer);
  }, [prompt, session?.id]);

  // 扩展替换 / 插入输入框文本。
  useEffect(() => {
    if (!session?.id) return;
    const applySet = (event: { sessionId: string; text: string }) => {
      if (event.sessionId !== session.id) return;
      setPrompt(event.text);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        node?.focus();
        node?.setSelectionRange(event.text.length, event.text.length);
      });
    };
    const applyPaste = (event: { sessionId: string; text: string }) => {
      if (event.sessionId !== session.id) return;
      const node = textareaRef.current;
      const value = node?.value ?? '';
      const start = node?.selectionStart ?? value.length;
      const end = node?.selectionEnd ?? value.length;
      setPrompt((current) => current.slice(0, start) + event.text + current.slice(end));
      requestAnimationFrame(() => {
        node?.focus();
        node?.setSelectionRange(start + event.text.length, start + event.text.length);
      });
    };
    const offSet = window.piApi.onExtensionEditorSet?.(applySet) ?? (() => {});
    const offPaste = window.piApi.onExtensionEditorPaste?.(applyPaste) ?? (() => {});
    return () => { offSet(); offPaste(); };
  }, [session?.id]);

  useEffect(() => {
    if (!extensionToast) return;
    const timer = window.setTimeout(() => setExtensionToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [extensionToast]);

  // ---------- 流式消息 ----------

  // 主进程把 Pi 的流式事件转发到这里：按 requestId 过滤，只处理当前请求。
  // 同一条消息会以 message_start / message_update / message_end 多次到达，
  // 因此按 timestamp 就地更新，而不是每次追加。token 可能一帧内到达多次，
  // 这里先入队再按帧合并，避免每个 token 都触发一次完整的 Markdown 重渲染。
  useEffect(() => {
    let batch: Array<{ message: ChatMessage; type: StreamMessageType }> = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      setMessages((current) => pending.reduce((list, item) => mergeStreamMessage(list, item.message, item.type), current));
    };
    const flushNow = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
    };
    const schedule = (message: ChatMessage, type: StreamMessageType) => {
      batch.push({ message, type });
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const unsubscribe = window.piApi.onPrompt((event) => {
      if (event.requestId !== requestRef.current) return;
      if (event.message && (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end')) {
        const incoming = event.message;
        if (incoming.role === 'user') return;
        schedule(incoming, event.type);
        // 结束帧要立刻落地，否则下一轮的流式消息可能找不到要接续的气泡。
        if (event.type === 'message_end') flushNow();
      }
      if (event.type === 'run-attached') { setBusy(true); setError(null); }
      if (event.type === 'compaction-start' || event.type === 'compaction-interrupted') {
        setCompaction({ active: event.type === 'compaction-start' || event.compacting === true, reason: event.reason });
        setBusy(true);
        setError(null);
      }
      if (event.type === 'compaction-end') {
        // 压缩与问答是两个生命周期：结束后解除输入限制，busy 由整个回合收尾。
        setCompaction({ active: false });
        if (event.errorMessage) setError(event.errorMessage);
      }
      if (event.type === 'turn-diff' && event.diff) {
        setLiveDiff(event.diff);
        setSession((current) => current ? { ...current, turnDiffs: [...(current.turnDiffs ?? []).filter((diff) => diff.at !== event.diff!.at), event.diff!] } : current);
      }
      if (event.type === 'subagent-update' && event.children) {
        setSubagentChildren((current) => mergeSubagentChildren(current, event.children || []));
        setAgentView((current) => {
          if (current.kind !== 'child') return current;
          const latest = event.children?.find((child) => child.key === current.child.key);
          return latest ? { kind: 'child', child: mergeSubagentChild(current.child, latest) } : current;
        });
        setSubagentTranscript((current) => {
          if (!current) return current;
          const latest = event.children?.find((child) => child.key === current.child.key);
          return latest ? { ...current, child: mergeSubagentChild(current.child, latest) } : current;
        });
      }
      if (event.type === 'retry-start') {
        setRetryInfo({ attempt: event.attempt ?? 1, maxAttempts: event.maxAttempts ?? 1, errorMessage: event.errorMessage });
      }
      if (event.type === 'retry-end' && event.success) setRetryInfo(null);
      if (event.type === 'done') {
        flushNow();
        setRetryInfo(null);
        setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
        setBusy(false);
        setError(null);
        setCompaction({ active: false });
        void loadState();
        if (session?.id) {
          // completeRun 会先应用待切换模型；done 事件直接带回最终快照，
          // 无需为了清掉“下轮生效”而重新解析整份 transcript。
          if (event.model && sessionRef.current?.id === session.id) setModelSelection(event.model);
          void refreshOutline(session.id).then((outline) => {
            if (!outline) return;
            setOutlineItems(outline.items);
            setOutlineTotalMessages(outline.totalMessages);
            setOutlineActive((current) => Math.min(current, Math.max(0, outline.items.length - 1)));
          });
          void window.piApi.sessionSubagents(session.id).then((children) => {
            if (sessionRef.current?.id === session.id) setSubagentChildren(Array.isArray(children) ? children : []);
          }).catch(() => { /* A completed parent turn remains usable if fleet refresh fails. */ });
        }
      }
      if (event.type === 'error') {
        flushNow();
        setRetryInfo(null);
        setError(event.error || '执行失败，请重试');
        setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
        setBusy(false);
        setCompaction({ active: false });
      }
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [loadState, session?.id]);

  useEffect(() => {
    if (!session?.id || !busy || requestRef.current) return;
    let disposed = false, fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const detail = await window.piApi.session(session.id, Math.max(120, messages.length + 10));
        if (!disposed && detail && !requestRef.current) {
          setMessages(detail.messages);
          setBusy(Boolean(detail.running));
          setCompaction({ active: Boolean(detail.compacting) });
          if (detail.requestId) requestRef.current = detail.requestId;
        }
      } catch { /* Background snapshots may be temporarily unavailable. */ } finally { fetching = false; }
    }, 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [session?.id, busy]);

  useLayoutEffect(() => {
    // 消息提交后先在绘制前贴底；Markdown、图片或折叠区随后长高时，
    // ResizeObserver 会继续补一次，避免输出中途停在半截。
    if (agentView.kind !== 'conversation' || !followBottomRef.current) return;
    pinTranscriptToBottom();
  }, [messages, busy, agentView.kind]);

  useEffect(() => {
    if (agentView.kind !== 'conversation' || messages.length === 0) return;
    const content = chatContentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scheduleTranscriptPin();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [agentView.kind, session?.id, messages.length === 0]);

  useEffect(() => () => {
    if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
    if (scrollIntentTimerRef.current !== null) window.clearTimeout(scrollIntentTimerRef.current);
    if (outlineSyncRef.current !== null) window.clearTimeout(outlineSyncRef.current);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(syncOutlineActive);
    return () => cancelAnimationFrame(frame);
  }, [messages.length, session?.id, filesOpen]);

  useEffect(() => {
    if (filesOpen && workspace) void loadTree('');
  }, [filesOpen, workspace]);

  useEffect(() => {
    const root = panelTabsRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>('.panel-tab.is-active');
    if (!active) return;
    const rootRect = root.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const left = activeRect.left - rootRect.left + root.scrollLeft;
    const right = left + activeRect.width;
    if (left < root.scrollLeft) root.scrollTo({ left, behavior: 'smooth' });
    else if (right > root.scrollLeft + root.clientWidth) root.scrollTo({ left: right - root.clientWidth, behavior: 'smooth' });
  }, [activePanelTabId, panelTabs.length, filesOpen, panelSplit]);

  useEffect(() => {
    const root = panelTabsRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if (root.scrollWidth <= root.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      root.scrollLeft += event.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [filesOpen, panelTabs.length]);

  // ---------- 派生数据 ----------

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.cwd === workspace),
    [workspaces, workspace],
  );
  const visibleWorkspaces = workspaces.filter((item) => `${item.name} ${item.cwd} ${item.sessions.map((s) => s.title).join(' ')}`.toLowerCase().includes(workspaceQuery.toLowerCase()));
  const isNewConversation = messages.length === 0 && !busy;
  const allExpanded = workspaces.length > 0 && workspaces.every((item) => expanded.has(item.cwd));

  // ---------- 侧边栏：展开、排序与拖拽 ----------

  function toggleAllExpanded() {
    setExpanded(allExpanded ? new Set() : new Set(workspaces.map((item) => item.cwd)));
  }

  function expandWorkspace(cwd: string) {
    setExpanded((current) => {
      if (current.has(cwd)) return current;
      const next = new Set(current);
      next.add(cwd);
      return next;
    });
  }

  function makeDragPreview(event: React.DragEvent, label: string, kind: '工作区' | '会话' | '标签') {
    dragPreviewRef.current?.remove();
    const ghost = document.createElement('div');
    ghost.className = 'drag-preview';
    const tag = document.createElement('span');
    tag.className = 'drag-preview-kind';
    tag.textContent = kind;
    const text = document.createElement('span');
    text.className = 'drag-preview-label';
    text.textContent = label;
    ghost.append(tag, text);
    document.body.appendChild(ghost);
    dragPreviewRef.current = ghost;
    event.dataTransfer.setDragImage(ghost, 14, 18);
  }

  function clearDragState() {
    dragRef.current = null;
    setDraggingItem(null);
    setDropHint(null);
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
  }

  function markDropped(id: string) {
    setJustDropped(id);
    window.setTimeout(() => setJustDropped((current) => current === id ? null : current), 240);
  }

  function reorderWorkspaces(source: string, target: string) {
    if (source === target) return;
    const order = workspaces.map((item) => item.cwd);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setWorkspaceOrder(order);
    setWorkspaces((current) => order.flatMap((cwd) => current.find((item) => item.cwd === cwd) ?? []));
    markDropped(`w:${target}`);
  }

  function reorderSessions(cwd: string, source: string, target: string) {
    if (source === target) return;
    const workspace = workspaces.find((item) => item.cwd === cwd);
    if (!workspace) return;
    const order = workspace.sessions.map((item) => item.id);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setSessionOrder((current) => ({ ...current, [cwd]: order }));
    markDropped(`s:${cwd}:${target}`);
    setWorkspaces((current) => current.map((item) => item.cwd === cwd
      ? { ...item, sessions: order.flatMap((id) => item.sessions.find((entry) => entry.id === id) ?? []) }
      : item));
  }


  /** 把一次超长粘贴保存成文本附件，只转换这一批内容。 */
  async function attachPastedText(text: string): Promise<boolean> {
    try {
      const saved = await window.piApi.saveAttachment({ sessionId: session?.id || 'draft', text });
      setComposerAttachments((current) => [...current, {
        id: crypto.randomUUID(), kind: 'file', name: saved.name, mime: saved.mime || 'text/plain',
        bytes: saved.bytes, lines: saved.lines, path: saved.path, marker: saved.marker,
      }]);
      return true;
    } catch {
      return false;
    }
  }

  /** 向前加载更早的历史；保持当前滚动位置不跳。 */
  async function loadOlderHistory() {
    if (!session || historyLoadingRef.current) return;
    const sessionId = session.id;
    const loadGeneration = sessionLoadRef.current;
    const requestId = ++historyRequestRef.current;
    const node = scrollRef.current;
    historyAnchorRef.current = node ? { sessionId, bottomOffset: node.scrollHeight - node.scrollTop } : null;
    historyArmedRef.current = false;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const previousCount = messages.length;
      const firstSourceIndex = messages.find((message) => typeof message.sourceIndex === 'number')?.sourceIndex;
      const nextLimit = outlineTotalMessages > 0 && firstSourceIndex !== undefined
        ? outlineTotalMessages - Math.max(0, firstSourceIndex - HISTORY_PAGE_SIZE)
        : messages.length + HISTORY_PAGE_SIZE;
      const detail = await window.piApi.session(sessionId, nextLimit);
      if (requestId !== historyRequestRef.current || loadGeneration !== sessionLoadRef.current) return;
      if (!detail) return;
      setMessages(detail.messages.map((message) => ({ ...message })));
      // 若这次没有取到更多消息，直接收口，避免滚动到顶部反复请求。
      setSession((current) => current?.id === sessionId
        ? {
            ...current,
            hasMore: detail.hasMore && detail.messages.length > previousCount,
            messageStart: detail.messageStart,
            totalMessages: detail.totalMessages ?? outlineTotalMessages,
          }
        : current);
    } catch (error) {
      if (requestId === historyRequestRef.current && loadGeneration === sessionLoadRef.current) setError(errorText(error));
    } finally {
      if (requestId === historyRequestRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    if (!anchor || anchor.sessionId !== session?.id) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight - anchor.bottomOffset;
    historyAnchorRef.current = null;
  }, [messages, session?.id]);

  // 跨页跳转要等目标消息真正挂载后再测位置；auto 避免长距离平滑滚动途经大量内容。
  useLayoutEffect(() => {
    const pending = pendingOutlineJumpRef.current;
    if (!pending || pending.sessionId !== session?.id) return;
    const targetLoaded = messages.some((message) => message.sourceIndex === pending.sourceIndex);
    if (!targetLoaded) return;
    if (scrollToOutlineItem(pending.index, 'auto')) pendingOutlineJumpRef.current = null;
  }, [messages, session?.id]);

  // ---------- 会话生命周期 ----------

  /**
   * 开始一个新会话（草稿态）。
   * 会话真正落盘发生在第一次发送消息时，所以这里只清空本地状态并选中工作区。
   */
  async function startSession(cwd = session?.cwd || workspace) {
    ++sessionLoadRef.current;
    ++outlineRequestRef.current;
    ++subagentRequestRef.current;
    requestRef.current = '';
    setSessionLoading(false);
    setSession(null);
    setMessages([]);
    setAgentView({ kind: 'conversation' });
    setSubagentChildren([]);
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(false);
    setOutlineItems([]);
    setOutlineTotalMessages(0);
    setOutlineActive(0);
    setOutlineHover(null);
    pendingOutlineJumpRef.current = null;
    setError(null);
    setPrompt('');
    setWorkspace(cwd);
    if (cwd) expandWorkspace(cwd);
    setComposerAttachments([]);
    setComposerMenu(null);
    setModelPickerRequest(null);
    setModelSelection(defaultModelSelection);
    if (!defaultModelSelection.modelRef) void loadModelCatalog().catch(() => {});
    setQueuedPrompts([]);
    setBusy(false);
    setRetryInfo(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectDraftWorkspace(cwd: string) {
    ++sessionLoadRef.current;
    ++outlineRequestRef.current;
    ++subagentRequestRef.current;
    setSessionLoading(false);
    setSession(null);
    setAgentView({ kind: 'conversation' });
    setSubagentChildren([]);
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(false);
    setOutlineItems([]);
    setOutlineTotalMessages(0);
    setOutlineActive(0);
    setOutlineHover(null);
    pendingOutlineJumpRef.current = null;
    setWorkspace(cwd);
    setComposerMenu(null);
    setModelPickerRequest(null);
    setModelSelection(defaultModelSelection);
    if (!defaultModelSelection.modelRef) void loadModelCatalog().catch(() => {});
    setError(null);
    if (cwd) expandWorkspace(cwd);
  }

  /** 悬停时预取会话详情，点击时通常已经命中主进程缓存。 */
  function prefetchSession(id: string) {
    if (prefetchedSessionsRef.current.has(id)) return;
    prefetchedSessionsRef.current.add(id);
    void window.piApi.session(id).catch(() => { /* prefetch is best effort */ });
  }

  /** 安装完整大纲，并把当前标记落在已加载窗口的最后一条提问。 */
  function applyOutline(data: OutlineData | undefined, loadedMessages: ChatMessage[], fallbackStart = 0) {
    const next = data ?? outlineFromMessages(loadedMessages, fallbackStart);
    setOutlineItems(next.items);
    setOutlineTotalMessages(next.totalMessages);
    setOutlineActive(lastLoadedOutlineIndex(next, loadedMessages));
  }

  /**
   * 刷新独立大纲。大纲请求受会话代数保护，快速切换会话时旧结果不会写回。
   */
  async function refreshOutline(sessionId: string, generation = sessionLoadRef.current): Promise<OutlineData | undefined> {
    const request = ++outlineRequestRef.current;
    try {
      const data = await window.piApi.sessionOutline(sessionId);
      if (request !== outlineRequestRef.current || generation !== sessionLoadRef.current) return undefined;
      if (!data) return undefined;
      return { items: data.items, totalMessages: data.totalMessages };
    } catch {
      return undefined;
    }
  }

  /**
   * 侧边栏操作（重命名 / 置顶 / 归档 / 分叉 / 删除工作区）。
   * 操作完成后统一刷新列表；分叉会额外打开新会话。
   */
  async function sidebarAction(kind: 'workspace' | 'session', id: string, action: SidebarAction, name?: string) {
    const result = await window.piApi.sidebarAction({ kind, id, action, name });
    if (kind === 'workspace' && action === 'remove' && workspace === id) await startSession('');
    if (kind === 'session' && action === 'archive' && session?.id === id) await startSession(session.cwd);
    if (kind === 'session' && action === 'rename' && session?.id === id) setSession(current => current ? { ...current, title: name!.trim() } : current);
    await loadState();
    if (action === 'fork' && result.id && result.cwd) await openSession({ id: result.id, cwd: result.cwd, title: result.title || '分叉会话', updatedAt: Date.now(), messageCount: 0 });
  }

  /**
   * 打开历史会话。
   * 用递增的 sessionLoadRef 丢弃过期结果，避免快速切换时串会话。
   */
  async function openSession(item: PiSessionSummary) {
    requestRef.current = '';
    const load = ++sessionLoadRef.current;
    const outlineRequest = ++outlineRequestRef.current;
    pendingOutlineJumpRef.current = null;
    setSessionLoading(true);
    try {
      const [detail, outline, children] = await Promise.all([
        window.piApi.session(item.id, HISTORY_PAGE_SIZE),
        window.piApi.sessionOutline(item.id).catch(() => undefined),
        window.piApi.sessionSubagents(item.id).catch(() => [] as SubagentChild[]),
      ]);
      if (load !== sessionLoadRef.current) return;
      if (!detail) {
        // 侧边栏里的旧条目可能已经被删除或移动；刷新列表，避免用户停在一个空入口。
        setError('这个会话已经不存在，列表已刷新。');
        void loadState().catch(() => { /* 列表刷新失败时保留错误提示 */ });
        return;
      }
      setSession({
        id: detail.id,
        cwd: detail.cwd,
        title: detail.title,
        turnDiffs: detail.turnDiffs,
        hasMore: detail.hasMore,
        messageStart: detail.messageStart,
        totalMessages: detail.totalMessages,
      });
      if (detail.model) setModelSelection(detail.model);
      setMessages(detail.messages.map((message) => ({ ...message })));
      // 旧版本 IPC 或尚未启用子 Agent 的会话可能返回空值；会话页仍必须可用。
      setSubagentChildren(Array.isArray(children) ? children : []);
      setSubagentTranscript(null);
      setSubagentError(null);
      setSubagentLoading(false);
      setAgentView({ kind: 'conversation' });
      if (outlineRequest === outlineRequestRef.current) {
        applyOutline(outline ? { items: outline.items, totalMessages: outline.totalMessages } : undefined, detail.messages, detail.messageStart);
      }
      setHistoryLoading(false);
      setWorkspace(detail.cwd);
      expandWorkspace(detail.cwd);
      setModelPickerRequest(null);
      setError(null);
      requestRef.current = detail.requestId || '';
      setBusy(Boolean(detail.running));
      setCompaction({ active: Boolean(detail.compacting) });
      setRetryInfo(null);
    } catch (error) {
      if (load === sessionLoadRef.current) {
        setError(errorText(error));
        void loadState().catch(() => { /* 列表刷新失败时保留错误提示 */ });
      }
    } finally {
      if (load === sessionLoadRef.current) setSessionLoading(false);
    }
  }

  function rememberMainScrollPosition() {
    if (agentView.kind === 'conversation') {
      mainScrollPositionRef.current = scrollRef.current?.scrollTop ?? mainScrollPositionRef.current;
    }
  }

  function returnToMainAgent() {
    if (agentView.kind === 'conversation') return;
    setAgentView({ kind: 'conversation' });
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = mainScrollPositionRef.current;
    });
  }

  function openAgentOverview() {
    if (!session?.id || subagentChildren.length === 0) return;
    rememberMainScrollPosition();
    setAgentView({ kind: 'agents' });
  }

  function openAgentTranscript(child: SubagentChild) {
    if (!session?.id || !child.hasTranscript) {
      setSubagentError('这个子 Agent 没有可安全读取的本地会话。');
      return;
    }
    rememberMainScrollPosition();
    const request = ++subagentRequestRef.current;
    const sessionId = session.id;
    setAgentView({ kind: 'child', child });
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(true);
    void window.piApi.subagentTranscript({ sessionId, childKey: child.key })
      .then((transcript) => {
        if (request !== subagentRequestRef.current || sessionRef.current?.id !== sessionId) return;
        setSubagentTranscript((current) => current
          ? { ...transcript, child: mergeSubagentChild(current.child, transcript.child) }
          : transcript);
        setAgentView((current) => current.kind === 'child'
          ? { kind: 'child', child: mergeSubagentChild(current.child, transcript.child) }
          : current);
      })
      .catch((cause) => {
        if (request === subagentRequestRef.current && sessionRef.current?.id === sessionId) {
          setSubagentError(errorText(cause));
        }
      })
      .finally(() => {
        if (request === subagentRequestRef.current && sessionRef.current?.id === sessionId) setSubagentLoading(false);
      });
  }

  useEffect(() => {
    if (agentView.kind !== 'child' || !session?.id || subagentLoading) return;
    if (!['pending', 'running', 'paused'].includes(agentView.child.status)) return;
    let disposed = false;
    let fetching = false;
    const sessionId = session.id;
    const childKey = agentView.child.key;
    const timer = window.setInterval(() => {
      if (fetching) return;
      fetching = true;
      void window.piApi.subagentTranscript({ sessionId, childKey })
        .then((transcript) => {
          if (disposed || sessionRef.current?.id !== sessionId) return;
          setSubagentTranscript((current) => current
            ? { ...transcript, child: mergeSubagentChild(current.child, transcript.child) }
            : transcript);
          setSubagentError(null);
          setAgentView((current) => current.kind === 'child' && current.child.key === childKey
            ? { kind: 'child', child: transcript.child }
            : current);
        })
        .catch((cause) => {
          if (!disposed) setSubagentError(errorText(cause));
        })
        .finally(() => { fetching = false; });
    }, 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [agentView.kind, agentView.kind === 'child' ? agentView.child.key : '', agentView.kind === 'child' ? agentView.child.status : '', session?.id, subagentLoading]);

  // ---------- 附件 ----------

  /** 读取浏览器 File 的 base64 内容（去掉 data URL 前缀）。 */
  function readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function addComposerFiles(files: File[]) {
    for (const file of files) {
      if (file.size > 20_000_000) { setError(`文件「${file.name}」超过 20MB`); continue; }
      try {
        if (file.type.startsWith('image/')) {
          const data = await readFileBase64(file);
          setComposerAttachments((current) => [...current, { id: crypto.randomUUID(), kind: 'image', name: file.name || 'image.png', mime: file.type || 'image/png', bytes: file.size, data }]);
        } else {
          const data = await readFileBase64(file);
          const saved = await window.piApi.saveUpload({ sessionId: session?.id, name: file.name || 'attachment', mime: file.type, data });
          setComposerAttachments((current) => [...current, { ...saved, id: crypto.randomUUID() }]);
        }
      } catch (error) { setError(errorText(error)); }
    }
  }

  async function pickComposerAttachments() {
    try {
      const result = await window.piApi.pickAttachments({ sessionId: session?.id });
      setComposerAttachments((current) => [...current, ...result.attachments]);
    } catch (error) { setError(errorText(error)); }
  }

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  async function checkUpdates(): Promise<void> {
    try {
      const next = await window.piApi.checkForUpdates({ interactive: true });
      if (next) setUpdateSnapshot(next);
    } catch (error) {
      setUpdateSnapshot(current => ({ ...current, state: 'error', error: errorText(error) }));
    }
  }

  async function downloadUpdate(): Promise<void> {
    try {
      const next = await window.piApi.downloadUpdate();
      if (next) setUpdateSnapshot(next);
    } catch (error) {
      setUpdateSnapshot(current => ({ ...current, state: 'error', error: errorText(error) }));
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await window.piApi.installUpdate();
    } catch (error) {
      setUpdateSnapshot(current => ({ ...current, state: 'error', error: errorText(error) }));
    }
  }

  function openUpdateDialog() {
    setUpdateDialogOpen(true);
    if (updateSnapshot.state === 'idle') void checkUpdates();
  }

  async function chooseBackground() {
    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      const media = await window.piApi.chooseBackgroundMedia({ replaceUrl: preferences.backgroundMedia?.url });
      if (media) updatePreference('backgroundMedia', media);
    } catch (error) {
      setBackgroundError(errorText(error));
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function removeBackground() {
    const media = preferences.backgroundMedia;
    if (!media) return;
    setBackgroundBusy(true);
    setBackgroundError(null);
    updatePreference('backgroundMedia', null);
    try {
      await window.piApi.removeBackgroundMedia(media.url);
    } catch (error) {
      setBackgroundError(errorText(error));
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function changeMenuBarVisibility(enabled: boolean) {
    if (menuBarBusy || !menuBarPreference.available) return;
    const previous = menuBarPreference;
    setMenuBarBusy(true);
    setMenuBarPreference((current) => ({ ...current, enabled }));
    try {
      const next = await window.piApi.setMenuBarVisible(enabled);
      if (next) setMenuBarPreference(next);
    } catch (error) {
      setMenuBarPreference(previous);
      setSettingsError(errorText(error));
    } finally {
      setMenuBarBusy(false);
    }
  }

  function handleBackgroundUnavailable(url: string) {
    setPreferences((current) => current.backgroundMedia?.url === url ? { ...current, backgroundMedia: null } : current);
    setBackgroundError('背景文件已不可用，请重新选择。');
    void window.piApi.removeBackgroundMedia(url).catch(() => {});
  }

  /** 真正应用权限模式：先乐观更新，失败时回滚并提示。 */
  async function applyPermission(mode: PermissionMode) {
    const previous = permission;
    setPermission((current) => ({ ...current, mode }));
    try {
      await window.piApi.modeSet({ mode, sessionId: session?.id });
    } catch (error) {
      setPermission(previous);
      setError(errorText(error));
    }
  }

  /** 切换权限模式：选择「完全权限」时先要求确认风险。 */
  async function changePermission(mode: PermissionMode) {
    if (mode === 'full' && permission.mode !== 'full') {
      setFullPermissionAck(false);
      setFullPermissionOpen(true);
      return;
    }
    await applyPermission(mode);
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  // ---------- 输入建议（/ 命令与 @ 文件） ----------

  /**
   * 根据光标位置判断是否弹出建议菜单：
   *  - 行首的 `/` → 命令与技能
   *  - 空白后的 `@` → 工作区文件或目录
   */
  function updateComposerMenu(value: string, caret: number) {
    const before = value.slice(0, caret);
    const slash = before.match(/(?:^|\s)\/([^\s]*)$/);
    if (slash) {
      const start = caret - slash[1].length - 1;
      const next = { kind: 'slash' as const, query: slash[1], start, end: caret };
      setComposerMenu((current) => current?.kind === next.kind && current.query === next.query && current.start === next.start && current.end === next.end ? current : next);
      setComposerMenuIndex(0);
      return;
    }
    const at = before.match(/(?:^|\s)@([^\s]*)$/);
    if (at) {
      const start = caret - at[1].length - 1;
      const next = { kind: 'file' as const, query: at[1], start, end: caret };
      setComposerMenu((current) => current?.kind === next.kind && current.query === next.query && current.start === next.start && current.end === next.end ? current : next);
      setComposerMenuIndex(0);
      return;
    }
    setComposerMenu(null);
  }

  /** 请求输入框底部的模型选择器直接打开某个原生子视图。 */
  function requestModelPicker(view: ModelPickerRequest['view']) {
    modelPickerRequestRef.current += 1;
    setModelPickerRequest({ id: modelPickerRequestRef.current, view });
  }

  /**
   * 执行 Studio 原生斜杠命令；不是原生命令时返回 false，交给 Pi。
   *
   * 扩展命令、Prompt 与 Skill 不进入这个路由表，因此始终保留原命令名、
   * 参数和当前会话上下文，由 Pi 自己解析。
   */
  async function executeBuiltinCommand(input: string): Promise<boolean> {
    const command = parseStudioCommand(input);
    if (!command) return false;

    if (command.route === 'session.new') {
      if (busy) {
        setExtensionToast({ message: '当前回复还在进行中，结束后再开始新对话。', type: 'info' });
        return true;
      }
      await startSession();
      return true;
    }
    if (command.route === 'settings.open') { await openSettings(); return true; }
    if (command.route === 'settings.mcp') { await openSettings('mcp'); return true; }
    if (command.route === 'model.picker') {
      if (stateLoading || sessionLoading) {
        setExtensionToast({ message: '请等待当前会话加载完成后再切换模型。', type: 'info' });
        return true;
      }
      if (command.argument) {
        try { await selectModel(command.argument); }
        catch (error) { setExtensionToast({ message: errorText(error), type: 'error' }); }
      } else {
        requestModelPicker('models');
      }
      return true;
    }
    if (command.route === 'thinking.picker') {
      if (!session) {
        setExtensionToast({ message: '先进入一条对话，再调整这个会话的思考强度。', type: 'info' });
        return true;
      }
      if (busy || stateLoading || sessionLoading) {
        setExtensionToast({ message: '请等待当前回复完成后再调整思考强度。', type: 'info' });
        return true;
      }
      if (!command.argument) {
        requestModelPicker('thinking');
        return true;
      }
      const normalized = normalizeThinkingLevelArgument(command.argument);
      const level = normalized as ThinkingLevel | null;
      if (!level || !modelSelection.thinkingLevels.includes(level)) {
        const available = modelSelection.thinkingLevels.map((item) => thinkingLabels[item]).join('、');
        setExtensionToast({ message: `当前模型可用等级：${available || 'Default'}`, type: 'warning' });
        return true;
      }
      try {
        await selectThinking(level);
        setExtensionToast({ message: `当前会话的思考强度已切换为 ${thinkingLabels[level]}。`, type: 'info' });
      } catch (error) {
        setExtensionToast({ message: errorText(error), type: 'error' });
      }
      return true;
    }
    if (command.route === 'assistant.copy') {
      const last = [...messages].reverse().find((message) => message.role === 'assistant');
      const text = last ? textOfBlocks(last.content) : '';
      if (text) {
        await navigator.clipboard.writeText(text);
      } else {
        setExtensionToast({ message: '当前会话还没有可复制的助理回复。', type: 'info' });
      }
      return true;
    }
    return false;
  }

  function selectComposerOption(index: number) {
    const menu = composerMenu;
    if (!menu) return;
    const caret = menu.end;
    if (menu.kind === 'file') {
      const file = composerFileOptions[index];
      if (!file) return;
      const inserted = `@${file.path}${file.type === 'directory' ? '/' : ''} `;
      const next = `${prompt.slice(0, menu.start)}${inserted}${prompt.slice(caret)}`;
      const nextCaret = menu.start + inserted.length;
      setPrompt(next);
      setComposerMenu(null);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(nextCaret, nextCaret); });
      return;
    }
    const command = composerCommandOptions[index];
    if (!command) return;
    if (command.source === 'builtin') {
      setComposerMenu(null);
      setPrompt('');
      setComposerMenuIndex(0);
      void executeBuiltinCommand(`/${command.name}`);
      return;
    }
    const inserted = `/${command.name} `;
    const next = `${prompt.slice(0, menu.start)}${inserted}${prompt.slice(caret)}`;
    const nextCaret = menu.start + inserted.length;
    setPrompt(next);
    setComposerMenu(null);
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(nextCaret, nextCaret); });
  }

  useEffect(() => {
    if (composerMenu?.kind !== 'slash') return;
    const request = ++composerResourcesRequestRef.current;
    setComposerMenuLoading(true);
    window.piApi.composerResources({ sessionId: session?.id, cwd: workspace })
      .then((result) => { if (request === composerResourcesRequestRef.current) setComposerCommands(result.commands); })
      .catch(() => { if (request === composerResourcesRequestRef.current) setComposerCommands([]); })
      .finally(() => { if (request === composerResourcesRequestRef.current) setComposerMenuLoading(false); });
  }, [composerMenu?.kind, session?.id, workspace]);

  useEffect(() => {
    if (composerMenu?.kind !== 'file') return;
    if (!workspace) { setComposerFiles([]); setComposerMenuLoading(false); return; }
    const request = ++composerFileRequestRef.current;
    setComposerMenuLoading(true);
    const timer = window.setTimeout(() => {
      window.piApi.searchFiles({ cwd: workspace, query: composerMenu.query })
        .then((result) => { if (request === composerFileRequestRef.current) setComposerFiles(result.files); })
        .catch(() => { if (request === composerFileRequestRef.current) setComposerFiles([]); })
        .finally(() => { if (request === composerFileRequestRef.current) setComposerMenuLoading(false); });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [composerMenu?.kind, composerMenu?.query, workspace]);

  useEffect(() => { setComposerMenuIndex(0); }, [composerMenu?.kind, composerMenu?.query, composerCommands, composerFiles]);

  // 键盘上下移动时把当前项滚进可视区，避免长列表里选中项在视野外。
  useEffect(() => {
    if (!composerMenu) return;
    composerWrapRef.current?.querySelector<HTMLElement>('.composer-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [composerMenu, composerMenuIndex]);

  useEffect(() => {
    if (!composerMenu) return;
    const onPointer = (event: PointerEvent) => { if (!composerWrapRef.current?.contains(event.target as Node)) setComposerMenu(null); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [composerMenu]);

  function syncOutlineActive() {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top + 14;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('.messages > .message.user[id^="chat-turn-"]'))
      .filter((node) => /^chat-turn-\d+$/.test(node.id));
    if (nodes.length === 0) {
      setOutlineActive(0);
      return;
    }

    // The transcript is in source order, so locate the last visible turn with
    // one binary search instead of measuring every outline target per frame.
    let low = 0;
    let high = nodes.length - 1;
    let visible = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (nodes[middle].getBoundingClientRect().top <= top) {
        visible = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const activeNode = nodes[visible >= 0 ? visible : 0];
    const sourceIndex = Number(activeNode.id.slice('chat-turn-'.length));
    const resolved = outlineItems.findIndex((item) => item.sourceIndex === sourceIndex);
    if (resolved >= 0) setOutlineActive((current) => current === resolved ? current : resolved);
  }

  /**
   * 滚动期间把大纲同步合并到低频任务里。滚动本身优先交付给合成器，
   * 停顿后再做一次 DOM 测量，避免长会话里每帧强制布局。
   */
  function scheduleOutlineSync() {
    if (outlineSyncRef.current !== null) return;
    outlineSyncRef.current = window.setTimeout(() => {
      outlineSyncRef.current = null;
      syncOutlineActive();
    }, 80);
  }

  /** 只有明确的用户滚动意图才能离开或重新进入贴底跟随。 */
  function handleTranscriptScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const nextTop = node.scrollTop;
    const nextFollow = resolveAutoFollow({
      following: followBottomRef.current,
      nearBottom: isNearBottom(node),
      userInitiated: userScrollIntentRef.current,
      movedTowardStart: nextTop < lastTranscriptScrollTopRef.current - 0.5,
    });
    if (nextFollow !== followBottomRef.current) {
      if (nextFollow) resumeTranscriptFollow();
      else pauseTranscriptFollow();
    }
    lastTranscriptScrollTopRef.current = nextTop;
    const next = resolveHistoryScroll({
      scrollTop: nextTop,
      armed: historyArmedRef.current,
      hasMore: Boolean(session?.hasMore),
      loading: historyLoadingRef.current,
      userInitiated: historyUserScrollRef.current,
    });
    historyUserScrollRef.current = false;
    historyArmedRef.current = next.armed;
    if (next.load) void loadOlderHistory();
    scheduleOutlineSync();
  }

  function scrollToOutlineItem(index: number, behavior: ScrollBehavior = 'smooth') {
    const item = outlineItems[index];
    const container = scrollRef.current;
    const node = item ? document.getElementById(`chat-turn-${item.sourceIndex}`) : null;
    if (!item || !container || !node) return false;
    // 大纲跳转表示用户主动离开底部阅读，流式更新不能再把视图拉回最新消息。
    pauseTranscriptFollow();
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + delta - 12, behavior });
    setOutlineActive(index);
    return true;
  }

  /**
   * 点击大纲：当前窗口已有节点就直接滚动；旧提问尚未加载时，只补载从目标
   * 提问到最新消息所需的窗口，然后由 layout effect 在 DOM 提交后精确定位。
   */
  async function jumpToOutline(index: number) {
    const item = outlineItems[index];
    if (!item || !session) return;
    if (scrollToOutlineItem(index)) return;

    const sessionId = session.id;
    const loadGeneration = sessionLoadRef.current;
    const requestId = ++historyRequestRef.current;
    const totalMessages = Math.max(outlineTotalMessages, session.totalMessages ?? 0, item.sourceIndex + 1);
    const limit = Math.max(HISTORY_PAGE_SIZE, totalMessages - item.sourceIndex);
    pendingOutlineJumpRef.current = { sessionId, sourceIndex: item.sourceIndex, index };
    historyAnchorRef.current = null;
    historyArmedRef.current = false;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setOutlineActive(index);
    try {
      const detail = await window.piApi.session(sessionId, limit);
      if (requestId !== historyRequestRef.current || loadGeneration !== sessionLoadRef.current) return;
      if (!detail) {
        pendingOutlineJumpRef.current = null;
        setError('这条提问对应的历史消息已经不可用。');
        return;
      }
      setMessages(detail.messages.map((message) => ({ ...message })));
      setSession((current) => current?.id === sessionId
        ? {
            ...current,
            hasMore: detail.hasMore,
            messageStart: detail.messageStart,
            totalMessages: detail.totalMessages ?? totalMessages,
          }
        : current);
    } catch (error) {
      if (requestId === historyRequestRef.current && loadGeneration === sessionLoadRef.current) {
        pendingOutlineJumpRef.current = null;
        setError(errorText(error));
      }
    } finally {
      if (requestId === historyRequestRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  // ---------- 发送与排队 ----------

  /**
   * 组装一次提交：
   *  - 超长文本落盘为附件（界面显示摘要，模型收到标记）
   *  - 附件文件与图片分别转成标记 / 图片块
   *  - 从文本里解析 @ 引用，交给主进程读取文件内容
   */
  async function prepareSubmission(text: string, attachments: ComposerAttachment[], sessionId: string): Promise<PreparedSubmission> {
    const files = attachments.filter((attachment) => attachment.kind === 'file');
    const images = attachments.filter((attachment) => attachment.kind === 'image');
    let displayText = text;
    let outgoingText = text;
    let longAttachments: ChatMessage['attachments'] = [];
    // 超长文本：落盘为附件，界面只展示摘要，模型收到的是附件标记。
    if (text && isLongMessage(text)) {
      try {
        const saved = await window.piApi.saveAttachment({ sessionId, text });
        outgoingText = saved.promptText;
        displayText = saved.notice;
        longAttachments = [{ name: saved.name, path: saved.path, bytes: saved.bytes, lines: saved.lines, kind: 'text', mime: 'text/plain' }];
      } catch { /* fall back to inline text */ }
    }
    const fileAttachments = files.map((file) => ({ name: file.name, path: file.path as string, bytes: file.bytes, lines: file.lines || 0, kind: 'file' as const, mime: file.mime }));
    const markers = files.map((file) => file.marker).filter(Boolean) as string[];
    if (markers.length > 0) outgoingText = [outgoingText, ...markers].filter(Boolean).join('\n\n');
    if (!displayText) {
      displayText = files.length > 0 ? '请查看附件。' : images.length > 0 ? '请查看图片。' : '';
      if (!text) outgoingText = [displayText, ...markers].filter(Boolean).join('\n\n');
    }
    const content: ChatMessage['content'] = [];
    if (displayText) content.push({ type: 'text', text: displayText });
    for (const image of images) {
      if (image.data) content.push({ type: 'image', data: image.data, mimeType: image.mime });
    }
    const persistentAttachments = [...(longAttachments ?? []), ...fileAttachments];
    const imagePayload = images.filter((image) => image.data).map((image) => ({ type: 'image' as const, data: image.data as string, mimeType: image.mime }));
    const mentions = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]);
    return { sessionId, displayText, outgoingText, content, persistentAttachments, imagePayload, mentions, attachmentPaths: persistentAttachments.map((attachment) => attachment.path) };
  }

  /**
   * 真正发出消息。
   *  - steer：插话到正在运行的任务，不进入排队
   *  - prompt：正常发送，先乐观插入用户消息，结束后用主进程返回的历史校准
   */
  async function dispatchSubmission(submission: PreparedSubmission, mode: 'prompt' | 'steer') {
    if (compaction.active) {
      setExtensionToast({ message: '上下文正在压缩，完成后会自动继续。', type: 'info' });
      return;
    }
    resumeTranscriptFollow();
    // 先乐观插入用户消息，避免等待 IPC 时输入区看起来没反应。
    setMessages((existing) => [...existing, {
      role: 'user',
      content: submission.content,
      timestamp: Date.now(),
      ...(submission.persistentAttachments.length > 0 ? { attachments: submission.persistentAttachments } : {}),
    }]);
    if (mode === 'steer') {
      try {
        await window.piApi.queuePrompt({
          sessionId: submission.sessionId,
          text: submission.outgoingText,
          behavior: 'steer',
          mentions: submission.mentions,
          attachments: submission.attachmentPaths,
          images: submission.imagePayload,
        });
        setExtensionToast({ message: '已插话发送给当前任务。', type: 'info' });
      } catch (error) {
        setError(errorText(error));
      }
      return;
    }
    setBusy(true);
    setError(null);
    setRetryInfo(null);
    setLiveDiff(null);
    setCompaction({ active: false });
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    try {
      await window.piApi.prompt({
        sessionId: submission.sessionId,
        text: submission.outgoingText,
        requestId,
        mentions: submission.mentions,
        attachments: submission.attachmentPaths,
        images: submission.imagePayload,
      });
      // 侧边栏刷新与读取历史互不依赖；刷新失败不能让一次成功的回复显示成错误。
      void loadState().catch(() => {});
      if (requestRef.current !== requestId) return;
      const historyLimit = Math.max(HISTORY_PAGE_SIZE, messages.length + 10);
      const [saved, outline] = await Promise.all([
        window.piApi.session(submission.sessionId, historyLimit),
        refreshOutline(submission.sessionId),
      ]);
      if (requestRef.current !== requestId) return;
      if (saved) {
        setSession({
          id: saved.id,
          cwd: saved.cwd,
          title: saved.title,
          turnDiffs: saved.turnDiffs,
          hasMore: saved.hasMore,
          messageStart: saved.messageStart,
          totalMessages: saved.totalMessages,
        });
        setMessages(saved.messages.map((message) => ({ ...message })));
        if (outline) applyOutline(outline, saved.messages, saved.messageStart);
        else if (outlineItems.length === 0) applyOutline(undefined, saved.messages, saved.messageStart);
      }
      setBusy(false);
      void loadState().catch(() => {});
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setRetryInfo(null);
      setError(errorText(error));
      setBusy(false);
    }
  }

  /**
   * 输入框的发送入口。
   * 依次处理内置命令、懒创建会话、长消息/附件预处理，
   * 最后根据是否正在运行决定「直接发送 / 插话 / 排队」。
   */
  async function send() {
    const text = prompt.trim();
    if ((!text && composerAttachments.length === 0)) return;
    if (compaction.active) {
      setExtensionToast({ message: '上下文正在压缩，完成后会自动继续。', type: 'info' });
      return;
    }
    if (!busy && composerAttachments.length === 0 && text === '/todos') {
      setTodoPanelOpen(true);
      setPrompt('');
      setComposerMenu(null);
      return;
    }
    if (composerAttachments.length === 0 && text.startsWith('/')) {
      if (await executeBuiltinCommand(text)) {
        setPrompt('');
        setComposerMenu(null);
        return;
      }
    }
    setComposerMenu(null);
    if (!workspace) {
      setError('请先选择一个工作区，再发送消息。');
      return;
    }
    if (session && modelSelection.unavailable) {
      setError(modelSelection.unavailableReason || '这个会话原来的模型已不可用，请先选择新的模型。');
      setModelPickerRequest({ id: ++modelPickerRequestRef.current, view: 'models' });
      return;
    }
    let current = session;
    if (!current) {
      const draftGeneration = sessionLoadRef.current;
      let created;
      try { created = await window.piApi.createSession(workspace); }
      catch (error) { setError(errorText(error)); return; }
      if (sessionLoadRef.current !== draftGeneration) return;
      current = { id: created.id, cwd: created.cwd, title: created.title };
      setSession(current);
      setMessages([]);
      // 草稿会话也要马上出现在侧边栏，否则用户发完第一条消息后找不到入口。
      void loadState().catch(() => { /* 侧边栏刷新失败不阻塞发送 */ });
    }
    const queuedAttachments = composerAttachments;
    const prepared = await prepareSubmission(text, queuedAttachments, current.id);
    setPrompt('');
    setComposerAttachments([]);
    if (busy) {
      if (preferences.busySend === 'steer') {
        await dispatchSubmission(prepared, 'steer');
      } else {
        const order = ++queuedOrderRef.current;
        setQueuedPrompts((items) => [...items, { id: crypto.randomUUID(), order, text, attachments: queuedAttachments, submission: prepared }].sort((a, b) => a.order - b.order));
        setExtensionToast({ message: '已加入排队消息，本轮结束后按顺序发送。', type: 'info' });
      }
      return;
    }
    await dispatchSubmission(prepared, 'prompt');
  }

  async function sendQueuedNow(id: string) {
    if (!busy) return;
    const item = queuedPrompts.find((candidate) => candidate.id === id);
    if (!item) return;
    setQueuedPrompts((items) => items.filter((candidate) => candidate.id !== id));
    await dispatchSubmission(item.submission, 'steer');
  }

  async function sendAllQueued() {
    if (!busy || queuedPrompts.length === 0) return;
    const items = [...queuedPrompts];
    setQueuedPrompts([]);
    queuedDrainRef.current = true;
    for (const item of items) await dispatchSubmission(item.submission, 'steer');
    queuedDrainRef.current = false;
    setExtensionToast({ message: `已插话发送 ${items.length} 条排队消息。`, type: 'info' });
  }

  function editQueued(id: string) {
    const item = queuedPrompts.find((candidate) => candidate.id === id);
    if (!item) return;
    setQueuedPrompts((items) => items.filter((candidate) => candidate.id !== id));
    setPrompt(item.text);
    setComposerAttachments(item.attachments);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function deleteQueued(id: string) {
    setQueuedPrompts((items) => items.filter((candidate) => candidate.id !== id));
  }

  function reorderQueued(fromId: string, toId: string) {
    setQueuedPrompts((items) => {
      const from = items.findIndex((item) => item.id === fromId);
      const to = items.findIndex((item) => item.id === toId);
      if (from < 0 || to < 0 || from === to) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(from < to ? to - 1 : to, 0, moved);
      queuedOrderRef.current = Math.max(queuedOrderRef.current, next.length);
      return next.map((item, index) => ({ ...item, order: index + 1 }));
    });
  }

  // 空闲时自动把队首消息发出去；queuedDrainRef 防止同一轮重复触发。
  useEffect(() => {
    if (busy || queuedPrompts.length === 0 || queuedDrainRef.current) return;
    const next = queuedPrompts[0];
    setQueuedPrompts((items) => items.filter((item) => item.id !== next.id));
    queuedDrainRef.current = true;
    void dispatchSubmission(next.submission, 'prompt').finally(() => {
      queuedDrainRef.current = false;
      setQueuedPrompts((items) => items.length > 0 ? [...items] : items);
    });
  }, [busy, queuedPrompts]);


  // ---------- 右侧文件面板 ----------

  /** 加载目录内容；路径为空表示工作区根目录。 */
  async function loadTree(nextPath: string) {
    if (!workspace) return;
    setFileBusy(true);
    try {
      const result = await window.piApi.files(workspace, nextPath);
      setTreePath(result.path);
      setEntries(result.entries);
    } catch (error) {
      setError(errorText(error));
    } finally { setFileBusy(false); }
  }

  /** 打开右侧面板，并用两帧 rAF 触发滑入动画。 */
  function openPanel() {
    if (panelCloseTimerRef.current !== null) {
      window.clearTimeout(panelCloseTimerRef.current);
      panelCloseTimerRef.current = null;
    }
    if (panelTabs.length === 0) {
      setPanelTabs(current => current.length ? current : [{ id: 'start', kind: 'start', title: '开始' }]);
    }
    setPanelEntered(false);
    setFilesOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setPanelEntered(true)));
  }

  /** 关闭面板：先播放退场动画，再真正卸载并复位全屏状态。 */
  function closePanel() {
    if (!filesOpen) return;
    setPanelEntered(false);
    if (panelCloseTimerRef.current !== null) window.clearTimeout(panelCloseTimerRef.current);
    panelCloseTimerRef.current = window.setTimeout(() => {
      setFilesOpen(false);
      setPanelFullscreen(false);
      panelCloseTimerRef.current = null;
    }, 280);
  }

  function openStartTab() {
    setPanelTabs(current => current.some(tab => tab.kind === 'start') ? current : [...current, { id: 'start', kind: 'start', title: '开始' }]);
    setActivePanelTabId('start');
  }
  function openTemporaryChat() {
    const id = crypto.randomUUID();
    setPanelTabs(current => [...current, { id, kind: 'temporary', title: '临时聊天' }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function openFilesTab() {
    if (!panelTabs.some((tab) => tab.kind === 'files')) {
      setPanelTabs((current) => [...current, { id: 'files', kind: 'files', title: '文件' }]);
    }
    setActivePanelTabId('files');
    setFile(null);
  }

  /** 读取文件并按路径缓存，重复打开时直接命中缓存。 */
  async function loadFileToTab(target: string) {
    const root = workspace || session?.cwd;
    const absolute = target.startsWith('/');
    if (!absolute && !root) return;
    setFileBusy(true);
    try {
      const content = absolute ? await window.piApi.fileAbsolute(target) : await window.piApi.file(root!, target);
      setOpenFiles((current) => {
        // 只保留最近打开的几个文件，避免长时间浏览把每个预览都留在内存里。
        const next = { ...current, [target]: content };
        const keys = Object.keys(next);
        if (keys.length > 8) delete next[keys[0]];
        return next;
      });
      setFile(content);
    } catch (error) {
      setError(errorText(error));
    } finally { setFileBusy(false); }
  }

  /** 切换标签：文件标签按需加载，其它标签清空预览。 */
  function activatePanelTab(tab: PanelTab) {
    setActivePanelTabId(tab.id);
    if (tab.kind === 'file' && tab.path) {
      const cached = openFiles[tab.path];
      setFile(cached ?? null);
      if (!cached) void loadFileToTab(tab.path);
    } else {
      setFile(null);
    }
  }

  /** 从文件树打开文件：不存在则新建标签，已存在则复用。 */
  async function openFile(target: string) {
    const id = `file:${target}`;
    const title = target.split('/').pop() || target;
    setPanelTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'file', title, path: target }]);
    setActivePanelTabId(id);
    const cached = openFiles[target];
    setFile(cached ?? null);
    if (filesOpen) setPanelEntered(true);
    else openPanel();
    if (!cached) await loadFileToTab(target);
  }

  /** 关闭标签；关闭最后一个标签时整个面板一起收起。 */
  function closePanelTab(id: string) {
    const index = panelTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (panelTabs[index].kind === 'temporary') destroyTemporary(id);
    const next = panelTabs.filter((tab) => tab.id !== id);
    setPanelTabs(next);
    if (next.length === 0) { closePanel(); return; }
    if (activePanelTabId === id) {
      const target = next[Math.min(index, next.length - 1)];
      activatePanelTab(target);
    }
  }

  /** 选择工作区文件夹；新对话里只切换草稿工作区，已有对话则直接开始新会话。 */
  function chooseFile() {
    void window.piApi.chooseWorkspace().then((selected) => {
      if (selected) {
        if (isNewConversation) selectDraftWorkspace(selected);
        else void startSession(selected);
        void loadState();
      }
    }).catch(error => setError(errorText(error)));
  }

  /** 设置编辑弹窗的提交路由。 */
  function submitEditor() {
    if (!editor) return;
    if (editor.kind === 'provider') void saveProvider();
    else if (editor.kind === 'model') void saveCustomModel();
    else if (editor.kind === 'mcp') void saveMcp();
    else if (editor.kind === 'package') void addPackage();
    else if (editor.kind === 'extension-install') {
      if (extensionInstallMode === 'package') void addPackage();
      else void importResource('extension', resourceScope);
    }
    else void importResource(editor.kind, resourceScope);
  }

  // ---------- 设置页派生数据 ----------

  /** 按来源对已启用模型分组，用于「按来源」视图。 */
  const enabledModelGroups = useMemo(() => {
    const groups = new Map<string, { name: string; provider: string; ids: string[] }>();
    for (const id of enabledModels) {
      const item = models.find((entry) => entry.id === id);
      const name = item?.providerName || item?.provider || id.split('/')[0];
      const group = groups.get(name) ?? { name, provider: item?.provider || id.split('/')[0], ids: [] };
      group.ids.push(id);
      groups.set(name, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [enabledModels, models]);

  /** 设置页「新对话默认」与当前会话模型完全分开，切换默认值不会影响已打开会话。 */
  const defaultModelItem = models.find((item) => item.id === defaultModelSelection.modelRef);
  const defaultModelProvider = defaultModelItem?.providerName || defaultModelItem?.provider || defaultModelSelection.modelRef.split('/')[0] || 'Pi';
  const defaultModelOptions = useMemo(() => {
    const ids = [...new Set([defaultModelSelection.modelRef, ...enabledModels].filter(Boolean))];
    return ids.map((id) => {
      const item = models.find((entry) => entry.id === id);
      return {
        value: id,
        label: item?.name || id,
        description: `${item?.providerName || item?.provider || id.split('/')[0]} · ${id}`,
      };
    });
  }, [defaultModelSelection.modelRef, enabledModels, models]);
  const defaultThinkingOptions = defaultModelSelection.thinkingLevels.map((level) => ({
    value: level,
    label: thinkingLabels[level],
    description: level === 'default' ? '跟随模型和 Pi 的默认推理等级' : `固定使用 ${thinkingLabels[level]}`,
  }));

  /** 渲染一张已启用模型卡片（设置页「模型与账号」）。 */
  function renderModelCard(id: string) {
    const item = models.find((entry) => entry.id === id);
    const provider = item?.providerName || item?.provider || id.split('/')[0];
    return <article className="model-card" key={id}>
      <div className="model-card-main">
        <span className="model-card-top"><ProviderIcon className="model-card-avatar" provider={item?.provider || provider} name={provider} icon={settingsData?.providers.find((entry) => entry.id === item?.provider)?.icon} size={22} /><span className="model-card-provider">{provider}</span></span>
        <strong className="model-card-name">{item?.name ?? id}</strong>
        <span className="model-card-id">{id}</span>
        <span className="model-card-meta">
          {item?.contextWindow && <span className={`model-tag ${contextTone(item.contextWindow)}`} title={`上下文 ${item.contextWindow.toLocaleString()} tokens`}>{contextLabel(item.contextWindow)}</span>}
          {item?.supportsImages && <span className="model-tag is-image">图片</span>}
          {item?.reasoning && <span className="model-tag is-reasoning">推理</span>}
        </span>
      </div>
      <button className="model-card-remove" disabled={settingsBusy} aria-label={`移除模型 ${item?.name ?? id}`} title="移除" onClick={() => void setEnabled(enabledModels.filter((entry) => entry !== id))}><X /></button>
    </article>;
  }

  function reorderPanelTabs(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setPanelTabs((current) => {
      const order = [...current];
      const from = order.findIndex((tab) => tab.id === sourceId);
      const to = order.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0) return current;
      order.splice(to, 0, ...order.splice(from, 1));
      return order;
    });
  }

  // ---------- 会话派生数据 ----------

  /** 取最后一条 todo 工具结果的计划详情，供底部计划面板使用。 */
  const todoDetails = useMemo<TodoDetails | undefined>(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const details = message.role === 'toolResult' && message.toolName === 'todo' ? message.details : undefined;
      if (details && typeof details === 'object' && Array.isArray((details as TodoDetails).tasks)) return details as TodoDetails;
    }
    return undefined;
  }, [messages]);
  const queuedPreviews: QueuedPreview[] = queuedPrompts.map((item) => ({
    id: item.id,
    text: item.text.trim() || (item.attachments.some((attachment) => attachment.kind === 'image') ? '图片消息' : '附件消息'),
    images: item.attachments.filter((attachment) => attachment.kind === 'image').length,
    files: item.attachments.filter((attachment) => attachment.kind === 'file').length,
  }));
  const toolResultMap = new Map(messages.filter((message) => message.role === 'toolResult' && message.toolCallId).map((message) => [message.toolCallId as string, message]));
  /** 把消息序列折叠成「用户提问 + 助手多步回复」的轮次，工具结果挂到对应轮次。 */
  const transcriptTurns: Array<{ kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] }> = [];
  for (const message of messages) {
    if (message.role === 'toolResult') continue;
    if (message.role === 'user') { transcriptTurns.push({ kind: 'user', message }); continue; }
    const last = transcriptTurns[transcriptTurns.length - 1];
    if (last?.kind === 'assistant') last.messages.push(message);
    else transcriptTurns.push({ kind: 'assistant', messages: [message] });
  }
  const lastAssistantTurnIndex = transcriptTurns.reduce((last, turn, index) => turn.kind === 'assistant' ? index : last, -1);
  const outlineSamples = useMemo(
    () => sampleOutlineIndices(outlineItems.length, outlineActive),
    [outlineItems.length, outlineActive],
  );
  const composerCommandOptions = composerMenu?.kind === 'slash'
    ? composerCommands.filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(composerMenu.query.toLowerCase()))
    : [];
  const composerFileOptions = composerMenu?.kind === 'file' ? composerFiles : [];
  const composerOptionsCount = composerMenu?.kind === 'slash' ? composerCommandOptions.length : composerFileOptions.length;
  // 输入框内联高亮：只影响显示，真实文本仍是 textarea 的值。
  const composerCommandNames = useMemo(() => new Set(composerCommands.map((command) => command.name)), [composerCommands]);
  const composerSegments = useMemo(() => splitComposerText(prompt, composerCommandNames), [prompt, composerCommandNames]);
  const globalSkillGroups = [
    { key: 'agents', label: '~/.agents/skills', items: (settingsData?.skills ?? []).filter((skill) => !skill.path.includes('/.pi/agent/skills/')) },
    { key: 'pi', label: '~/.pi/agent/skills', items: (settingsData?.skills ?? []).filter((skill) => skill.path.includes('/.pi/agent/skills/')) },
  ];
  const activePanelTab = panelTabs.find((tab) => tab.id === activePanelTabId) ?? panelTabs[0];

  function panelTabIcon(tab: PanelTab) {
    if (tab.kind === 'temporary') return <MessageCirclePlus />;
    if (tab.kind === 'start') return <Compass />;
    if (tab.kind === 'files') return <Folder />;
    if (tab.kind === 'diff' || tab.kind === 'changes') return <FileDiff />;
    return <FileText />;
  }

  /** 打开文件 diff 标签页；已存在时直接激活。 */
  function openDiffTab(file: TurnDiffFile, at: number, sessionId = session?.id) {
    const id = `diff:${sessionId}:${at}:${file.path}`;
    setPanelTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'diff', title: file.label.split('/').pop() || file.label, path: file.path, diff: file }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true);
    else openPanel();
  }

  function openChangesTab(file: TurnDiffFile | undefined, turn: TurnDiff) {
    if (!session) return;
    const id = `changes:${session.id}`;
    const turns = [...(session.turnDiffs ?? []).filter(item => item.at !== turn.at), turn];
    const tab: PanelTab = { id, kind: 'changes', title: '变更', review: { sessionId: session.id, initial: turn, turns, focusPath: file?.path } };
    setPanelTabs(current => current.some(item => item.id === id) ? current.map(item => item.id === id ? tab : item) : [...current, tab]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function closePanelTabs(id: string, scope: 'left' | 'right' | 'others' | 'all') {
    const index = panelTabs.findIndex(tab => tab.id === id);
    if (index < 0) return;
    const next = panelTabs.filter((tab, i) => scope === 'left' ? i >= index : scope === 'right' ? i <= index : scope === 'others' ? tab.id === id : false);
    for (const tab of panelTabs) if (tab.kind === 'temporary' && !next.some(item => item.id === tab.id)) destroyTemporary(tab.id);
    setPanelTabs(next);
    if (!next.length) { setActivePanelTabId(''); setFile(null); closePanel(); }
    else if (!next.some(tab => tab.id === activePanelTabId)) activatePanelTab(next.find(tab => tab.id === id) ?? next[0]);
  }

  async function loadSkillTree(baseDir: string, nextPath: string) {
    setSkillBusy(true);
    setSkillDetailError(null);
    try {
      const result = await window.piApi.files(baseDir, nextPath);
      setSkillTreePath(result.path);
      setSkillEntries(result.entries);
    } catch (error) { setSkillDetailError(errorText(error)); }
    finally { setSkillBusy(false); }
  }

  function openSkillDetail(skill: SkillInfo) {
    const baseDir = skill.path.slice(0, skill.path.lastIndexOf('/')) || '/';
    setSkillDetail({ ...skill, baseDir });
    setSkillFile(null);
    setSkillTreePath('');
    setSkillEntries([]);
    void loadSkillTree(baseDir, '');
  }

  async function openSkillFile(target: string) {
    if (!skillDetail) return;
    setSkillBusy(true);
    setSkillDetailError(null);
    try { setSkillFile(await window.piApi.file(skillDetail.baseDir, target)); }
    catch (error) { setSkillDetailError(errorText(error)); }
    finally { setSkillBusy(false); }
  }

  async function removeSkillFromDetail() {
    if (!skillDetail) return;
    if (!window.confirm(`删除技能「${skillDetail.name}」？这会删除技能目录。`)) return;
    setSettingsBusy(true);
    setSkillDetailError(null);
    try {
      setSettingsData(await window.piApi.removeSkill(skillDetail.path));
      closeSkillDetail();
    } catch (error) { setSkillDetailError(errorText(error)); }
    finally { setSettingsBusy(false); }
  }

  function closeSkillDetail() {
    setSkillDetail(null);
    setSkillFile(null);
    setSkillEntries([]);
    setSkillDetailError(null);
  }

  useEffect(() => {
    if (!skillDetail && !mcpDetail) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSkillDetail(null); setMcpDetail(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skillDetail, mcpDetail]);

  async function showFileActions() {
    if (!file || !workspace) return;
    if (fileMenuOpen) { setFileMenuOpen(false); return; }
    setFileMenuOpen(true);
    try {
      const result = await window.piApi.fileActions({ cwd: workspace, path: file.path });
      setFileApps(result.apps);
    } catch (error) { setError(errorText(error)); }
  }

  async function openFileWith(appPath?: string) {
    if (!file || !workspace) return;
    setFileMenuOpen(false);
    try { await window.piApi.openWith({ cwd: workspace, path: file.path, appPath }); }
    catch (error) { setError(errorText(error)); }
  }

  async function revealCurrentFile() {
    if (!file || !workspace) return;
    setFileMenuOpen(false);
    try { await window.piApi.revealFile({ cwd: workspace, path: file.path }); }
    catch (error) { setError(errorText(error)); }
  }

  function renderFileTree() {
    return <div className="panel-file-browser">
      <div className="file-toolbar">
        <button className="icon-button" aria-label="返回上级目录" title="返回上级目录" disabled={!treePath} onClick={() => void loadTree(treePath.split('/').slice(0, -1).join('/'))}><ChevronLeft /></button>
        <span className="path-label">{treePath ? `/${treePath}` : '/'}</span>
        <button className="icon-button" aria-label="刷新文件列表" title="刷新" onClick={() => void loadTree(treePath)}><RotateCw /></button>
        <small>{entries.length} 项</small>
      </div>
      <div className="file-tree">
        {!fileBusy && entries.map((entry) => (
          <button key={entry.path} className={`file-row ${entry.type === 'directory' ? 'is-directory' : ''}`} title={entry.name} onClick={() => entry.type === 'directory' ? void loadTree(entry.path) : void openFile(entry.path)}>
            {entry.type === 'directory' ? <Folder size={15} /> : <FileText size={15} />}
            <span>{entry.name}</span>
            {entry.type === 'file' && <small>{filesize(entry.size)}</small>}
            {entry.type === 'directory' && <ChevronDown size={13} className="chevron-left" />}
          </button>
        ))}
        {!fileBusy && entries.length === 0 && <div className="file-empty"><FolderOpen /><strong>这个目录还是空的</strong><span>添加文件后，它们会出现在这里。</span></div>}
      </div>
      {fileBusy && <div className="file-loading" role="status"><LoaderCircle className="spin" />正在读取文件…</div>}
    </div>;
  }

  function renderFilePreview() {
    if (!file) return fileBusy
      ? <div className="panel-empty" role="status" aria-label="正在读取文件"><LoaderCircle className="spin" /><strong>正在读取文件</strong><span>内容加载后会在右侧显示。</span></div>
      : <div className="panel-empty"><FileText /><strong>选择一个文件</strong><span>从左侧文件树打开文件，会在这里以标签页显示。</span></div>;
    const wrapLines = /\.(?:txt|log)$/i.test(file.path);
    return <div className="panel-file-preview">
      <div className="file-toolbar">
        <span className="path-label" title={file.path}>{file.path}</span>
        <small>{filesize(file.size)}</small>
        <div className="file-actions" ref={fileActionsRef}>
          <button className="icon-button" aria-label="文件操作" title="文件操作" aria-expanded={fileMenuOpen} onClick={() => void showFileActions()}><MoreHorizontal /></button>
          {fileMenuOpen && <div className="file-actions-menu" role="menu">
            <div className="file-actions-label">打开方式</div>
            <button className="file-action" role="menuitem" onClick={() => void openFileWith()}><Eye /><span>预览（默认）</span></button>
            <div className="file-actions-sep" />
            {fileApps.map((app) => <button className="file-action" role="menuitem" key={app.path} onClick={() => void openFileWith(app.path)}>{app.icon ? <img src={app.icon} alt="" /> : <AppWindow />}<span>{app.name}</span></button>)}
            <div className="file-actions-sep" />
            <button className="file-action" role="menuitem" onClick={() => void revealCurrentFile()}><FolderOpen /><span>显示文件位置</span></button>
          </div>}
        </div>
      </div>
      {file.binary ? <div className="file-empty"><FileText /><strong>暂不支持预览此文件</strong><span>可以在其他应用中查看二进制文件。</span></div> : <pre className={`file-code ${wrapLines ? 'is-wrapped' : ''}`}><code>{file.text.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><span>{line || ' '}</span></span>)}</code></pre>}
      {fileBusy && <div className="file-loading" role="status"><LoaderCircle className="spin" />正在读取文件…</div>}
    </div>;
  }

  function renderPanelStart() {
    return <div className="panel-start">
      <div className="panel-start-tools">
        <button className="panel-tool" onClick={openTemporaryChat}><span className="panel-tool-icon"><MessageCirclePlus /></span><span><strong>临时聊天</strong><small>无需工作区，退出应用后清除</small></span><ChevronRight className="panel-tool-arrow" /></button>
        <button className="panel-tool" onClick={openFilesTab}><span className="panel-tool-icon is-folder"><Folder /></span><span><strong>工作区文件</strong><small>浏览当前工作区里的文件</small></span><ChevronDown className="panel-tool-arrow" /></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><Terminal /></span><span><strong>新建终端</strong><small>即将推出</small></span></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><Globe2 /></span><span><strong>浏览器</strong><small>即将推出</small></span></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><LayoutGrid /></span><span><strong>更多工具</strong><small>即将推出</small></span></button>
      </div>
    </div>;
  }

  function renderPanelContent() {
    if (!activePanelTab) return null;
    if (activePanelTab.kind === 'temporary') return <TemporaryChat key={activePanelTab.id} id={activePanelTab.id} selection={modelSelection} onManage={() => void openSettings('models')} />;
    if (activePanelTab.kind === 'start') return renderPanelStart();
    if (activePanelTab.kind === 'files') return renderFileTree();
    if (activePanelTab.kind === 'changes' && activePanelTab.review) return <ChangesView key={`${activePanelTab.id}:${activePanelTab.review.initial.at}:${activePanelTab.review.focusPath}`} {...activePanelTab.review} onOpenFile={path => void openFile(path)} onOpenDiff={(file, at) => openDiffTab(file, at, activePanelTab.review!.sessionId)} />;
    if (activePanelTab.kind === 'diff' && activePanelTab.diff) return <DiffView file={activePanelTab.diff} />;
    return renderFilePreview();
  }

  // ---------- 界面：左侧栏 / 对话 / 设置 / 右侧面板 ----------

  const backgroundStyle = {
    '--background-surface-opacity': preferences.backgroundSurfaceOpacity / 100,
  } as CSSProperties;

  return (
    <div
      className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${filesOpen && panelFullscreen ? 'is-panel-fullscreen' : ''} ${preferences.backgroundMedia ? 'has-custom-background' : ''}`}
      style={backgroundStyle}
    >
      {preferences.backgroundMedia && <BackgroundLayer
        media={preferences.backgroundMedia}
        opacity={preferences.backgroundOpacity}
        blur={preferences.backgroundBlur}
        onError={() => handleBackgroundUnavailable(preferences.backgroundMedia!.url)}
      />}
      {/* 左侧：品牌、导航、工作区列表与设置入口 */}
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <button className="icon-button sidebar-top-toggle" aria-label="收起侧边栏" title="收起侧边栏" onClick={() => setSidebarCollapsed(true)}><PanelLeft /></button>
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Pi Studio</span>
          {(updateSnapshot.state === 'available'
            || updateSnapshot.state === 'downloading'
            || updateSnapshot.state === 'downloaded') && <button
              type="button"
              className={`brand-update is-${updateSnapshot.state}`}
              aria-label={updateSnapshot.state === 'downloaded'
                ? '重启并安装更新'
                : updateSnapshot.state === 'downloading'
                  ? `正在下载 Pi Studio 更新，${Math.round(updateSnapshot.progress || 0)}%`
                  : `Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion} ` : ''}可以更新`}
              title={updateSnapshot.state === 'downloaded'
                ? `Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion} ` : ''}已下载，点击安装`
                : updateSnapshot.state === 'downloading'
                  ? `正在下载 Pi Studio 更新 · ${Math.round(updateSnapshot.progress || 0)}%`
                  : `发现 Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion}` : '新版本'}`}
              onClick={openUpdateDialog}
            >
              {updateSnapshot.state === 'downloading'
                ? <LoaderCircle className="spin" />
                : updateSnapshot.state === 'downloaded'
                  ? <ArrowUp />
                  : <Sparkles />}
              {updateSnapshot.state === 'available' && <i aria-hidden="true" />}
            </button>}
        </div>
        <button className="new-chat" title="新会话" onClick={() => void startSession()}><SquarePen /><span>新会话</span></button>
        <nav className="nav">
          <button className="nav-row" title="临时聊天" onClick={openTemporaryChat}><MessageCirclePlus /><span>临时聊天</span></button>
          <button className="nav-row is-active" title="对话" aria-current="page"><MessageSquare /><span>对话</span></button>
          <button className="nav-row" title="扩展" onClick={() => void openSettings('extensions')}><Layers3 /><span>扩展</span></button>
          <button className="nav-row" disabled title="自动化任务即将推出"><Clock3 /><span>自动化任务</span><small>即将推出</small></button>
        </nav>
        <div className="workspace-head">
          <span>工作区</span>
          <div>
            <button className="icon-button" disabled={workspaces.length === 0} aria-label={allExpanded ? '收起所有工作区' : '展开所有工作区'} title={allExpanded ? '收起所有工作区' : '展开所有工作区'} onClick={toggleAllExpanded}>{allExpanded ? <ChevronsUp /> : <ChevronsDown />}</button>
            <button className={`icon-button ${workspaceSearchOpen ? 'is-active' : ''}`} aria-label="搜索工作区" title="搜索工作区" onClick={() => { setWorkspaceSearchOpen((value) => !value); setWorkspaceQuery(''); }}><Search /></button>
            <button className="icon-button" onClick={chooseFile} aria-label="打开工作区" title="打开工作区"><FolderOpen /></button>
          </div>
        </div>
        {workspaceSearchOpen && <div className="workspace-search"><Search /><input autoFocus aria-label="搜索工作区或会话" placeholder="搜索工作区或会话…" value={workspaceQuery} onChange={(event) => setWorkspaceQuery(event.target.value)} /></div>}
        <div className="workspace-list">
          {stateLoading && workspaces.length === 0 && (
            <div className="workspace-skeleton" role="status" aria-live="polite" aria-label="正在加载工作区">
              <span className="sr-only">正在加载工作区…</span>
              {[0, 1, 2].map((group) => (
                <div className="skeleton-group" key={group} style={{ animationDelay: `${group * 90}ms` }}>
                  <div className="skeleton-workspace-head">
                    <span className="skeleton-icon" />
                    <span className="skeleton-line" style={{ width: `${[46, 60, 38][group]}%` }} />
                    <span className="skeleton-chevron" />
                  </div>
                  <div className="skeleton-sessions">
                    <span className="skeleton-session-line" style={{ width: `${[74, 58][group % 2]}%` }} />
                    <span className="skeleton-session-line" style={{ width: `${[53, 67][group % 2]}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!(stateLoading && workspaces.length === 0) && visibleWorkspaces.map((item) => {
            const isOpen = expanded.has(item.cwd);
            const isActive = workspace === item.cwd;
            return (
              <div className="workspace" key={item.cwd}>
                <div className="sidebar-row-shell workspace-row-shell">
                <button
                  className={`workspace-row ${isActive ? 'is-active' : ''} ${dropHint === `w:${item.cwd}` ? 'drop-before' : ''} ${draggingItem?.kind === 'workspace' && draggingItem.cwd === item.cwd ? 'is-dragging' : ''} ${justDropped === `w:${item.cwd}` ? 'just-dropped' : ''}`}
                  title={item.cwd}
                  aria-expanded={isOpen}
                  draggable
                  onDragStart={(event) => {
                    dragRef.current = { kind: 'workspace', cwd: item.cwd };
                    setDraggingItem(dragRef.current);
                    makeDragPreview(event, item.name, '工作区');
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', item.cwd);
                  }}
                  onDragOver={(event) => {
                    const drag = dragRef.current;
                    if (drag?.kind !== 'workspace' || drag.cwd === item.cwd) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropHint(`w:${item.cwd}`);
                  }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}
                  onDrop={(event) => {
                    const drag = dragRef.current;
                    event.preventDefault();
                    if (drag?.kind === 'workspace') reorderWorkspaces(drag.cwd, item.cwd);
                    clearDragState();
                  }}
                  onDragEnd={clearDragState}
                  onClick={() => {
                    if (isNewConversation) selectDraftWorkspace(item.cwd);
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (isOpen) next.delete(item.cwd); else next.add(item.cwd);
                      return next;
                    });
                  }}
                >
                  {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <span>{item.name}</span>
                  <ChevronDown size={13} className={isOpen ? 'chevron open' : 'chevron'} />
                </button>
                <SidebarActions kind="workspace" id={item.cwd} name={item.name} onNew={() => void startSession(item.cwd)} onAction={(action, name) => sidebarAction('workspace', item.cwd, action, name)} />
                </div>
                {isOpen && (
                  <div className="sessions">
                    {item.sessions.filter(entry => Boolean(entry.archived) === showArchived).map((sessionItem) => (
                      <div className={`sidebar-row-shell session-row-shell ${sessionItem.pinned ? 'is-pinned' : ''}`} key={sessionItem.id}>
                      <button
                        key={sessionItem.id}
                        className={`session-row ${session?.id === sessionItem.id ? 'is-active' : ''} ${dropHint === `s:${item.cwd}:${sessionItem.id}` ? 'drop-before' : ''} ${draggingItem?.kind === 'session' && draggingItem.sessionId === sessionItem.id ? 'is-dragging' : ''} ${justDropped === `s:${item.cwd}:${sessionItem.id}` ? 'just-dropped' : ''}`}
                        title={sessionItem.title}
                        draggable
                        onDragStart={(event) => {
                          dragRef.current = { kind: 'session', cwd: item.cwd, sessionId: sessionItem.id };
                          setDraggingItem(dragRef.current);
                          makeDragPreview(event, sessionItem.title, '会话');
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', sessionItem.id);
                        }}
                        onDragOver={(event) => {
                          const drag = dragRef.current;
                          if (drag?.kind !== 'session' || drag.cwd !== item.cwd || drag.sessionId === sessionItem.id) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = 'move';
                          setDropHint(`s:${item.cwd}:${sessionItem.id}`);
                        }}
                        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHint(null); }}
                        onDrop={(event) => {
                          const drag = dragRef.current;
                          event.preventDefault();
                          event.stopPropagation();
                          if (drag?.kind === 'session' && drag.cwd === item.cwd && drag.sessionId) reorderSessions(item.cwd, drag.sessionId, sessionItem.id);
                          clearDragState();
                        }}
                        onDragEnd={clearDragState}
                        onClick={() => void openSession(sessionItem)}
                        onMouseEnter={() => prefetchSession(sessionItem.id)}
                        onFocus={() => prefetchSession(sessionItem.id)}
                      >
                        <span className="session-title">{sessionItem.title}</span>
                        {sessionItem.pinned && <span className="session-pin-mark" title="已置顶">置顶</span>}
                        <span className="session-time">{relativeTime(sessionItem.updatedAt)}</span>
                      </button>
                      <SidebarActions kind="session" id={sessionItem.id} name={sessionItem.title} pinned={sessionItem.pinned} archived={sessionItem.archived} onAction={(action, name) => sidebarAction('session', sessionItem.id, action, name)} />
                      </div>
                    ))}
                    {!showArchived && item.sessions.every(entry => entry.archived) && <button className="session-row empty" onClick={() => void startSession(item.cwd)}>新会话</button>}
                  </div>
                )}
              </div>
            );
          })}
          {!stateLoading && visibleWorkspaces.length === 0 && (
            <div className="sidebar-empty">
              <span className="sidebar-empty-icon"><FolderOpen /></span>
              <strong>{workspaceQuery ? '没有匹配的结果' : '还没有工作区'}</strong>
              <span>{workspaceQuery ? '换个关键词，或清空搜索' : '用上方的文件夹按钮打开一个目录'}</span>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          {(showArchived || workspaces.some(item => item.sessions.some(entry => entry.archived))) && <button className="sidebar-archive-toggle" onClick={() => setShowArchived(current => !current)}>{showArchived ? '返回未归档会话' : '查看归档会话'}</button>}
          <button className="bottom-row" title="设置" onClick={() => void openSettings()}><Settings /><span>设置</span><span className="status"><i />本地运行</span></button>
        </div>
      </aside>

      {/* 中间：对话区与输入区 */}
      <main className={`main ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
        <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
        <header className="chat-header">
          {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={() => setSidebarCollapsed(false)}><PanelLeft /></button>}
          {!isNewConversation && <div className="chat-heading">
            <h1>{agentView.kind === 'child' ? `${agentView.child.agent} · 子 Agent` : (session?.title || 'Pi Studio')}</h1>
          </div>}
          <div className="chat-actions">
            {!filesOpen && <button className="icon-button" onClick={openPanel} aria-label="打开右侧面板" title="打开右侧面板"><PanelRight size={16} /></button>}
          </div>
        </header>
        {!isNewConversation && <div className="chat-tabs">
          <button type="button" className={`tab ${agentView.kind === 'conversation' ? 'is-active' : ''}`} onClick={returnToMainAgent}>对话</button>
          {subagentChildren.length > 0 && <button type="button" className={`tab agent-tab ${agentView.kind !== 'conversation' ? 'is-active' : ''}`} onClick={openAgentOverview}>
            <Bot />
            <span>子 Agent</span>
            <span className="agent-tab-count">{subagentChildren.length}</span>
            {subagentChildren.some((child) => child.status === 'running' || child.status === 'pending') && <i aria-label="有子 Agent 正在运行" />}
          </button>}
          <span className="chat-tabs-note">
            {subagentChildren.length > 0
              ? `${subagentChildren.filter((child) => child.status === 'running' || child.status === 'pending').length} 运行中 · ${subagentChildren.length} 个子 Agent`
              : messages.filter((message) => message.role !== 'toolResult').length > 0
                ? `${messages.filter((message) => message.role !== 'toolResult').length} 条消息`
                : '从一个想法开始'}
          </span>
        </div>}

        {isNewConversation && <div className="chat-tabs is-placeholder" aria-hidden="true" />}
        {!isNewConversation && <div
          className={`chat-scroll ${agentView.kind !== 'conversation' ? 'is-agent-hidden' : ''}`}
          aria-hidden={agentView.kind !== 'conversation'}
          ref={scrollRef}
          onWheel={event => {
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || Math.abs(event.deltaY) < 0.5) return;
            if (nestedScrollableConsumesWheel(event.target, event.currentTarget, event.deltaY)) return;
            markUserScrollIntent();
            historyUserScrollRef.current = true;
            if (shouldReleaseFollowOnWheel({ deltaX: event.deltaX, deltaY: event.deltaY, nestedScrollable: false })) {
              pauseTranscriptFollow();
            } else if (event.deltaY > 0 && isNearBottom(event.currentTarget)) {
              resumeTranscriptFollow();
            }
          }}
          onTouchMove={() => {
            markUserScrollIntent();
            historyUserScrollRef.current = true;
            pauseTranscriptFollow();
          }}
          onPointerDown={() => {
            markUserScrollIntent();
            historyUserScrollRef.current = true;
          }}
          onPointerMove={event => {
            if (event.buttons !== 0) markUserScrollIntent();
          }}
          onKeyDown={event => {
            if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
              markUserScrollIntent();
              historyUserScrollRef.current = true;
              pauseTranscriptFollow();
            } else if (event.key === 'PageDown' || event.key === 'ArrowDown' || event.key === 'End') {
              markUserScrollIntent();
              historyUserScrollRef.current = true;
            }
          }}
          onScroll={handleTranscriptScroll}
        >
          <div className="chat-column" ref={chatContentRef}>
            {messages.length > 0 && (
              <div className="messages">
                {historyLoading && <div className="history-loading" role="status" aria-live="polite" aria-label="正在加载更早消息"><LoaderCircle className="spin" /></div>}
                {session?.id && <ExtensionHeader sessionId={session.id} />}
                {transcriptTurns.map((turn, index) => turn.kind === 'user'
                  ? <ChatMessageView key={`user-${turn.message.sourceIndex ?? turn.message.timestamp ?? index}`} id={`chat-turn-${turn.message.sourceIndex ?? `pending-${turn.message.timestamp ?? index}`}`} message={turn.message} onOpenFile={handleOpenFile} />
                  : <AssistantTurnView key={`assistant-${turn.messages[0]?.sourceIndex ?? turn.messages[0]?.timestamp ?? index}`} id={turn.messages[0]?.sourceIndex !== undefined ? `chat-assistant-turn-${turn.messages[0].sourceIndex}` : undefined} messages={turn.messages} toolResults={toolResultMap} cwd={session?.cwd} busy={busy && index === transcriptTurns.length - 1} retry={index === lastAssistantTurnIndex && retryInfo ? retryInfo : undefined} stepDisplay={preferences.stepDisplay} stepCollapse={preferences.stepCollapse} showCodeView={preferences.showCodeView}
                    gitDiff={index === lastAssistantTurnIndex ? liveDiff ?? (turn.messages.at(-1)?.timestamp ? session?.turnDiffs?.find((diff) => diff.at === turn.messages.at(-1)?.timestamp) : undefined) : (turn.messages.at(-1)?.timestamp ? session?.turnDiffs?.find((diff) => diff.at === turn.messages.at(-1)?.timestamp) : undefined)}
                    onOpenDiff={handleOpenChanges} onOpenFile={handleOpenFile} />)}
                {busy && extensionWorking.visible && !retryInfo && transcriptTurns.at(-1)?.kind !== 'assistant' && (
                  <div className="thinking"><span /><span /><span />正在思考</div>
                )}
              </div>
            )}
            {error && <div className="error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
          </div>
        </div>}

        {!settingsOpen && !filesOpen && !isNewConversation && agentView.kind === 'conversation' && outlineItems.length > 1 && (
          <nav className="conversation-outline" aria-label="对话大纲" onMouseLeave={() => setOutlineHover(null)}>
            <div className="outline-track">
              {outlineSamples.map((index) => {
                const item = outlineItems[index];
                return <div className={`outline-item ${outlineHover === index ? 'is-hovered' : ''}`} key={item.sourceIndex} onMouseEnter={() => setOutlineHover(index)}>
                  <button
                    type="button"
                    className={`outline-tick ${index === outlineActive ? 'is-active' : ''}`}
                    aria-label={`跳转到第 ${index + 1} 条提问`}
                    title={item.text.slice(0, 100)}
                    onFocus={() => setOutlineHover(index)}
                    onClick={() => jumpToOutline(index)}
                  ><span className="outline-line" /></button>
                  {outlineHover === index && <div className="outline-preview">
                    <div className="outline-preview-role">你 · {item.timestamp ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}<span>{index + 1} / {outlineItems.length}</span></div>
                    <p>{item.text}</p>
                  </div>}
                </div>;
              })}
            </div>
          </nav>
        )}
        {agentView.kind === 'agents' && <SubagentOverview
          children={subagentChildren}
          selection={modelSelection}
          onOpenChild={openAgentTranscript}
          onReturnMain={returnToMainAgent}
        />}
        {agentView.kind === 'child' && <SubagentTranscriptView
          child={agentView.child}
          transcript={subagentTranscript}
          loading={subagentLoading}
          error={subagentError}
          stepDisplay={preferences.stepDisplay}
          stepCollapse={preferences.stepCollapse}
          showCodeView={preferences.showCodeView}
          onBackMain={returnToMainAgent}
          onOverview={openAgentOverview}
          onOpenFile={handleOpenFile}
        />}
        {/* 输入区：计划、排队消息、附件与命令菜单 */}
        <div className="composer-dock" hidden={agentView.kind !== 'conversation'}>
          {(todoDetails || todoPanelOpen) && <TodoDock details={todoDetails} open={todoPanelOpen} onToggle={() => setTodoPanelOpen((value) => !value)} />}
          {queuedPrompts.length > 0 && <QueuedMessages items={queuedPreviews} onEdit={editQueued} onDelete={deleteQueued} onSendNow={(id) => void sendQueuedNow(id)} onSendAll={() => void sendAllQueued()} onReorder={reorderQueued} />}
          {isNewConversation && <div className="new-conversation-intro">
            <h2>今天，<em>想做点什么？</em></h2>
            <p id="workspace-selection-hint" role="status">{workspace ? '从一个念头开始，在这个工作区里继续。' : '先选择一个工作区，再开始对话。'}</p>
            <WorkspacePicker value={workspace} workspaces={workspaces} onChange={selectDraftWorkspace} onBrowse={chooseFile} />
          </div>}
          <div className="composer-wrap" ref={composerWrapRef}>
            {composerMenu && <div className="composer-picker" role="listbox" aria-label={composerMenu.kind === 'slash' ? '命令与技能' : '工作区文件与目录'}>
              <div className="composer-picker-head"><span>{composerMenu.kind === 'slash' ? '命令与技能' : '引用工作区文件或目录'}</span><span>{composerMenuLoading ? '正在加载…' : composerMenu.kind === 'slash' ? '输入以筛选' : '↑↓ 选择文件或目录'}</span></div>
              <div className="composer-picker-scroll">
                {composerMenu.kind === 'slash' && ([
                  { source: 'builtin', label: '命令' },
                  { source: 'skill', label: '技能' },
                  { source: 'prompt', label: '提示模板' },
                  { source: 'extension', label: '扩展命令' },
                ] as const).map((group) => {
                  const items = composerCommandOptions.filter((command) => command.source === group.source);
                  if (items.length === 0) return null;
                  return <div className="composer-picker-group" key={group.source}>
                    <div className="composer-picker-label">{group.label}<span>{items.length}</span></div>
                    {items.map((command) => {
                      const index = composerCommandOptions.indexOf(command);
                      return <button type="button" role="option" aria-selected={index === composerMenuIndex} key={`${command.source}:${command.name}`} className={`composer-option ${index === composerMenuIndex ? 'is-active' : ''}`} onMouseEnter={() => setComposerMenuIndex(index)} onMouseDown={(event) => { event.preventDefault(); selectComposerOption(index); }}>
                        <span className={`composer-option-icon is-${command.source}`}><ComposerSourceIcon source={command.source} /></span>
                        <span className="composer-option-main"><strong>/{command.name}</strong><span>{command.description || '没有描述'}</span></span>
                        {command.argumentHint && <code>{command.argumentHint}</code>}
                      </button>;
                    })}
                  </div>;
                })}
                {composerMenu.kind === 'file' && <div className="composer-picker-group">
                  <div className="composer-picker-label">工作区文件与目录<span>{composerFileOptions.length}</span></div>
                  {composerFileOptions.map((file, index) => <button type="button" role="option" aria-selected={index === composerMenuIndex} key={`${file.type}:${file.path}`} className={`composer-option ${index === composerMenuIndex ? 'is-active' : ''}`} onMouseEnter={() => setComposerMenuIndex(index)} onMouseDown={(event) => { event.preventDefault(); selectComposerOption(index); }}>
                    <span className={`composer-option-icon ${file.type === 'directory' ? 'is-directory' : 'is-file'}`}>{file.type === 'directory' ? <Folder /> : <FileText />}</span>
                    <span className="composer-option-main"><strong>{file.name}{file.type === 'directory' ? '/' : ''}</strong><span>{file.path}{file.type === 'directory' ? '/' : ''}</span></span>
                  </button>)}
                </div>}
                {!composerMenuLoading && composerOptionsCount === 0 && <div className="composer-picker-empty">{composerMenu.kind === 'slash' ? '没有匹配的命令' : workspace ? '没有匹配的文件或目录' : '请先选择一个工作区'}</div>}
              </div>
              <div className="composer-picker-foot"><span>↑↓ 选择</span><span>↵ 确认</span><span>Esc 关闭</span></div>
            </div>}
            {session?.id && compaction.active && <div className="compaction-banner" role="status"><LoaderCircle className="spin" /><span>上下文正在压缩，完成后会自动继续…</span></div>}
            {session?.id && busy && extensionWorking.visible && extensionWorking.message && <div className="extension-working" role="status"><LoaderCircle className="spin" /><span>{extensionWorking.message}</span></div>}
            {session?.id && <ExtensionWidgets sessionId={session.id} placement="aboveEditor" />}
            <div
              className="composer"
              onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
              onDrop={(event) => { const dropped = Array.from(event.dataTransfer.files); if (dropped.length > 0) { event.preventDefault(); void addComposerFiles(dropped); } }}
            >
            {composerAttachments.length > 0 && <div className="composer-attachments">
              {composerAttachments.map((attachment) => attachment.kind === 'image'
                ? <div className="composer-attachment is-image" key={attachment.id} title={attachment.name}>
                  <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" />
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => removeComposerAttachment(attachment.id)}><X /></button>
                </div>
                : <div className="composer-attachment is-file is-openable" key={attachment.id} title={attachment.path} role={attachment.path ? 'button' : undefined} tabIndex={attachment.path ? 0 : undefined} aria-label={attachment.path ? `在右侧面板查看 ${attachment.name}` : undefined}
                  onClick={() => { if (attachment.path) void openFile(attachment.path); }}
                  onKeyDown={(event) => { if (attachment.path && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openFile(attachment.path); } }}>
                  <AttachmentIcon name={attachment.name} mime={attachment.mime} />
                  <span><strong>{attachment.name}</strong><small>{filesize(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</small></span>
                  {attachment.path && <span className="attachment-open-cue" title="在右侧面板查看" aria-hidden="true"><PanelRightOpen /></span>}
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={(event) => { event.stopPropagation(); removeComposerAttachment(attachment.id); }} onKeyDown={(event) => event.stopPropagation()}><X /></button>
                </div>)}
            </div>}
            <div className={`composer-input ${composing ? 'is-composing' : ''}`}>
              <div className="composer-highlight" ref={composerHighlightRef} aria-hidden="true">
                {composerSegments.map((segment, index) => segment.kind === 'text'
                  ? <span key={index}>{segment.text}</span>
                  : <span key={index} className={`composer-token is-${segment.tokenKind}`}>{segment.text}</span>)}
                {prompt.endsWith('\n') && <span>{'\u200b'}</span>}
              </div>
              <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => { const value = event.target.value; setPrompt(value); updateComposerMenu(value, event.target.selectionStart ?? value.length); }}
              onClick={(event) => updateComposerMenu(prompt, event.currentTarget.selectionStart ?? prompt.length)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length > 0) { event.preventDefault(); void addComposerFiles(files); return; }
                const text = event.clipboardData.getData('text');
                if (!text) return;
                const start = event.currentTarget.selectionStart ?? prompt.length;
                const end = event.currentTarget.selectionEnd ?? prompt.length;
                const base = prompt.slice(0, start) + prompt.slice(end);
                if (!pasteExceedsBudget(base, text)) return;
                event.preventDefault();
                // 被选中替换的内容随这次粘贴一起移除；粘贴内容单独落成附件。
                if (start !== end) setPrompt(base);
                void attachPastedText(text).then((saved) => {
                  if (saved) return;
                  // 落盘失败时退回普通文本粘贴，避免内容丢失。
                  const next = prompt.slice(0, start) + text + prompt.slice(end);
                  setPrompt(next);
                  requestAnimationFrame(() => {
                    const node = textareaRef.current;
                    if (!node) return;
                    node.focus();
                    node.selectionStart = node.selectionEnd = start + text.length;
                  });
                });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && queuedPrompts.length > 0) { event.preventDefault(); void sendAllQueued(); return; }
                if (composerMenu && composerOptionsCount > 0) {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setComposerMenuIndex((index) => (index + 1) % composerOptionsCount); return; }
                  if (event.key === 'ArrowUp') { event.preventDefault(); setComposerMenuIndex((index) => (index - 1 + composerOptionsCount) % composerOptionsCount); return; }
                  if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) { event.preventDefault(); selectComposerOption(composerMenuIndex); return; }
                  if (event.key === 'Escape') { event.preventDefault(); setComposerMenu(null); return; }
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
              }}
              aria-label="发送给 Pi 的消息"
              aria-describedby={isNewConversation ? 'workspace-selection-hint' : undefined}
              className={`${queuedPrompts.length > 0 ? 'has-queued' : ''} ${composing ? 'is-composing' : ''}`.trim() || undefined}
              aria-expanded={Boolean(composerMenu)}
              placeholder={compaction.active ? '正在压缩上下文，完成后自动继续…' : queuedPrompts.length > 0 ? 'Cmd/Ctrl+Enter 插话发送全部排队消息' : '描述你的想法，或输入 / 命令、@ 文件…'}
              rows={2}
              onScroll={(event) => {
                // 高亮层与 textarea 同步滚动，保证长文本换行时不错位。
                if (composerHighlightRef.current) {
                  composerHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                  composerHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                }
              }}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            />
            </div>
            <div className="composer-bar">
              <div className="composer-left">
                <button type="button" className="composer-attach-button" disabled={busy} onClick={() => void pickComposerAttachments()} aria-label="添加图片或文件" title="添加图片或文件"><Plus /></button>
                {permission.available && (
                  <span className="composer-mode" title="工具权限模式（由 pi-mode-switcher 扩展执行）">
                    <ShieldCheck aria-hidden="true" />
                    <Select
                      label="权限模式"
                      className="composer-mode-select"
                      value={permission.mode}
                      options={permissionOptions}
                      onChange={(value) => void changePermission(value as PermissionMode)}
                    />
                  </span>
                )}
              </div>
              <div className="composer-right">
                <ModelPicker selection={modelSelection} scope={session ? 'session' : 'default'} disabled={stateLoading || sessionLoading} hidden={settingsOpen} loadCatalog={loadModelCatalog} onSelectModel={selectModel} onSelectThinking={selectThinking} onManage={() => void openSettings('models')} request={modelPickerRequest} onRequestHandled={() => setModelPickerRequest(null)} />
                <button className="send-button" disabled={!workspace || (!prompt.trim() && composerAttachments.length === 0) || compaction.active} onClick={() => void send()} aria-label={compaction.active ? '正在压缩上下文' : busy ? (preferences.busySend === 'queue' ? '排队发送' : '引导当前任务') : '发送消息'} title={!workspace ? '请先选择工作区' : compaction.active ? '正在压缩上下文，完成后自动继续' : busy ? (preferences.busySend === 'queue' ? '排队发送' : '引导当前任务') : '发送消息'}><ArrowUp /></button>
              </div>
            </div>
            </div>
            {session?.id && <ExtensionWidgets sessionId={session.id} placement="belowEditor" />}
          </div>
          {session?.id && <StatusDock sessionId={session.id} />}
          {session?.id && <ExtensionCustomOverlay sessionId={session.id} />}
          {session?.id && <ExtensionDialogHost sessionId={session.id} />}
          {session?.id && <ExtensionSelectDialog sessionId={session.id} />}
          {extensionToast && <div className={`extension-toast is-${extensionToast.type}`} role="status">{extensionToast.message}</div>}
          {isNewConversation && error && <div className="new-conversation-error error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
        </div>
      </main>

      {/* 设置覆盖层 */}
      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
          <aside className="settings-nav">
            <div className="settings-nav-head"><span>设置</span></div>
            {settingsPages.map((page) => <button key={page.id} className={`settings-nav-row ${settingsTab === page.id ? 'is-active' : ''}`} aria-current={settingsTab === page.id ? 'page' : undefined} onClick={() => { setSettingsTab(page.id); setModelQuery(''); }}><page.icon />{page.label}</button>)}
            <div className="settings-nav-bottom"><button className="settings-back-button" onClick={() => setSettingsOpen(false)}><ChevronLeft /><span>返回对话</span><kbd>Esc</kbd></button></div>
          </aside>
          <section className="settings-content" ref={settingsContentRef}>
            {settingsError && <div className="settings-error" role="alert">{settingsError}</div>}
            {!settingsData && !settingsError && settingsTab !== 'general' && <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在加载设置…</div>}
            {settingsTab === 'general' && (
              <div className="settings-sections general-settings">
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>界面模式</h2><p>选择 Pi Studio 的界面明暗；跟随系统会随 macOS 自动切换。</p></div></div>
                  <div className="theme-choice-row">
                    {([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map((item) => <button key={item.value} className={`theme-choice ${preferences.theme === item.value ? 'is-active' : ''}`} onClick={() => updatePreference('theme', item.value)}><item.icon /><span>{item.label}</span></button>)}
                  </div>
                </section>
                <section className="settings-card palette-settings-card">
                  <div className="settings-card-head"><div><h2>全局配色</h2><p>主色会同步应用到按钮、选中态、链接、焦点与加载动效。页面背景保持中性，成功、警告和错误仍使用固定语义色。</p></div></div>
                  <div className="palette-choice-grid" role="radiogroup" aria-label="全局配色方案">
                    {PALETTE_PRESETS.map((preset) => {
                      const active = preferences.palette === preset.id;
                      return <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`palette-choice ${active ? 'is-active' : ''}`}
                        data-palette-choice={preset.id}
                        key={preset.id}
                        onClick={() => updatePreference('palette', preset.id)}
                      >
                        <span className="palette-choice-preview" aria-hidden="true">
                          <span className="palette-preview-rail"><i /><i /><i /></span>
                          <span className="palette-preview-page">
                            <span className="palette-preview-heading" />
                            <span className="palette-preview-copy" />
                            <span className="palette-preview-copy is-short" />
                            <span className="palette-preview-actions"><i /><b /></span>
                          </span>
                        </span>
                        <span className="palette-choice-copy"><strong>{preset.label}</strong><small>{preset.description}</small></span>
                        <span className="palette-choice-check">{active && <Check />}</span>
                      </button>;
                    })}
                  </div>
                </section>
                <section className="settings-card background-settings-card">
                  <div className="settings-card-head"><div><h2>背景与动态氛围</h2><p>使用本地图片、动态图片或视频作为工作台背景。媒体会复制到 Pi Studio 的私有数据目录，原文件移动后仍可继续使用。</p></div></div>
                  <div className="background-settings-layout">
                    <div className="background-preview-column">
                      {preferences.backgroundMedia
                        ? <BackgroundMediaPreview media={preferences.backgroundMedia} onError={() => handleBackgroundUnavailable(preferences.backgroundMedia!.url)} />
                        : <div className="background-media-empty">
                          <span><ImageIcon /><Film /></span>
                          <strong>还没有设置背景</strong>
                          <small>支持图片、GIF、动态 WebP 和视频</small>
                        </div>}
                      <div className="background-media-actions">
                        <button type="button" className="settings-save" disabled={backgroundBusy} onClick={() => void chooseBackground()}>
                          {backgroundBusy ? <LoaderCircle className="spin" /> : <ImageIcon />}
                          {preferences.backgroundMedia ? '更换媒体' : '选择媒体'}
                        </button>
                        {preferences.backgroundMedia && <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={() => void removeBackground()}><Trash2 />移除</button>}
                      </div>
                      <p className="background-format-hint">PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V、WebM，最大 2 GB。</p>
                    </div>
                    <div className="background-control-column">
                      {backgroundError && <div className="background-setting-error" role="alert">{backgroundError}</div>}
                      {preferences.backgroundMedia && <div className="background-file-summary">
                        <span className={`background-file-kind ${preferences.backgroundMedia.kind === 'video' ? 'is-video' : 'is-image'}`}>{preferences.backgroundMedia.kind === 'video' ? <Film /> : <ImageIcon />}</span>
                        <span><strong title={preferences.backgroundMedia.name}>{preferences.backgroundMedia.name}</strong><small>{preferences.backgroundMedia.kind === 'video' ? '视频' : '图片'} · {filesize(preferences.backgroundMedia.bytes)}</small></span>
                      </div>}
                      <label className="background-slider" htmlFor="background-opacity">
                        <span><span><strong>背景透明度</strong><small>控制图片或视频在窗口中的可见程度。</small></span><output>{preferences.backgroundOpacity}%</output></span>
                        <input id="background-opacity" type="range" min="0" max="100" step="1" value={preferences.backgroundOpacity} disabled={!preferences.backgroundMedia} onChange={(event) => updatePreference('backgroundOpacity', Number(event.target.value))} />
                      </label>
                      <label className="background-slider" htmlFor="background-blur">
                        <span><span><strong>柔化程度</strong><small>轻微模糊背景，让文字与控件更安静。</small></span><output>{preferences.backgroundBlur} px</output></span>
                        <input id="background-blur" type="range" min="0" max="24" step="1" value={preferences.backgroundBlur} disabled={!preferences.backgroundMedia} onChange={(event) => updatePreference('backgroundBlur', Number(event.target.value))} />
                      </label>
                      <label className="background-slider" htmlFor="background-surface">
                        <span><span><strong>界面遮挡</strong><small>越高越清晰易读，越低越能看见背景细节。</small></span><output>{preferences.backgroundSurfaceOpacity}%</output></span>
                        <input id="background-surface" type="range" min="55" max="98" step="1" value={preferences.backgroundSurfaceOpacity} disabled={!preferences.backgroundMedia} onChange={(event) => updatePreference('backgroundSurfaceOpacity', Number(event.target.value))} />
                      </label>
                      {preferences.backgroundMedia?.kind === 'video' && <p className="background-video-hint"><Film />视频会自动静音循环；MOV 与 WebM 的播放能力取决于其编码格式。</p>}
                    </div>
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-profile-list">
                    <div className="settings-profile-row"><div><strong>菜单栏图标</strong><p>在 macOS 菜单栏显示运行数量；每轮完成后弹出结果卡片，可直接返回对应会话。</p></div><button className={`switch ${menuBarPreference.enabled ? 'is-on' : ''}`} role="switch" aria-checked={menuBarPreference.enabled} disabled={!menuBarPreference.available || menuBarBusy} title={menuBarPreference.available ? (menuBarPreference.enabled ? '隐藏菜单栏图标' : '显示菜单栏图标') : '当前平台不支持菜单栏图标'} onClick={() => void changeMenuBarVisibility(!menuBarPreference.enabled)}><span /></button></div>
                    <div className="settings-profile-row"><div><strong>圆角风格</strong><p>统一小元素、控件、卡片和大面板的圆角尺度。</p></div><div className="radius-control"><span className="radius-preview" aria-hidden="true"><i /><i /><i /><i /></span><Select label="圆角风格" value={preferences.radiusStyle} onChange={(value) => updatePreference('radiusStyle', value as Preferences['radiusStyle'])} options={[{ value: 'square', label: '直角' }, { value: 'compact', label: '紧凑' }, { value: 'standard', label: '标准' }, { value: 'soft', label: '圆润' }]} /></div></div>
                    <div className="settings-profile-row"><div><strong>字号大小</strong><p>仅影响对话内容的字号。</p></div><div className="settings-inline-control"><Select label="字号大小" value={String(preferences.fontSize)} onChange={(value) => updatePreference('fontSize', Number(value))} options={[12, 13, 14, 15, 16, 17].map((size) => ({ value: String(size), label: String(size) }))} /><span className="settings-unit">px</span></div></div>
                    <div className="settings-profile-row"><div><strong>工作步骤展示</strong><p>选择希望看到多少工具调用细节。</p></div><Select label="工作步骤展示" value={preferences.stepDisplay} onChange={(value) => updatePreference('stepDisplay', value as Preferences['stepDisplay'])} options={[{ value: 'compact', label: '精简' }, { value: 'standard', label: '标准' }, { value: 'detailed', label: '详细' }]} /></div>
                    <div className="settings-profile-row"><div><strong>工作步骤收起时机</strong><p>选择何时自动收起工作步骤。</p></div><Select label="工作步骤收起时机" value={preferences.stepCollapse} onChange={(value) => updatePreference('stepCollapse', value as Preferences['stepCollapse'])} options={[{ value: 'after-answer', label: '回答结束后' }, { value: 'keep-open', label: '保持展开' }, { value: 'manual', label: '手动控制' }]} /></div>
                    <div className="settings-profile-row"><div><strong>显示代码工作视图</strong><p>本轮回答结束后，显示工具确认的文件修改与可用差异。</p></div><button className={`switch ${preferences.showCodeView ? 'is-on' : ''}`} role="switch" aria-checked={preferences.showCodeView} onClick={() => updatePreference('showCodeView', !preferences.showCodeView)}><span /></button></div>
                    <div className="settings-profile-row"><div><strong>快捷键</strong><p>查看当前可用的键盘操作。</p></div><button className="settings-outline" onClick={() => setShortcutsOpen(true)}><Keyboard />编辑快捷键</button></div>
                    <div className="settings-profile-row"><div><strong>网页链接默认打开方式</strong><p>对话中网页链接的打开位置。</p></div><Select label="网页链接默认打开方式" value={preferences.linkOpen} onChange={(value) => updatePreference('linkOpen', value as Preferences['linkOpen'])} options={[{ value: 'external', label: '系统浏览器' }, { value: 'window', label: '应用内窗口' }]} /></div>
                    <div className="settings-profile-row"><div><strong>繁忙时的发送行为</strong><p>智能体运行时 Enter 键和发送按钮的行为。</p></div><Select label="繁忙时的发送行为" value={preferences.busySend} onChange={(value) => updatePreference('busySend', value as Preferences['busySend'])} options={[{ value: 'queue', label: '排队发送' }, { value: 'steer', label: '引导当前任务' }]} /></div>
                  </div>
                </section>
              </div>
            )}
            {settingsData && settingsTab === 'tools' && (
              <AgentToolsSettings
                cwd={workspace}
                initialSelection={settingsData.agentTools}
                configPath={settingsData.agentToolsPath}
                onSaved={(snapshot) => setSettingsData((current) => current ? { ...current, agentTools: snapshot.agentTools } : current)}
              />
            )}
            {settingsTab === 'subagents' && <SubagentSettings
              cwd={workspace}
              enabledAgentTools={settingsData?.agentTools.enabled}
              onOpenAgentTools={() => setSettingsTab('tools')}
            />}
            {settingsData && settingsTab === 'models' && (
              <div className="settings-sections">
                <section className="settings-card default-model-card">
                  <div className="settings-card-head">
                    <div>
                      <h2>新对话默认</h2>
                      <p>这里与 Pi CLI 的全局默认模型同步。打开历史会话时，仍会优先恢复那条会话自己最后使用的模型和思考等级。</p>
                    </div>
                    {defaultModelBusy && <span className="settings-save-status" role="status"><LoaderCircle className="spin" />同步中</span>}
                  </div>
                  <div className="default-model-panel">
                    <div className="default-model-identity">
                      <ProviderIcon provider={defaultModelItem?.provider || defaultModelSelection.modelRef.split('/')[0]} name={defaultModelProvider} icon={settingsData.providers.find((entry) => entry.id === defaultModelItem?.provider)?.icon} size={34} />
                      <span><small>当前新对话使用</small><strong>{defaultModelSelection.label || '尚未选择模型'}</strong><code>{defaultModelSelection.modelRef || '—'}</code></span>
                    </div>
                    <div className="default-model-fields">
                      <label>
                        <span>默认模型</span>
                        <Select label="新对话默认模型" value={defaultModelSelection.modelRef} options={defaultModelOptions} disabled={defaultModelBusy || defaultModelOptions.length === 0} onChange={(value) => void selectDefaultModel(value)} />
                      </label>
                      <label>
                        <span>默认思考强度</span>
                        <Select label="新对话默认思考强度" value={defaultModelSelection.thinkingLevel} options={defaultThinkingOptions} disabled={defaultModelBusy || defaultThinkingOptions.length <= 1} onChange={(value) => void selectDefaultThinking(value as ThinkingLevel)} />
                      </label>
                    </div>
                  </div>
                  <p className="default-model-note"><Info />App 中修改会立即写入 Pi；终端里修改后，App 会在启动或刷新模型目录时同步。历史会话的临时切换只影响该会话。</p>
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>已启用模型 <span className="count-badge">{enabledModels.length}</span></h2><p>这里管理所有会话可用的模型；具体使用哪个模型，在对话输入框中选择。</p></div></div>
                  {enabledModels.length > 0 ? <>
                    <div className="model-view-bar"><span>查看方式</span><div className="model-view-toggle" role="group" aria-label="模型查看方式"><button className={modelView === 'all' ? 'is-active' : ''} onClick={() => setModelView('all')}>全部</button><button className={modelView === 'provider' ? 'is-active' : ''} onClick={() => setModelView('provider')}>按来源</button></div></div>
                    {modelView === 'all' ? <div className="model-card-grid">{enabledModels.map(renderModelCard)}</div> : <div className="model-groups">{enabledModelGroups.map((group) => <section className="model-group" key={group.name}><div className="model-group-head"><ProviderIcon className="model-card-avatar" provider={group.provider} name={group.name} icon={settingsData?.providers.find((entry) => entry.id === group.provider)?.icon} size={22} /><strong>{group.name}</strong><span>{group.ids.length}</span></div><div className="model-card-grid">{group.ids.map(renderModelCard)}</div></section>)}</div>}
                  </> : <div className="settings-empty">在下方添加来源，再选择要启用的模型。</div>}
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>模型来源 <span className="count-badge">{settingsData.providers.length}</span></h2><p>来源负责连接与认证；模型在对应来源内单独添加、发现和管理。</p></div><button className="settings-add-button" aria-label="添加模型来源" onClick={() => void openEditor('provider')}><Plus />添加来源</button></div>
                  <div className="provider-cards">
                    {settingsData.providers.map((provider) => {
                      const list = providerModels[provider.id] ?? [];
                      const filtered = list.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
                      const discovery = providerDiscovery[provider.id];
                      const discoveredMissing = (discovery?.models || []).filter((item) => !list.some((model) => model.model === item.id));
                      return <article className={`provider-card ${expandedProvider === provider.id ? 'is-expanded' : ''}`} key={provider.id}>
                        <div className="provider-card-head">
                          <ProviderIcon className="provider-avatar" provider={provider.id} name={provider.name} icon={provider.icon} size={36} />
                          <div className="provider-main"><strong>{provider.name}</strong><span><code>{provider.id}</code><i />{provider.models} 个模型</span></div>
                          <span className={`provider-mode ${provider.authConfigured === false ? 'is-missing' : ''}`}>{provider.authConfigured === false ? '未配置凭据' : provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key'}</span>
                          <div className="row-actions"><button className="icon-button row-edit" aria-label={`编辑 ${provider.name}`} title="编辑连接" onClick={() => void openEditor('provider', provider.id)}><Pencil /></button><button className="settings-outline row-action" onClick={() => void loadProviderModels(provider.id)} aria-expanded={expandedProvider === provider.id}>{expandedProvider === provider.id ? '收起' : '管理模型'}</button></div>
                        </div>
                        {provider.authConfigured === false && <p className="provider-auth-hint">已启用此来源的模型，但尚未配置凭据。点击“编辑”完成连接。</p>}
                        {provider.mode === 'env' && <div className={`provider-env-hint ${provider.envAvailable ? 'is-set' : ''}`}>{provider.envAvailable ? '环境变量已设置' : '环境变量未设置'} · <code>{provider.envName}</code></div>}
                        {expandedProvider === provider.id && <div className="provider-model-panel">
                          <div className="provider-model-head">
                            <div><strong>模型目录</strong><span>{list.length > 0 ? `${list.filter((item) => enabledModels.includes(item.id)).length} 个已启用 · 共 ${list.length} 个` : '这个来源还没有模型'}</span></div>
                            <div className="provider-model-actions">
                              <button className="settings-outline" disabled={discovery?.loading || settingsBusy} onClick={() => void discoverProviderModels(provider.id)}><RotateCw className={discovery?.loading ? 'spin' : ''} />获取模型</button>
                              <button className="settings-add-button" onClick={() => openModelEditor(provider.id)}><Plus />添加模型</button>
                            </div>
                          </div>
                          <div className="provider-model-tools">
                            <div className="provider-model-search"><Search /><input className="model-search" aria-label={`搜索 ${provider.name} 的模型`} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索名称或模型 ID…" /></div>
                            <span>{provider.modelsUrl ? '已配置模型列表地址' : '未配置地址时自动尝试 /models'}</span>
                          </div>
                          {discovery && <div className={`provider-discovery-panel ${discovery.error ? 'is-error' : ''}`} aria-live="polite">
                            <div className="provider-discovery-head">
                              <div>
                                <strong>{discovery.loading ? '正在读取模型列表…' : discovery.error ? '模型发现失败' : `发现 ${discovery.models?.length || 0} 个模型`}</strong>
                                {discovery.endpoint && <code>{discovery.endpoint}</code>}
                                {discovery.error && <p>{discovery.error}</p>}
                                {!discovery.loading && !discovery.error && discovery.imported !== undefined && <p>已同步 {discovery.imported} 个新模型，可逐个调整能力与上下文。</p>}
                              </div>
                              <button className="icon-button" aria-label="关闭模型发现结果" title="关闭" onClick={() => setProviderDiscovery((current) => {
                                const next = { ...current };
                                delete next[provider.id];
                                return next;
                              })}><X /></button>
                            </div>
                            {!discovery.loading && !discovery.error && <div className="provider-discovery-body">
                              <div className="provider-discovery-list">{(discovery.models || []).map((item) => <span key={item.id}>{item.name}</span>)}{!discovery.models?.length && <small>接口返回了空列表。</small>}</div>
                              <button className="settings-save" disabled={discoveredMissing.length === 0 || discovery.importing} onClick={() => void importProviderModels(provider.id, discoveredMissing)}>{discovery.importing ? <LoaderCircle className="spin" /> : <Plus />}{discoveredMissing.length > 0 ? `添加 ${discoveredMissing.length} 个` : '已全部添加'}</button>
                            </div>}
                          </div>}
                          <div className="provider-model-list">
                            {filtered.slice(0, 300).map((item) => <div className="provider-model-row" key={item.id}>
                              <label className="provider-model-check" title={enabledModels.includes(item.id) ? '停用模型' : '启用模型'}>
                                <input type="checkbox" aria-label={`${enabledModels.includes(item.id) ? '停用' : '启用'}模型 ${item.name}`} disabled={settingsBusy} checked={enabledModels.includes(item.id)} onChange={(event) => void setEnabled(event.target.checked ? [...enabledModels, item.id] : enabledModels.filter((id) => id !== item.id))} />
                              </label>
                              <div className="provider-model-identity"><strong>{item.name}</strong><code>{item.model}</code></div>
                              <div className="model-capabilities">
                                {item.contextWindow && <span>{Math.round(item.contextWindow / 1000)}K 上下文</span>}
                                {item.maxTokens && <span>{Math.round(item.maxTokens / 1000)}K 输出</span>}
                                {item.supportsImages && <span>图片</span>}
                                {item.reasoning && <span>推理</span>}
                                {item.origin === 'configured' && <span className="is-origin">自定义</span>}
                                {item.origin === 'override' && <span className="is-origin">已覆盖</span>}
                              </div>
                              <div className="provider-model-row-actions">
                                <button className="icon-button row-edit" aria-label={`编辑模型 ${item.name}`} title={item.origin === 'builtin' ? '覆盖内置模型参数' : '编辑模型'} onClick={() => openModelEditor(provider.id, item)}><Pencil /></button>
                                {item.deletable && <button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`${item.origin === 'override' ? '恢复' : '删除'}模型 ${item.name}`} title={item.origin === 'override' ? '恢复内置参数' : '删除模型'} onClick={() => void deleteCustomModel(provider.id, item)}><Trash2 /></button>}
                              </div>
                            </div>)}
                            {filtered.length === 0 && (list.length > 0
                              ? <div className="settings-empty">没有匹配的模型。</div>
                              : providerModels[provider.id]
                                ? <div className="provider-model-empty"><Layers3 /><strong>这个来源还没有模型</strong><span>手动添加，或从来源的模型列表接口导入。</span><div><button className="settings-outline" onClick={() => openModelEditor(provider.id)}><Plus />添加模型</button><button className="settings-outline" onClick={() => void discoverProviderModels(provider.id)}><RotateCw />获取模型</button></div></div>
                                : <div className="settings-empty"><LoaderCircle className="spin" />正在加载模型…</div>)}
                          </div>
                        </div>}
                      </article>;
                    })}
                    {settingsData.providers.length === 0 && <div className="settings-empty">还没有模型来源，添加一个开始使用。</div>}
                  </div>
                </section>
              </div>
            )}
            {settingsData && settingsTab === 'mcp' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>MCP 服务器 <span className="count-badge">{settingsData.mcp.length}</span></h2><p>管理外部工具与数据连接。</p></div><button className="settings-add-button" aria-label="添加 MCP 服务器" onClick={() => void openEditor('mcp')}>添加</button></div>
                <div className="mcp-card-grid">
                  {settingsData.mcp.map((server) => <article className={`mcp-card ${server.enabled ? 'is-on' : ''}`} key={server.name}>
                    <div className="mcp-card-head"><span className="mcp-card-icon"><Plug /></span><div className="provider-main"><strong>{server.name}</strong><span>{server.transport === 'stdio' ? '本地进程' : 'HTTP 服务'}</span></div><button className={`switch ${server.enabled ? 'is-on' : ''}`} role="switch" aria-checked={server.enabled} disabled={settingsBusy} onClick={() => void toggleMcp(server.name, !server.enabled)} aria-label={`${server.name} ${server.enabled ? '禁用' : '启用'}`}><span /></button></div>
                    <p className="mcp-card-description">{server.description || '没有填写描述'}</p>
                    <code className="mcp-card-target" title={server.target}>{server.target}</code>
                    <div className="mcp-card-footer"><span className={`resource-status ${server.enabled ? 'is-on' : ''}`}>{server.enabled ? '已启用' : '已停用'}</span><button className="settings-text-button" onClick={() => setMcpDetail(server)}>查看详情</button><button className="icon-button row-edit" aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => void openEditor('mcp', server.name)}><Pencil /></button><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除 MCP ${server.name}`} title="删除" onClick={() => void deleteMcp(server.name)}><Trash2 /></button></div>
                  </article>)}
                  {settingsData.mcp.length === 0 && <div className="settings-empty">还没有 MCP 服务器。</div>}
                </div>
                <p className="settings-footnote">更改会在新会话中生效。</p>
              </section>
            )}
            {settingsData && settingsTab === 'skills' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>全局技能 <span className="count-badge">{settingsData.skills.length}</span></h2><p>只展示 ~/.agents/skills 和 Pi agent skills，不读取项目目录。</p></div><button className="settings-add-button" aria-label="添加全局技能" onClick={() => void openEditor('skill')}>添加</button></div>
                <div className="skill-group-sections">
                  {globalSkillGroups.map((group) => <section className="skill-source-group" key={group.key}>
                    <div className="skill-source-head"><h3>{group.label}</h3><span className="count-badge">{group.items.length}</span></div>
                    {group.items.length > 0 ? <div className="skill-card-grid">
                      {group.items.map((skill) => <article className="skill-card" key={skill.path}>
                        <button className="skill-card-main" onClick={() => openSkillDetail(skill)}>
                          <span className="skill-card-icon"><FileCode2 /></span>
                          <span className="skill-card-body"><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.path}</small></span>
                          <ChevronRight />
                        </button>
                      </article>)}
                    </div> : <div className="settings-empty settings-empty--small">这个目录下还没有技能。</div>}
                  </section>)}
                </div>
                <p className="settings-footnote">技能修改后在新会话中使用。</p>
              </section>
            )}
            {settingsData && settingsTab === 'extensions' && (
              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <h2>已安装扩展 <span className="count-badge">{settingsData.packages.length + settingsData.extensions.length}</span></h2>
                    <p>扩展包与本地扩展统一显示。每个项目会标明安装来源和生效范围。</p>
                  </div>
                  <button className="settings-add-button" aria-label="添加扩展" onClick={() => void openEditor('extension-install')}><Plus />添加扩展</button>
                </div>
                <div className="installed-extension-list">
                  {settingsData.packages.map((pkg) => <article className="installed-extension-row" key={`package:${pkg.source}`}>
                    <span className="installed-extension-icon"><Layers3 /></span>
                    <div className="installed-extension-main">
                      <div className="installed-extension-title"><strong>{pkg.name}</strong><span className="extension-kind-badge">{packageSourceLabel(pkg.source)}</span><span className="extension-scope-badge">{pkg.scope === 'project' ? '当前项目' : '全局'}</span></div>
                      <code title={pkg.source}>{pkg.source}</code>
                    </div>
                    <button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`移除扩展包 ${pkg.name}`} title="移除扩展包" onClick={() => void removePackage(pkg.source)}><Trash2 /></button>
                  </article>)}
                  {settingsData.extensions.map((item) => <article className="installed-extension-row" key={`local:${item.path}`}>
                    <span className="installed-extension-icon"><Plug /></span>
                    <div className="installed-extension-main">
                      <div className="installed-extension-title"><strong>{item.name}</strong><span className="extension-kind-badge">{item.kind === 'directory' ? '本地目录' : '本地文件'}</span><span className="extension-scope-badge">{item.scope === 'project' ? '当前项目' : '全局'}</span></div>
                      <code title={item.path}>{item.path}</code>
                    </div>
                    <button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除扩展 ${item.name}`} title="删除本地扩展" onClick={() => void deleteExtension(item.path, item.name)}><Trash2 /></button>
                  </article>)}
                  {settingsData.packages.length + settingsData.extensions.length === 0 && <div className="settings-empty">还没有安装扩展。可以安装 npm / Git 扩展包，或导入本地扩展文件。</div>}
                </div>
                <p className="settings-footnote">扩展会直接在本机运行并访问会话资源，请只安装可信来源。</p>
              </section>
            )}
            {settingsData && settingsTab === 'about' && (
              <div className="about-page">
                <section className="about-hero-card">
                  <span className="about-watermark" aria-hidden="true">π</span>
                  <div className="about-hero-main">
                    <div className="about-eyebrow"><i />Pi Coding Agent 桌面工作台<span>macOS</span></div>
                    <div className="about-lockup">
                      <BrandMark className="about-app-icon" />
                      <div><h1>Pi Studio</h1><p>让想法，在这里成为现实。</p></div>
                    </div>
                    <p className="about-lead">一个为 Pi Coding Agent 打造的桌面工作台。把长对话、代码差异、多子 Agent 协作和本地工作区放进同一套安静、清晰的界面里。</p>
                    <div className="about-actions">
                      <button type="button" className="about-action-primary" onClick={openUpdateDialog}><RotateCw />检查更新</button>
                      <button type="button" className="about-action-secondary" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio')}><Github />查看源码</button>
                    </div>
                    <div className="about-feature-pills">
                      <span><Monitor />macOS 原生体验</span>
                      <span><ShieldCheck />配置与会话保存在本地</span>
                      <span><Bot />Pi Agent 驱动</span>
                    </div>
                  </div>
                  <aside className="about-release-card">
                    <span className="about-release-label">当前版本</span>
                    <strong>{updateSnapshot.currentVersion ? `v${updateSnapshot.currentVersion}` : 'DEV'}</strong>
                    <div className="about-release-status"><i />GitHub Releases</div>
                    {updateSnapshot.state === 'available' && updateSnapshot.latestVersion
                      ? <p>发现新版本 v{updateSnapshot.latestVersion}</p>
                      : <p>通过 GitHub Releases 获取稳定更新。</p>}
                    <button type="button" onClick={openUpdateDialog}>版本与更新 <ChevronRight /></button>
                  </aside>
                </section>

                <div className="about-info-grid">
                  <article className="about-info-card about-author-card">
                    <div className="about-info-head"><span><UserRound /></span><small>设计与开发</small></div>
                    <h2>huangrx6</h2>
                    <p>Pi Studio 的创建者，专注于把复杂的 Agent 工作流做成人愿意每天使用的工具。</p>
                    <button type="button" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6')}>GitHub 主页 <ExternalLink /></button>
                  </article>
                  <article className="about-info-card">
                    <div className="about-info-head"><span><Cpu /></span><small>Agent 内核</small></div>
                    <h2>Pi Coding Agent</h2>
                    <code>@earendil-works/pi-coding-agent</code>
                    <p>负责模型会话、工具调用、扩展运行与会话持久化。</p>
                  </article>
                  <article className="about-info-card">
                    <div className="about-info-head"><span><ShieldCheck /></span><small>开源许可</small></div>
                    <h2>MIT License</h2>
                    <p>源码开放，欢迎阅读、改进和基于自己的需求继续构建。</p>
                    <button type="button" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio/blob/main/LICENSE')}>查看许可 <ExternalLink /></button>
                  </article>
                </div>

                <section className="about-resource-card">
                  <div className="about-resource-head"><div><h2>资源与支持</h2><p>文档、源码和问题反馈都在 GitHub 上持续更新。</p></div><span>Resources</span></div>
                  <div className="about-resource-links">
                    <button type="button" onClick={() => void window.piApi.openExternal('https://huangrx6.github.io/pi-studio/')}><span><BookOpen /></span><div><strong>使用文档</strong><small>安装、配置与工作流说明</small></div><ExternalLink /></button>
                    <button type="button" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio')}><span><Github /></span><div><strong>GitHub 仓库</strong><small>关注最新提交与版本</small></div><ExternalLink /></button>
                    <button type="button" onClick={() => void window.piApi.openExternal('https://github.com/huangrx6/pi-studio/issues')}><span><MessageSquare /></span><div><strong>问题反馈</strong><small>报告问题和提出建议</small></div><ExternalLink /></button>
                  </div>
                </section>

                <details className="about-system-card">
                  <summary><span><FileCode2 /></span><div><strong>本地配置与诊断信息</strong><small>查看 Pi 实际使用的配置文件路径</small></div><ChevronDown /></summary>
                  <dl>
                    <div><dt>凭据文件</dt><dd>{settingsData.authPath}</dd></div>
                    <div><dt>MCP 配置</dt><dd>{settingsData.mcpPath}</dd></div>
                    <div><dt>模型配置</dt><dd>{settingsData.modelsPath}</dd></div>
                  </dl>
                </details>
              </div>
            )}
          </section>
          {editor && <SettingsDialog
            title={editor.kind === 'provider' ? editor.editId ? '编辑模型来源' : '添加模型来源' : editor.kind === 'model' ? editor.editId ? (customModel.origin === 'builtin' ? '调整内置模型' : '编辑模型') : '添加模型' : editor.kind === 'mcp' ? editor.editId ? '编辑 MCP 服务器' : '添加 MCP 服务器' : editor.kind === 'extension-install' ? '添加扩展' : editor.kind === 'package' ? '安装扩展包' : editor.kind === 'skill' ? '添加技能' : '添加本地扩展'}
            description={editor.kind === 'mcp' ? '配置工具连接，保存后在新会话中生效。' : editor.kind === 'provider' ? '这里只保存连接与认证；模型在来源卡片内独立管理。' : editor.kind === 'model' ? `模型将归属到 ${settingsData?.providers.find((provider) => provider.id === customModel.providerId)?.name || customModel.providerId}。` : editor.kind === 'extension-install' ? '安装扩展包，或从本机导入一个 Pi 扩展。' : editor.kind === 'package' ? '请输入可信的扩展包地址。' : '选择生效范围，再从本机导入。'}
            action={editor.kind === 'extension-install' ? extensionInstallMode === 'package' ? '安装扩展' : '选择并导入' : editor.kind === 'skill' ? '选择文件夹并添加' : editor.kind === 'extension' ? '选择文件并添加' : editor.kind === 'package' ? '安装' : editor.editId ? '保存更改' : '添加'}
            busy={settingsBusy} loading={editorLoading} unavailable={editor.kind === 'extension-install' ? extensionInstallMode === 'package' && !packageDraft.trim() : Boolean(editor.editId && (editor.kind === 'provider' ? !providerDraft.providerId : editor.kind === 'mcp' ? !originalMcpArgsRef.current : editor.kind === 'model' ? !customModel.modelId : false))} error={editorError} onClose={closeEditor} onSubmit={submitEditor}>
            {editor.kind === 'provider' && <div className="settings-form-grid">
              <label>来源 ID<input autoFocus={!editor.editId} required disabled={Boolean(editor.editId)} value={providerDraft.providerId} onChange={(event) => setProviderDraft({ ...providerDraft, providerId: event.target.value })} placeholder="my-provider" /></label>
              <label>显示名称<input required value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} placeholder="例如 My Gateway" /></label>
              <div className="settings-field"><span>API 类型</span><Select label="API 类型" value={providerDraft.api} onChange={(value) => setProviderDraft({ ...providerDraft, api: value })} options={[...apiTypeOptions, ...(apiTypeOptions.some((option) => option.value === providerDraft.api) ? [] : [{ value: providerDraft.api, label: providerDraft.api }])]} /></div>
              <label>服务地址<input autoFocus={Boolean(editor.editId)} required type="url" value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label className="field-wide">API Key<input aria-label="API Key" aria-describedby="provider-key-help" type="password" autoComplete="new-password" value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} placeholder={editor.editId ? '已保存的凭据不显示，留空保持原值' : '密钥值或 $ENV_VAR'} /><small id="provider-key-help">填写密钥值，或环境变量名（如 ZAI_CODING_CN_API_KEY、$ZAI_CODING_CN_API_KEY）。macOS 会读取 shell 中 export 的变量；保存时检查是否可读取。</small></label>
              <label>模型列表地址<input aria-label="模型列表地址" type="url" value={providerDraft.modelsUrl} onChange={(event) => setProviderDraft({ ...providerDraft, modelsUrl: event.target.value })} placeholder="可选，留空自动使用服务地址/models" /><small>支持常见 OpenAI `/models` 响应。保存后可在来源卡片内获取并预览模型。</small></label>
              <label>图标 URL<input value={providerDraft.icon} onChange={(event) => setProviderDraft({ ...providerDraft, icon: event.target.value })} placeholder="可选，https://... 或 data:image/..." /><small>用于替换默认的品牌图标，留空使用内置图标。</small></label>
              <div className="provider-flow-note field-wide"><span><Cpu /></span><div><strong>来源和模型分开配置</strong><p>保存来源后，在来源卡片中手动添加模型，或从模型列表接口批量导入。每个模型可单独设置输入能力、推理和 Token 限制。</p></div></div>
            </div>}
            {editor.kind === 'model' && <div className="settings-form-grid model-editor-form">
              <div className="settings-field field-wide"><span>模型来源</span><Select label="模型来源" disabled value={customModel.providerId} onChange={() => {}} options={(settingsData?.providers ?? []).filter((provider) => provider.id === customModel.providerId).map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.id}` }))} /></div>
              <label>模型 ID<input autoFocus required disabled={Boolean(editor.editId)} value={customModel.modelId} onChange={(event) => setCustomModel({ ...customModel, modelId: event.target.value })} placeholder="model-id" /></label>
              <label>显示名称<input value={customModel.name} onChange={(event) => setCustomModel({ ...customModel, name: event.target.value })} placeholder="可选，默认使用模型 ID" /></label>
              <label>上下文长度<input type="number" min="1" step="1" value={customModel.contextWindow} onChange={(event) => setCustomModel({ ...customModel, contextWindow: event.target.value })} placeholder="默认值" /></label>
              <label>最大输出<input type="number" min="1" step="1" value={customModel.maxTokens} onChange={(event) => setCustomModel({ ...customModel, maxTokens: event.target.value })} placeholder="默认值" /></label>
              <div className="model-capability-options field-wide" role="group" aria-label="模型能力">
                <label className={customModel.supportsImages ? 'is-selected' : ''}><input type="checkbox" checked={customModel.supportsImages} onChange={(event) => setCustomModel({ ...customModel, supportsImages: event.target.checked })} /><span><strong>图片输入</strong><small>允许在对话中发送图片</small></span><ImageIcon /></label>
                <label className={customModel.reasoning ? 'is-selected' : ''}><input type="checkbox" checked={customModel.reasoning} onChange={(event) => setCustomModel({ ...customModel, reasoning: event.target.checked })} /><span><strong>推理模型</strong><small>支持 Thinking 强度设置</small></span><Sparkles /></label>
              </div>
              {customModel.origin === 'builtin' && <p className="model-editor-note field-wide"><Info />这是 Pi 内置模型。保存会在当前来源中建立参数覆盖，不会替换同一来源的其他内置模型。</p>}
            </div>}
            {editor.kind === 'mcp' && <div className="settings-form-grid">
              <label>名称<input autoFocus required value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} placeholder="例如 filesystem" /></label>
              <div className="settings-field"><span>传输方式</span><Select label="传输方式" value={mcpDraft.transport} onChange={(value) => setMcpDraft({ ...mcpDraft, transport: value })} options={[{ value: 'stdio', label: '本地进程 · stdio' }, { value: 'http', label: 'Streamable HTTP' }]} /></div>
              <label className="field-wide">描述<input value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.target.value })} placeholder="简要说明用途，可选" /></label>
              {mcpDraft.transport === 'stdio' ? <><label className="field-wide">启动命令<input required value={mcpDraft.command} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} placeholder="npx" /></label><label className="field-wide">启动参数<textarea aria-label="启动参数" aria-describedby="mcp-args-help" value={mcpDraft.args} onChange={(event) => setMcpDraft({ ...mcpDraft, args: event.target.value })} rows={4} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'} /><small id="mcp-args-help">每行一个参数，路径中的空格会保留。</small></label></> : <label className="field-wide">服务器地址<input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
              <label className="field-wide">环境变量<textarea aria-label="环境变量" value={mcpDraft.env} onChange={(event) => setMcpDraft({ ...mcpDraft, env: event.target.value })} rows={3} placeholder={'TOKEN=...\nBASE_URL=https://...'} /><small>每行一个 KEY=value，留空表示不设置。</small></label>
            </div>}
            {editor.kind === 'extension-install' && <div className="extension-install-form">
              <div className="extension-install-methods" role="radiogroup" aria-label="扩展安装方式">
                <label className={extensionInstallMode === 'package' ? 'is-selected' : ''}><input type="radio" name="extension-install-mode" checked={extensionInstallMode === 'package'} onChange={() => setExtensionInstallMode('package')} /><span><Layers3 /></span><div><strong>安装扩展包</strong><small>从 npm、Git 或本地包路径安装，由 Pi 统一管理。</small></div></label>
                <label className={extensionInstallMode === 'local' ? 'is-selected' : ''}><input type="radio" name="extension-install-mode" checked={extensionInstallMode === 'local'} onChange={() => setExtensionInstallMode('local')} /><span><Folder /></span><div><strong>导入本地扩展</strong><small>复制一个扩展文件或目录到 Pi 扩展目录。</small></div></label>
              </div>
              {extensionInstallMode === 'package' ? <div className="settings-form-grid"><label className="field-wide">扩展包来源<input aria-label="扩展包地址" autoFocus required value={packageDraft} onChange={(event) => setPackageDraft(event.target.value)} placeholder="npm:pi-tools 或 git:github.com/user/pi-plugin" /><small>支持 npm、Git 和本地 package 路径。扩展拥有本机访问权限，请确认来源可信。</small></label></div> : <div className="resource-import"><span className="field-label">生效范围</span><div className="scope-options"><label className={resourceScope === 'user' ? 'is-selected' : ''}><input type="radio" name="extension-scope" checked={resourceScope === 'user'} onChange={() => setResourceScope('user')} /><div><strong>全局</strong><span>在所有工作区中使用</span></div></label><label className={resourceScope === 'project' ? 'is-selected' : ''}><input type="radio" name="extension-scope" disabled={!workspace} checked={resourceScope === 'project'} onChange={() => setResourceScope('project')} /><div><strong>当前项目</strong><span>{activeWorkspace?.name || '请先选择工作区'}</span></div></label></div><p className="import-note">选择扩展文件，或包含 index.ts / index.js 的扩展目录。文件会被复制到 Pi 的扩展目录。</p></div>}
            </div>}
            {editor.kind === 'package' && <div className="settings-form-grid"><label className="field-wide">扩展包地址<input aria-label="扩展包地址" autoFocus required value={packageDraft} onChange={(event) => setPackageDraft(event.target.value)} placeholder="npm:pi-tools 或 git:github.com/user/pi-plugin" /><small>扩展拥有本机访问权限，请确认来源可信。</small></label></div>}
            {editor.kind === 'skill' && <div className="resource-import"><span className="field-label">生效范围</span><div className="scope-options"><label className={resourceScope === 'user' ? 'is-selected' : ''}><input type="radio" name="scope" checked={resourceScope === 'user'} onChange={() => setResourceScope('user')} /><div><strong>全局</strong><span>在所有工作区中使用</span></div></label></div><p className="import-note">请选择包含 SKILL.md 的技能文件夹。</p></div>}
          </SettingsDialog>}
        </div>
      )}

      {/* 工具权限确认与完全权限风险确认 */}
      {confirmRequest && <ToolConfirmDialog
        request={confirmRequest}
        onRespond={(accepted) => {
          const id = confirmRequest.id;
          setConfirmRequest(null);
          window.piApi.confirmResponse({ id, accepted });
        }}
      />}
      {fullPermissionOpen && <FullPermissionDialog
        acknowledged={fullPermissionAck}
        onAcknowledgedChange={setFullPermissionAck}
        onCancel={() => setFullPermissionOpen(false)}
        onConfirm={() => { setFullPermissionOpen(false); void applyPermission('full'); }}
      />}
      {updateDialogOpen && <UpdateDialog
        snapshot={updateSnapshot}
        onClose={() => setUpdateDialogOpen(false)}
        onCheck={checkUpdates}
        onDownload={downloadUpdate}
        onInstall={installUpdate}
      />}

      {/* MCP 详情弹窗 */}
      {mcpDetail && (
        <DetailDialog className="detail-dialog--small" onClose={() => setMcpDetail(null)}>
            <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Plug /></span><div><h2>{mcpDetail.name}</h2><p>{mcpDetail.transport === 'stdio' ? '本地进程 · stdio' : 'HTTP 服务'}</p></div></div><button className="icon-button" aria-label="关闭详情" onClick={() => setMcpDetail(null)}><X /></button></header>
            <div className="detail-body">
              <dl className="detail-list">
                <div><dt>状态</dt><dd>{mcpDetail.enabled ? '已启用' : '已停用'}</dd></div>
                <div><dt>传输</dt><dd>{mcpDetail.transport}</dd></div>
                <div><dt>目标</dt><dd><code>{mcpDetail.target}</code></dd></div>
                <div><dt>描述</dt><dd>{mcpDetail.description || '没有填写描述'}</dd></div>
              </dl>
            </div>
            <footer className="detail-footer"><button className="settings-text-button is-danger" onClick={() => { const name = mcpDetail.name; setMcpDetail(null); void deleteMcp(name); }}>删除</button><span /><button className="settings-outline" onClick={() => setMcpDetail(null)}>关闭</button><button className="settings-outline" onClick={() => { const name = mcpDetail.name; setMcpDetail(null); void openEditor('mcp', name); }}><Pencil />编辑</button></footer>
        </DetailDialog>
      )}

      {/* 技能详情弹窗：左侧文件树 + 右侧预览 */}
      {skillDetail && (
        <DetailDialog className="skill-detail-dialog" onClose={closeSkillDetail}>
            <header className="detail-header"><div className="detail-heading"><span className="detail-icon is-skill"><FileCode2 /></span><div><h2>{skillDetail.name}</h2><p>{skillDetail.description}</p></div></div><button className="icon-button" aria-label="关闭技能详情" onClick={closeSkillDetail}><X /></button></header>
            <div className="skill-detail-path"><code>{skillDetail.path}</code></div>
            {skillDetailError && <div className="detail-error">{skillDetailError}</div>}
            <div className="skill-detail-body">
              <aside className="skill-file-tree">
                <div className="skill-tree-toolbar"><button className="icon-button" aria-label="返回上级目录" disabled={!skillTreePath} onClick={() => void loadSkillTree(skillDetail.baseDir, skillTreePath.split('/').slice(0, -1).join('/'))}><ChevronLeft /></button><span>{skillTreePath ? `/${skillTreePath}` : '/'}</span><button className="icon-button" aria-label="刷新技能文件" onClick={() => void loadSkillTree(skillDetail.baseDir, skillTreePath)}><RotateCw /></button></div>
                <div className="skill-tree-list">{skillEntries.map((entry) => <button key={entry.path} className={`file-row ${entry.type === 'directory' ? 'is-directory' : ''}`} onClick={() => entry.type === 'directory' ? void loadSkillTree(skillDetail.baseDir, entry.path) : void openSkillFile(entry.path)}>{entry.type === 'directory' ? <Folder /> : <FileText />}<span>{entry.name}</span>{entry.type === 'file' && <small>{filesize(entry.size)}</small>}{entry.type === 'directory' && <ChevronRight />}</button>)}</div>
              </aside>
              <section className="skill-file-preview">
                {skillFile ? <><div className="file-toolbar"><span className="path-label">{skillFile.path}</span><small>{filesize(skillFile.size)}</small></div>{skillFile.binary ? <div className="panel-empty"><FileText /><strong>无法预览此文件</strong></div> : <pre className="detail-code">{skillFile.text}</pre>}</> : <div className="panel-empty"><FileCode2 /><strong>选择一个文件</strong><span>查看技能目录下的 SKILL.md 和配套文件。</span></div>}
                {skillBusy && <div className="detail-loading"><LoaderCircle className="spin" />正在读取…</div>}
              </section>
            </div>
            <footer className="detail-footer"><button className="settings-text-button is-danger" disabled={settingsBusy} onClick={() => void removeSkillFromDetail()}>删除技能</button><span /><button className="settings-outline" onClick={closeSkillDetail}>关闭</button></footer>
        </DetailDialog>
      )}

      {/* 快捷键说明 */}
      {shortcutsOpen && <DetailDialog className="shortcuts-dialog" onClose={() => setShortcutsOpen(false)}>
        <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Keyboard /></span><div><h2>快捷键</h2><p>Pi Studio 桌面端当前可用的键盘操作。</p></div></div><button className="icon-button" aria-label="关闭快捷键" onClick={() => setShortcutsOpen(false)}><X /></button></header>
        <div className="shortcut-list">
          {[['发送消息', 'Enter'], ['换行', 'Shift + Enter'], ['打开命令与技能', '/'], ['引用工作区文件', '@'], ['关闭浮层', 'Esc'], ['打开设置', 'Cmd + ,']].map(([label, key]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
        </div>
        <footer className="detail-footer"><span /><button className="settings-outline" onClick={() => setShortcutsOpen(false)}>关闭</button></footer>
      </DetailDialog>}

      {tabMenu && <ActionMenu x={tabMenu.x} y={tabMenu.y} onClose={closeTabMenu} items={[
        { label: '关闭标签页', run: () => closePanelTab(tabMenu.id) },
        { label: '关闭左侧标签页', disabled: panelTabs.findIndex(tab => tab.id === tabMenu.id) <= 0, run: () => closePanelTabs(tabMenu.id, 'left') },
        { label: '关闭右侧标签页', disabled: panelTabs.findIndex(tab => tab.id === tabMenu.id) === panelTabs.length-1, run: () => closePanelTabs(tabMenu.id, 'right') },
        { label: '关闭其他标签页', disabled: panelTabs.length <= 1, run: () => closePanelTabs(tabMenu.id, 'others') },
        { label: '关闭所有标签页', run: () => closePanelTabs(tabMenu.id, 'all') },
      ]} />}
      {/* 右侧工作台：标签、文件树与预览 */}
      {filesOpen && (
        <>
        {!panelFullscreen && <button className="file-panel-backdrop" aria-label="关闭右侧面板" tabIndex={-1} onClick={closePanel} />}
        <aside className={`file-panel ${panelEntered ? 'is-open' : ''} ${panelFullscreen ? 'is-fullscreen' : ''} ${panelSplit ? 'is-split' : ''} ${panelResizing ? 'is-resizing' : ''}`} style={{ '--panel-w': `${Number.isFinite(panelWidth) ? panelWidth : 700}px` } as CSSProperties}>
          {!panelFullscreen && <div className="panel-resize-handle" role="separator" aria-label="调整右侧面板宽度" aria-orientation="vertical" aria-valuenow={panelWidth} aria-valuemin={320} aria-valuemax={window.innerWidth - 48} tabIndex={0}
            onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); panelDrag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width }; setPanelResizing(true); }}
            onPointerMove={event => { if (panelDrag.current) resizePanel(panelDrag.current.width + panelDrag.current.x - event.clientX); }}
            onPointerUp={event => { panelDrag.current = null; setPanelResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
            onLostPointerCapture={() => { panelDrag.current = null; setPanelResizing(false); }}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizePanel(panelWidth + (event.key === 'ArrowLeft' ? 40 : -40)); } }}
          />}
          <div className="file-panel-inner">
          <div className="panel-tabbar">
            <div className="panel-tabs" ref={panelTabsRef} role="tablist" aria-label="右侧面板标签">
              {panelTabs.map((tab) => <div
                key={tab.id}
                role="tab"
                tabIndex={activePanelTabId === tab.id ? 0 : -1}
                aria-selected={activePanelTabId === tab.id}
                className={`panel-tab ${activePanelTabId === tab.id ? 'is-active' : ''} ${tabDragRef.current === tab.id ? 'is-dragging' : ''} ${tabDropTarget === tab.id ? 'tab-drop-before' : ''}`}
                draggable
                onClick={() => activatePanelTab(tab)}
                onContextMenu={event => { event.preventDefault(); setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY }); }}
                onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setTabMenu({ id: tab.id, x: rect.left, y: rect.bottom }); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activatePanelTab(tab); } }}
                onDragStart={(event) => {
                  tabDragRef.current = tab.id;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.id);
                  makeDragPreview(event, tab.title, '标签');
                }}
                onDragOver={(event) => {
                  if (!tabDragRef.current || tabDragRef.current === tab.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setTabDropTarget(tab.id);
                }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setTabDropTarget(null); }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (tabDragRef.current) reorderPanelTabs(tabDragRef.current, tab.id);
                  tabDragRef.current = null;
                  setTabDropTarget(null);
                  dragPreviewRef.current?.remove();
                  dragPreviewRef.current = null;
                }}
                onDragEnd={() => { tabDragRef.current = null; setTabDropTarget(null); dragPreviewRef.current?.remove(); dragPreviewRef.current = null; }}
              >
                <span className={`panel-tab-icon is-${tab.kind}`}>{panelTabIcon(tab)}</span>
                <span className="panel-tab-label">{tab.title}</span>
                <button className="panel-tab-close" draggable={false} aria-label={`关闭 ${tab.title}`} onDragStart={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); closePanelTab(tab.id); }}><X /></button>
              </div>)}
              <button className="panel-tab-add" title="新标签页" aria-label="新标签页" onClick={openStartTab}><Plus /></button>
            </div>
            <div className="panel-tools">
              <button className={`icon-button ${panelSplit ? 'is-active' : ''}`} aria-label={panelSplit ? '退出分栏' : '分栏'} title={panelSplit ? '退出分栏' : '分栏'} onClick={() => setPanelSplit((value) => !value)}><Columns2 /></button>
              <button className="icon-button" aria-label={panelFullscreen ? '退出全屏' : '全屏'} title={panelFullscreen ? '退出全屏' : '应用内全屏'} onClick={() => setPanelFullscreen((value) => !value)}>{panelFullscreen ? <Minimize2 /> : <Maximize2 />}</button>
              <button className="icon-button" aria-label="收起右侧面板" title="收起右侧面板" onClick={closePanel}><PanelRight /></button>
            </div>
          </div>
          <div className={`panel-body ${panelSplit ? 'is-split' : ''}`}>
            {panelSplit ? <>
              <div className="panel-split-tree">{renderFileTree()}</div>
              <div className="panel-split-main">{activePanelTab?.kind === 'files' ? <div className="panel-empty"><FolderOpen /><strong>从左侧选择文件</strong><span>文件会在右侧以标签页打开。</span></div> : renderPanelContent()}</div>
            </> : renderPanelContent()}
          </div>
          </div>
        </aside>
        </>
      )}
    </div>
  );
}

