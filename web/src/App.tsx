import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Clock3, Command, Cpu, FileCode2, FileText, Folder, FolderOpen, Info, Sparkles,
  AppWindow, Columns2, Compass, Eye, Globe2, Keyboard, Layers3, LayoutGrid, LoaderCircle, Maximize2, MessageSquare, Minimize2, Monitor, Moon, MoreHorizontal, PanelLeft, PanelRight, Pencil, Plus, Plug, RotateCw, Search, Settings, SquarePen, Sun, Terminal, Trash2, X,
} from 'lucide-react';
import appIcon from '../../assets/icon.png';
import { Select } from './components/Select';
import type { ChatMessage, ComposerAttachment, ComposerCommand, ComposerCommandSource, ComposerFile } from './chat-types';
import { AttachmentIcon } from './components/AttachmentIcon';
import { AssistantTurnView, ChatMessageView } from './components/ChatMessage';
import { DetailDialog } from './components/DetailDialog';
import { ProviderIcon } from './components/ProviderIcon';
import { SettingsDialog } from './components/SettingsDialog';
import { ModelPicker } from './components/ModelPicker';
import type { ModelOption, ModelSelection, ThinkingLevel } from './model-types';
import { DEFAULT_PREFERENCES, loadPreferences, resolveTheme, savePreferences, setActivePreferences, type Preferences } from './preferences';

const settingsPages = [
  { id: 'general', label: '通用', icon: Settings, description: '外观、工作步骤、链接与输入行为。' },
  { id: 'models', label: '模型与账号', icon: Cpu, description: '连接模型来源，选择适合当前工作的模型。' },
  { id: 'mcp', label: 'MCP 服务器', icon: Plug, description: '连接外部工具，让 Pi 更好地理解你的工作环境。' },
  { id: 'skills', label: '技能', icon: FileCode2, description: '管理可复用的工作方法，为 Pi 扩展专业能力。' },
  { id: 'extensions', label: '扩展', icon: Layers3, description: '管理扩展包与本地扩展，自定义你的工作方式。' },
  { id: 'about', label: '关于', icon: Info, description: '一个专注、轻巧的 AI 开发工作台。' },
] as const;

const apiTypeOptions = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

function BrandMark({ className = '' }: { className?: string }) {
  return <img className={`brand-mark ${className}`} src={appIcon} alt="" draggable={false} />;
}

type PiSessionSummary = { id: string; cwd: string; title: string; updatedAt: number; messageCount: number };
type PiWorkspace = { cwd: string; name: string; sessions: PiSessionSummary[] };
type CustomModelConfig = { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean };
type SettingsEditor = { kind: 'provider' | 'model' | 'mcp' | 'package' | 'skill' | 'extension'; editId?: string };
type SettingsSnapshot = {
  customModels: CustomModelConfig[];
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; icon?: string; models: number }>;
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  extensions: Array<{ name: string; scope: string; path: string; kind: string; source?: string }>;
  packages: Array<{ source: string; name: string }>;
  extensionData: string[];
  enabledModels: string[];
  authPath: string;
  mcpPath: string;
  modelsPath: string;
  model: { modelRef: string; label: string };
};

type SkillInfo = SettingsSnapshot['skills'][number];
type McpInfo = SettingsSnapshot['mcp'][number];
type SkillDetailState = SkillInfo & { baseDir: string };

function filesize(size: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 1024) * 10) / 10} MB`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  return `${Math.floor(diff / 86_400_000)} 天`;
}

const LONG_MESSAGE_CHARS = 12_000;
const LONG_MESSAGE_BYTES = 24_000;
const LONG_MESSAGE_LINES = 240;

function isLongMessage(text: string): boolean {
  if (text.length > LONG_MESSAGE_CHARS) return true;
  if (text.split('\n').length > LONG_MESSAGE_LINES) return true;
  return new TextEncoder().encode(text).length > LONG_MESSAGE_BYTES;
}

const UI_KEYS = {
  expanded: 'pi-studio:expanded-workspaces',
  workspaceOrder: 'pi-studio:workspace-order',
  sessionOrder: 'pi-studio:session-order',
  activeSession: 'pi-studio:active-session',
} as const;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

type DragItem = { kind: 'workspace' | 'session'; cwd: string; sessionId?: string };
type PanelFile = { path: string; size: number; binary: boolean; text: string };
type PanelTab = { id: string; kind: 'start' | 'files' | 'file'; title: string; path?: string };
type ComposerMenuState = { kind: 'slash' | 'file'; query: string; start: number; end: number };

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function ComposerSourceIcon({ source }: { source: ComposerCommandSource }) {
  if (source === 'skill') return <Sparkles />;
  if (source === 'prompt') return <FileText />;
  if (source === 'extension') return <Plug />;
  return <Command />;
}

function contextTone(tokens?: number): string {
  if (!tokens) return 'is-small';
  if (tokens >= 1_000_000) return 'is-million';
  if (tokens >= 200_000) return 'is-large';
  if (tokens >= 100_000) return 'is-medium';
  return 'is-small';
}

export function App() {
  const [workspaces, setWorkspaces] = useState<PiWorkspace[]>([]);
  const [stateLoading, setStateLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({});
  const [extensionFooter, setExtensionFooter] = useState('');
  const [extensionToast, setExtensionToast] = useState<{ message: string; type: 'info' | 'warning' | 'error' } | null>(null);
  const [outlineActive, setOutlineActive] = useState(0);
  const [outlineHover, setOutlineHover] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelSelection>({ modelRef: '', label: '', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off', defaultThinkingLevel: 'off' });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readStored<string[]>(UI_KEYS.expanded, [])));
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => readStored<string[]>(UI_KEYS.workspaceOrder, []));
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => readStored<Record<string, string[]>>(UI_KEYS.sessionOrder, {}));
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [draggingItem, setDraggingItem] = useState<DragItem | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const [session, setSession] = useState<{ id: string; cwd: string; title: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelView, setModelView] = useState<'all' | 'provider'>('all');
  const [modelRef, setModelRef] = useState('');
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }>>>({});
  const [customModel, setCustomModel] = useState({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false });
  const [packageDraft, setPackageDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'models' | 'mcp' | 'skills' | 'extensions' | 'about'>('general');
  const [settingsData, setSettingsData] = useState<SettingsSnapshot | null>(null);
  const [editor, setEditor] = useState<SettingsEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [resourceScope, setResourceScope] = useState<'user' | 'project'>('user');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '', icon: '' });
  const [mcpDraft, setMcpDraft] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
  const [treePath, setTreePath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [file, setFile] = useState<PanelFile | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, PanelFile>>({});
  const [panelTabs, setPanelTabs] = useState<PanelTab[]>([{ id: 'start', kind: 'start', title: '开始' }]);
  const [activePanelTabId, setActivePanelTabId] = useState('start');
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);
  const panelTabsRef = useRef<HTMLDivElement>(null);
  const tabDragRef = useRef<string | null>(null);
  const [panelFullscreen, setPanelFullscreen] = useState(false);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsContentRef = useRef<HTMLElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<string | null>(null);
  const sessionLoadRef = useRef(0);
  const prefetchedSessionsRef = useRef<Set<string>>(new Set());
  const editorRequestRef = useRef(0);
  const originalMcpArgsRef = useRef<string[] | null>(null);
  const workspaceOrderRef = useRef(workspaceOrder);
  const sessionOrderRef = useRef(sessionOrder);
  const dragRef = useRef<DragItem | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    savePreferences(preferences);
    setActivePreferences(preferences);
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(preferences.theme);
    root.style.setProperty('--chat-font-size', `${preferences.fontSize}px`);
    if (preferences.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { root.dataset.theme = media.matches ? 'dark' : 'light'; };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  const loadState = useCallback(async () => {
    setStateLoading(true);
    try {
      const next = await window.piApi.state(workspace);
      const savedWorkspaceOrder = workspaceOrderRef.current;
      const savedSessionOrder = sessionOrderRef.current;
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
        ];
        nextSessionOrder[item.cwd] = sessions.map((entry) => entry.id);
        return { ...item, sessions };
      });
      workspaceOrderRef.current = ordered.map((item) => item.cwd);
      sessionOrderRef.current = nextSessionOrder;
      setWorkspaceOrder(ordered.map((item) => item.cwd));
      setSessionOrder(nextSessionOrder);
      setWorkspaces(orderedSessions);
      setModelRef(next.model.modelRef);
      setModelSelection(next.model);
      setWorkspace((current) => current || orderedSessions[0]?.cwd || next.cwd);
    } finally {
      setStateLoading(false);
    }
  }, [workspace]);

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
      setModelRef(modelResult.current);
      setModelSelection(modelResult.selection);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  function closeEditor() {
    if (settingsBusy) return;
    editorRequestRef.current += 1;
    setEditor(null);
    setEditorError(null);
  }

  async function openEditor(kind: SettingsEditor['kind'], editId?: string) {
    const request = ++editorRequestRef.current;
    setEditor({ kind, editId });
    setEditorError(null);
    setEditorLoading(Boolean(editId && (kind === 'provider' || kind === 'mcp')));
    setResourceScope('user');
    setPackageDraft('');
    originalMcpArgsRef.current = null;
    setProviderDraft({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '', icon: '' });
    setMcpDraft({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
    setCustomModel({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false });
    try {
      if (kind === 'provider' && editId) {
        const config = await window.piApi.providerConfig(editId);
        if (request === editorRequestRef.current) setProviderDraft({ ...config, modelId: '', modelName: '', apiKey: '' });
      }
      if (kind === 'mcp' && editId) {
        const config = await window.piApi.mcpConfig(editId);
        if (request === editorRequestRef.current) {
          originalMcpArgsRef.current = config.args;
          setMcpDraft({ ...config, args: config.args.join('\n') });
        }
      }
      if (kind === 'model' && editId) {
        const config = settingsData?.customModels?.find((item) => `${item.providerId}/${item.modelId}` === editId);
        if (config) setCustomModel({ ...config, contextWindow: config.contextWindow?.toString() || '', maxTokens: config.maxTokens?.toString() || '' });
      }
    } catch (error) {
      if (request === editorRequestRef.current) setEditorError(error instanceof Error ? error.message : String(error));
    } finally { if (request === editorRequestRef.current) setEditorLoading(false); }
  }

  async function loadProviderModels(providerId: string) {
    if (expandedProvider === providerId) { setExpandedProvider(null); return; }
    setExpandedProvider(providerId);
    setModelQuery('');
    if (!providerModels[providerId]) {
      try {
        const result = await window.piApi.providerModels(providerId);
        setProviderModels((current) => ({ ...current, [providerId]: result.models }));
      } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    }
  }

  async function setEnabled(next: string[]) {
    setSettingsBusy(true); setSettingsError(null);
    try {
      const snapshot = await window.piApi.setEnabledModels(next);
      setSettingsData(snapshot);
      setEnabledModels(snapshot.enabledModels);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally { setSettingsBusy(false); }
  }

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
      });
      setSettingsData(snapshot);
      setCustomModel({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false });
      setProviderModels({});
      const catalog = await window.piApi.models(workspace);
      setModels(catalog.models);
      setEditor(null);
      await loadState();
    } catch (error) { setEditorError(error instanceof Error ? error.message : String(error)); }
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
    } catch (error) { setEditorError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function removePackage(source: string) {
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removePackage(source)); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteMcp(name: string) {
    if (!window.confirm(`删除 MCP 服务器「${name}」？`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removeMcp(name)); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteSkill(skillPath: string, name: string) {
    if (!window.confirm(`删除技能「${name}」？这会删除技能目录。`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removeSkill(skillPath)); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteExtension(extensionPath: string, name: string) {
    if (!window.confirm(`删除扩展「${name}」？`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.removeExtension(extensionPath)); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function deleteCustomModel(providerId: string, modelId: string, name: string) {
    if (!window.confirm(`删除自定义模型「${name}」？`)) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      setSettingsData(await window.piApi.removeCustomModel({ providerId, modelId }));
      setProviderModels({});
      setModels((await window.piApi.models(workspace)).models);
    } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function saveProvider() {
    setSettingsBusy(true);
    setEditorError(null);
    try {
      const result = await window.piApi.addProvider({ ...providerDraft, editing: Boolean(editor?.editId) });
      setSettingsData(result.settings);
      setModels(result.models.models);
      setModelRef(result.models.current);
      setProviderDraft({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '', icon: '' });
      setProviderModels({});
      setEditor(null);
      await loadState();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsBusy(false);
    }
  }

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
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function importResource(kind: 'skill' | 'extension', scope: 'user' | 'project') {
    setSettingsBusy(true);
    setEditorError(null);
    try {
      const next = kind === 'skill'
        ? await window.piApi.addSkill({ scope, cwd: workspace })
        : await window.piApi.addExtension({ scope, cwd: workspace });
      if (next) { setSettingsData(next); setEditor(null); }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleMcp(name: string, enabled: boolean) {
    setSettingsBusy(true); setSettingsError(null);
    try { setSettingsData(await window.piApi.setMcpEnabled({ name, enabled })); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function loadModelCatalog() {
    const result = await window.piApi.models(workspace);
    setModels(result.models);
    setEnabledModels(result.enabled ?? []);
    setModelRef(result.current);
    setModelSelection(result.selection);
    return result;
  }

  async function selectModel(next: string) {
    const result = await window.piApi.setModel(next, workspace);
    setModelRef(next);
    setModelSelection(result);
  }

  async function selectThinking(level: ThinkingLevel) {
    const result = await window.piApi.setThinkingLevel({ modelRef: modelSelection.modelRef, level, cwd: workspace });
    setModelSelection(result);
  }

  useEffect(() => { void loadState().catch((error) => setError(error instanceof Error ? error.message : String(error))); }, [loadState]);

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
    const summary = workspaces.flatMap((item) => item.sessions).find((item) => item.id === saved.id);
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

  useEffect(() => window.piApi.onOpenSettings(() => { void openSettings(); }), [workspace]);

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

  useEffect(() => {
    setExtensionStatuses({});
    setExtensionFooter('');
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id) return;
    let cancelled = false;
    void window.piApi.extensionState(session.id).then((state) => {
      if (cancelled) return;
      setExtensionStatuses(Object.fromEntries(state.statuses));
      setExtensionFooter(state.footer);
    }).catch(() => { /* no extension state yet */ });
    return () => { cancelled = true; };
  }, [session?.id]);

  useEffect(() => {
    const offStatus = window.piApi.onExtensionStatus((event) => {
      if (!session?.id || event.sessionId !== session.id) return;
      setExtensionStatuses((current) => {
        const next = { ...current };
        if (!event.text) delete next[event.key]; else next[event.key] = event.text;
        return next;
      });
    });
    const offFooter = window.piApi.onExtensionFooter((event) => {
      if (!session?.id || event.sessionId !== session.id) return;
      setExtensionFooter(event.text);
    });
    const offNotify = window.piApi.onExtensionNotify((event) => {
      if (!session?.id || event.sessionId !== session.id) return;
      setExtensionToast({ message: event.message, type: event.type });
    });
    return () => { offStatus(); offFooter(); offNotify(); };
  }, [session?.id]);

  useEffect(() => {
    if (!extensionToast) return;
    const timer = window.setTimeout(() => setExtensionToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [extensionToast]);

  useEffect(() => window.piApi.onPrompt((event) => {
    if (event.requestId !== requestRef.current) return;
    if (event.message && (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end')) {
      const incoming = event.message;
      if (incoming.role === 'user') return;
      setMessages((current) => {
        const copy = [...current];
        if (incoming.role === 'assistant' && event.type === 'message_start') {
          for (let index = 0; index < copy.length; index += 1) if (copy[index].streaming) copy[index] = { ...copy[index], streaming: false };
        }
        const streaming = incoming.role === 'assistant' && event.type !== 'message_end';
        const next = { ...incoming, ...(streaming ? { streaming: true } : { streaming: false }) };
        let index = copy.findIndex((message) => message.role === incoming.role && message.timestamp === incoming.timestamp);
        if (index < 0 && incoming.role === 'assistant' && event.type !== 'message_start') {
          index = copy.findIndex((message) => message.role === 'assistant' && message.streaming);
        }
        if (index >= 0) copy[index] = next;
        else copy.push(next);
        return copy;
      });
    }
    if (event.type === 'retry-start') {
      setRetryInfo({ attempt: event.attempt ?? 1, maxAttempts: event.maxAttempts ?? 1, errorMessage: event.errorMessage });
    }
    if (event.type === 'retry-end' && event.success) setRetryInfo(null);
    if (event.type === 'done') {
      setRetryInfo(null);
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
      setError(null);
      void loadState();
    }
    if (event.type === 'error') {
      setRetryInfo(null);
      setError(event.error || '执行失败，请重试');
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
    }
  }), [loadState]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

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

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.cwd === workspace),
    [workspaces, workspace],
  );
  const visibleWorkspaces = workspaces.filter((item) => `${item.name} ${item.cwd} ${item.sessions.map((s) => s.title).join(' ')}`.toLowerCase().includes(workspaceQuery.toLowerCase()));
  const isNewConversation = messages.length === 0 && !busy;
  const allExpanded = workspaces.length > 0 && workspaces.every((item) => expanded.has(item.cwd));

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


  async function startSession(cwd = workspace) {
    if (!cwd) return;
    const created = await window.piApi.createSession(cwd);
    setSession({ id: created.id, cwd: created.cwd, title: created.title });
    setMessages([]);
    setError(null);
    setPrompt('');
    setWorkspace(cwd);
    expandWorkspace(cwd);
    setBusy(false);
    setRetryInfo(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function prefetchSession(id: string) {
    if (prefetchedSessionsRef.current.has(id)) return;
    prefetchedSessionsRef.current.add(id);
    void window.piApi.session(id).catch(() => { /* prefetch is best effort */ });
  }

  async function openSession(item: PiSessionSummary) {
    const load = ++sessionLoadRef.current;
    setSessionLoading(true);
    try {
      const detail = await window.piApi.session(item.id);
      if (!detail || load !== sessionLoadRef.current) return;
      setSession({ id: detail.id, cwd: detail.cwd, title: detail.title });
      setMessages(detail.messages.map((message) => ({ ...message })));
      setWorkspace(detail.cwd);
      expandWorkspace(detail.cwd);
      setError(null);
      setBusy(false);
      setRetryInfo(null);
    } catch (error) {
      if (load === sessionLoadRef.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (load === sessionLoadRef.current) setSessionLoading(false);
    }
  }

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
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
  }

  async function pickComposerAttachments() {
    try {
      const result = await window.piApi.pickAttachments({ sessionId: session?.id });
      setComposerAttachments((current) => [...current, ...result.attachments]);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function updateComposerMenu(value: string, caret: number) {
    const before = value.slice(0, caret);
    const slash = before.match(/^\/([^\s]*)$/);
    if (slash) {
      const next = { kind: 'slash' as const, query: slash[1], start: 0, end: caret };
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

  async function executeBuiltinCommand(name: string): Promise<boolean> {
    if (name === 'new') {
      if (!workspace) return false;
      await startSession(workspace);
      return true;
    }
    if (name === 'settings') { await openSettings(); return true; }
    if (name === 'mcp') { await openSettings('mcp'); return true; }
    if (name === 'model' || name === 'thinking') { await openSettings('models'); return true; }
    if (name === 'copy') {
      const last = [...messages].reverse().find((message) => message.role === 'assistant');
      const text = last?.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n') ?? '';
      if (text) await navigator.clipboard.writeText(text);
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
      void executeBuiltinCommand(command.name);
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
    let next = 0;
    for (let index = 0; index < outlineItems.length; index += 1) {
      const node = document.getElementById(outlineItems[index].id);
      if (node && node.getBoundingClientRect().top <= top) next = index;
    }
    setOutlineActive((current) => current === next ? current : next);
  }

  function jumpToOutline(index: number) {
    const item = outlineItems[index];
    const container = scrollRef.current;
    const node = item ? document.getElementById(item.id) : null;
    if (!item || !container || !node) return;
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + delta - 12, behavior: 'smooth' });
    setOutlineActive(index);
  }

  async function prepareSubmission(text: string, attachments: ComposerAttachment[], sessionId: string) {
    const files = attachments.filter((attachment) => attachment.kind === 'file');
    const images = attachments.filter((attachment) => attachment.kind === 'image');
    let displayText = text;
    let outgoingText = text;
    let longAttachments: ChatMessage['attachments'] = [];
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
    return { displayText, outgoingText, content, persistentAttachments, imagePayload, mentions, attachmentPaths: persistentAttachments.map((attachment) => attachment.path) };
  }

  async function send() {
    const text = prompt.trim();
    if ((!text && composerAttachments.length === 0)) return;
    if (!busy && composerAttachments.length === 0 && text.startsWith('/')) {
      const builtin = text.match(/^\/(new|settings|model|thinking|copy|mcp)(?:\s|$)/);
      if (builtin && await executeBuiltinCommand(builtin[1])) {
        setPrompt('');
        setComposerMenu(null);
        return;
      }
    }
    setComposerMenu(null);
    let current = session;
    if (!current) {
      if (!workspace) await loadState();
      const created = await window.piApi.createSession(workspace);
      current = { id: created.id, cwd: created.cwd, title: created.title };
      setSession(current);
      setMessages([]);
    }
    const prepared = await prepareSubmission(text, composerAttachments, current.id);
    setPrompt('');
    setComposerAttachments([]);
    setMessages((existing) => [...existing, {
      role: 'user',
      content: prepared.content,
      timestamp: Date.now(),
      ...(prepared.persistentAttachments.length > 0 ? { attachments: prepared.persistentAttachments } : {}),
    }]);
    if (busy) {
      try {
        await window.piApi.queuePrompt({
          sessionId: current.id,
          text: prepared.outgoingText,
          behavior: preferences.busySend,
          mentions: prepared.mentions,
          attachments: prepared.attachmentPaths,
          images: prepared.imagePayload,
        });
        setExtensionToast({ message: preferences.busySend === 'queue' ? '已加入发送队列，本轮结束后处理。' : '已作为引导发送给当前任务。', type: 'info' });
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    setBusy(true);
    setError(null);
    setRetryInfo(null);
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    try {
      await window.piApi.prompt({
        sessionId: current.id,
        text: prepared.outgoingText,
        requestId,
        mentions: prepared.mentions,
        attachments: prepared.attachmentPaths,
        images: prepared.imagePayload,
      });
      const saved = await window.piApi.session(current.id);
      if (saved) {
        setSession({ id: saved.id, cwd: saved.cwd, title: saved.title });
        setMessages(saved.messages.map((message) => ({ ...message })));
      }
      setBusy(false);
      await loadState();
    } catch (error) {
      setRetryInfo(null);
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function loadTree(nextPath: string) {
    if (!workspace) return;
    setFileBusy(true);
    try {
      const result = await window.piApi.files(workspace, nextPath);
      setTreePath(result.path);
      setEntries(result.entries);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setFileBusy(false); }
  }

  function openPanel() {
    if (panelCloseTimerRef.current !== null) {
      window.clearTimeout(panelCloseTimerRef.current);
      panelCloseTimerRef.current = null;
    }
    if (panelTabs.length === 0) {
      setPanelTabs([{ id: 'start', kind: 'start', title: '开始' }]);
      setActivePanelTabId('start');
    }
    setPanelEntered(false);
    setFilesOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setPanelEntered(true)));
  }

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

  function openFilesTab() {
    if (!panelTabs.some((tab) => tab.kind === 'files')) {
      setPanelTabs((current) => [...current, { id: 'files', kind: 'files', title: '文件' }]);
    }
    setActivePanelTabId('files');
    setFile(null);
  }

  async function loadFileToTab(target: string) {
    if (!workspace) return;
    setFileBusy(true);
    try {
      const content = await window.piApi.file(workspace, target);
      setOpenFiles((current) => ({ ...current, [target]: content }));
      setFile(content);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setFileBusy(false); }
  }

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

  async function openFile(target: string) {
    const id = `file:${target}`;
    const title = target.split('/').pop() || target;
    setPanelTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'file', title, path: target }]);
    setActivePanelTabId(id);
    const cached = openFiles[target];
    if (cached) setFile(cached);
    else await loadFileToTab(target);
  }

  function closePanelTab(id: string) {
    const index = panelTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = panelTabs.filter((tab) => tab.id !== id);
    setPanelTabs(next);
    if (next.length === 0) { closePanel(); return; }
    if (activePanelTabId === id) {
      const target = next[Math.min(index, next.length - 1)];
      activatePanelTab(target);
    }
  }

  function chooseFile() {
    void window.piApi.chooseWorkspace().then((selected) => {
      if (selected) {
        setWorkspace(selected);
        setSession(null);
        setMessages([]);
        void loadState();
      }
    });
  }

  function submitEditor() {
    if (!editor) return;
    if (editor.kind === 'provider') void saveProvider();
    else if (editor.kind === 'model') void saveCustomModel();
    else if (editor.kind === 'mcp') void saveMcp();
    else if (editor.kind === 'package') void addPackage();
    else void importResource(editor.kind, resourceScope);
  }

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

  const toolResultMap = new Map(messages.filter((message) => message.role === 'toolResult' && message.toolCallId).map((message) => [message.toolCallId as string, message]));
  const transcriptTurns: Array<{ kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] }> = [];
  for (const message of messages) {
    if (message.role === 'toolResult') continue;
    if (message.role === 'user') { transcriptTurns.push({ kind: 'user', message }); continue; }
    const last = transcriptTurns[transcriptTurns.length - 1];
    if (last?.kind === 'assistant') last.messages.push(message);
    else transcriptTurns.push({ kind: 'assistant', messages: [message] });
  }
  const lastAssistantTurnIndex = transcriptTurns.reduce((last, turn, index) => turn.kind === 'assistant' ? index : last, -1);
  const outlineItems = transcriptTurns.flatMap((turn, index) => {
    if (turn.kind !== 'user') return [];
    const text = turn.message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    return [{ id: `chat-turn-${index}`, text, timestamp: turn.message.timestamp }];
  });
  const composerCommandOptions = composerMenu?.kind === 'slash'
    ? composerCommands.filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(composerMenu.query.toLowerCase()))
    : [];
  const composerFileOptions = composerMenu?.kind === 'file' ? composerFiles : [];
  const composerOptionsCount = composerMenu?.kind === 'slash' ? composerCommandOptions.length : composerFileOptions.length;
  const globalSkillGroups = [
    { key: 'agents', label: '~/.agents/skills', items: (settingsData?.skills ?? []).filter((skill) => !skill.path.includes('/.pi/agent/skills/')) },
    { key: 'pi', label: '~/.pi/agent/skills', items: (settingsData?.skills ?? []).filter((skill) => skill.path.includes('/.pi/agent/skills/')) },
  ];
  const activePanelTab = panelTabs.find((tab) => tab.id === activePanelTabId) ?? panelTabs[0];

  function panelTabIcon(tab: PanelTab) {
    if (tab.kind === 'start') return <Compass />;
    if (tab.kind === 'files') return <Folder />;
    return <FileText />;
  }

  async function loadSkillTree(baseDir: string, nextPath: string) {
    setSkillBusy(true);
    setSkillDetailError(null);
    try {
      const result = await window.piApi.files(baseDir, nextPath);
      setSkillTreePath(result.path);
      setSkillEntries(result.entries);
    } catch (error) { setSkillDetailError(error instanceof Error ? error.message : String(error)); }
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
    catch (error) { setSkillDetailError(error instanceof Error ? error.message : String(error)); }
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
    } catch (error) { setSkillDetailError(error instanceof Error ? error.message : String(error)); }
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
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }

  async function openFileWith(appPath?: string) {
    if (!file || !workspace) return;
    setFileMenuOpen(false);
    try { await window.piApi.openWith({ cwd: workspace, path: file.path, appPath }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }

  async function revealCurrentFile() {
    if (!file || !workspace) return;
    setFileMenuOpen(false);
    try { await window.piApi.revealFile({ cwd: workspace, path: file.path }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
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
    if (!file) return <div className="panel-empty"><FileText /><strong>选择一个文件</strong><span>从左侧文件树打开文件，会在这里以标签页显示。</span></div>;
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
      {file.binary ? <div className="file-empty"><FileText /><strong>暂不支持预览此文件</strong><span>可以在其他应用中查看二进制文件。</span></div> : <pre className="file-code"><code>{file.text.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><span>{line || ' '}</span></span>)}</code></pre>}
      {fileBusy && <div className="file-loading" role="status"><LoaderCircle className="spin" />正在读取文件…</div>}
    </div>;
  }

  function renderPanelStart() {
    return <div className="panel-start">
      <div className="panel-start-tools">
        <button className="panel-tool" onClick={openFilesTab}><span className="panel-tool-icon is-folder"><Folder /></span><span><strong>工作区文件</strong><small>浏览当前工作区里的文件</small></span><ChevronDown className="panel-tool-arrow" /></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><Terminal /></span><span><strong>新建终端</strong><small>即将推出</small></span></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><Globe2 /></span><span><strong>浏览器</strong><small>即将推出</small></span></button>
        <button className="panel-tool" disabled><span className="panel-tool-icon"><LayoutGrid /></span><span><strong>更多工具</strong><small>即将推出</small></span></button>
      </div>
    </div>;
  }

  function renderPanelContent() {
    if (!activePanelTab) return null;
    if (activePanelTab.kind === 'start') return renderPanelStart();
    if (activePanelTab.kind === 'files') return renderFileTree();
    return renderFilePreview();
  }

  return (
    <div className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${filesOpen && panelFullscreen ? 'is-panel-fullscreen' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <button className="icon-button sidebar-top-toggle" aria-label="收起侧边栏" title="收起侧边栏" onClick={() => setSidebarCollapsed(true)}><PanelLeft /></button>
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Pi Studio</span>
        </div>
        <button className="new-chat" title="新会话" onClick={() => void startSession()}><SquarePen /><span>新会话</span></button>
        <nav className="nav">
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
                    setWorkspace(item.cwd);
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(item.cwd)) next.delete(item.cwd); else next.add(item.cwd);
                      return next;
                    });
                  }}
                >
                  {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <span>{item.name}</span>
                  <ChevronDown size={13} className={isOpen ? 'chevron open' : 'chevron'} />
                </button>
                {isOpen && (
                  <div className="sessions">
                    {item.sessions.map((sessionItem) => (
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
                        <span className="session-time">{relativeTime(sessionItem.updatedAt)}</span>
                      </button>
                    ))}
                    {item.sessions.length === 0 && <button className="session-row empty" onClick={() => void startSession(item.cwd)}>新会话</button>}
                  </div>
                )}
              </div>
            );
          })}
          {!stateLoading && visibleWorkspaces.length === 0 && <div className="sidebar-empty"><FolderOpen /><span>{workspaceQuery ? '没有匹配的工作区或会话' : '打开一个文件夹，开始工作'}</span>{!workspaceQuery && <button className="settings-outline" onClick={chooseFile}>打开工作区</button>}</div>}
        </div>
        <div className="sidebar-bottom">
          <button className="bottom-row" title="设置" onClick={() => void openSettings()}><Settings /><span>设置</span><span className="status"><i />本地运行</span></button>
        </div>
      </aside>

      <main className={`main ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
        <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
        <header className="chat-header">
          {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={() => setSidebarCollapsed(false)}><PanelLeft /></button>}
          {!isNewConversation && <div className="chat-heading">
            <h1>{session?.title || 'Pi Studio'}</h1>
            <div className="chat-meta"><span className={`state-dot ${busy ? 'is-busy' : ''}`} />{busy ? '正在处理' : '准备就绪'}{activeWorkspace && <><span>·</span><span className="workspace-name">{activeWorkspace.name}</span></>}</div>
          </div>}
          <div className="chat-actions">
            {!filesOpen && <button className="icon-button" onClick={openPanel} aria-label="打开右侧面板" title="打开右侧面板"><PanelRight size={16} /></button>}
          </div>
        </header>
        {!isNewConversation && <div className="chat-tabs">
          <button className="tab is-active">对话</button>
          <button className="tab" disabled title="执行轨迹即将推出">轨迹</button>
          <span className="chat-tabs-note">{messages.filter((message) => message.role !== 'toolResult').length > 0 ? `${messages.filter((message) => message.role !== 'toolResult').length} 条消息` : '从一个想法开始'}</span>
        </div>}

        {!isNewConversation && <div className="chat-scroll" ref={scrollRef} onScroll={syncOutlineActive}>
          <div className="chat-column">
            {messages.length > 0 && (
              <div className="messages">
                {transcriptTurns.map((turn, index) => turn.kind === 'user'
                  ? <ChatMessageView key={turn.message.timestamp ?? `user-${index}`} id={`chat-turn-${index}`} message={turn.message} />
                  : <AssistantTurnView key={turn.messages[0]?.timestamp ?? `assistant-${index}`} id={`chat-turn-${index}`} messages={turn.messages} toolResults={toolResultMap} busy={busy} retry={index === lastAssistantTurnIndex && retryInfo ? retryInfo : undefined} stepDisplay={preferences.stepDisplay} stepCollapse={preferences.stepCollapse} showCodeView={preferences.showCodeView} />)}
                {busy && !retryInfo && !messages.some((message) => message.role === 'assistant' && message.streaming) && (
                  <div className="thinking"><span /><span /><span />正在思考</div>
                )}
              </div>
            )}
            {error && !messages.some((message) => message.role === 'assistant' && message.errorMessage) && <div className="error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
          </div>
        </div>}

        {!settingsOpen && !filesOpen && !isNewConversation && outlineItems.length > 1 && (
          <nav className="conversation-outline" aria-label="对话大纲" onMouseLeave={() => setOutlineHover(null)}>
            <div className="outline-track">
              {outlineItems.map((item, index) => <div className={`outline-item ${outlineHover === index ? 'is-hovered' : ''}`} key={item.id} onMouseEnter={() => setOutlineHover(index)}>
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
              </div>)}
            </div>
          </nav>
        )}
        <div className="composer-dock">
          {isNewConversation && <div className="new-conversation-intro">
            <span className="new-conversation-context" title={workspace}>{activeWorkspace?.name || (workspace ? workspace.split('/').pop() : 'Pi Studio')}</span>
            <h2>今天，<em>想做点什么？</em></h2>
            <p>从一个念头开始。</p>
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
                : <div className="composer-attachment is-file" key={attachment.id} title={attachment.path}>
                  <AttachmentIcon name={attachment.name} mime={attachment.mime} />
                  <span><strong>{attachment.name}</strong><small>{filesize(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</small></span>
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => removeComposerAttachment(attachment.id)}><X /></button>
                </div>)}
            </div>}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => { const value = event.target.value; setPrompt(value); updateComposerMenu(value, event.target.selectionStart ?? value.length); }}
              onClick={(event) => updateComposerMenu(prompt, event.currentTarget.selectionStart ?? prompt.length)}
              onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length > 0) { event.preventDefault(); void addComposerFiles(files); } }}
              onKeyDown={(event) => {
                if (composerMenu && composerOptionsCount > 0) {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setComposerMenuIndex((index) => (index + 1) % composerOptionsCount); return; }
                  if (event.key === 'ArrowUp') { event.preventDefault(); setComposerMenuIndex((index) => (index - 1 + composerOptionsCount) % composerOptionsCount); return; }
                  if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) { event.preventDefault(); selectComposerOption(composerMenuIndex); return; }
                  if (event.key === 'Escape') { event.preventDefault(); setComposerMenu(null); return; }
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
              }}
              aria-label="发送给 Pi 的消息"
              aria-expanded={Boolean(composerMenu)}
              placeholder="描述你的想法，或输入 / 命令、@ 文件…"
              rows={2}
            />
            <div className="composer-bar">
              <div className="composer-left">
                <button type="button" className="composer-attach-button" disabled={busy} onClick={() => void pickComposerAttachments()} aria-label="添加图片或文件" title="添加图片或文件"><Plus /></button>
              </div>
              <div className="composer-right">
                <ModelPicker selection={modelSelection} disabled={busy || stateLoading} hidden={settingsOpen} loadCatalog={loadModelCatalog} onSelectModel={selectModel} onSelectThinking={selectThinking} onManage={() => void openSettings('models')} />
                <button className="send-button" disabled={!prompt.trim() && composerAttachments.length === 0} onClick={() => void send()} aria-label={busy ? (preferences.busySend === 'queue' ? '排队发送' : '引导当前任务') : '发送消息'} title={busy ? (preferences.busySend === 'queue' ? '排队发送' : '引导当前任务') : '发送消息'}><ArrowUp /></button>
              </div>
            </div>
            </div>
          </div>
          {(extensionFooter || Object.keys(extensionStatuses).length > 0) && <div className="extension-status-bar" aria-label="扩展状态">
            {extensionFooter && <div className="extension-footer-line" title={extensionFooter}>{extensionFooter}</div>}
            {preferences.performance === 'detailed' && Object.entries(extensionStatuses).slice(0, 8).map(([key, text]) => <span className="extension-status-chip" key={key} title={key}>{text}</span>)}
          </div>}
          {extensionToast && <div className={`extension-toast is-${extensionToast.type}`} role="status">{extensionToast.message}</div>}
          {isNewConversation && error && <div className="new-conversation-error error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
        </div>
      </main>

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
                  <div className="settings-card-head"><div><h2>外观</h2><p>选择 Pi Studio 的界面明暗；跟随系统会随 macOS 自动切换。</p></div></div>
                  <div className="theme-choice-row">
                    {([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map((item) => <button key={item.value} className={`theme-choice ${preferences.theme === item.value ? 'is-active' : ''}`} onClick={() => updatePreference('theme', item.value)}><item.icon /><span>{item.label}</span></button>)}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-profile-list">
                    <div className="settings-profile-row"><div><strong>字号大小</strong><p>仅影响对话内容的字号。</p></div><div className="settings-inline-control"><Select label="字号大小" value={String(preferences.fontSize)} onChange={(value) => updatePreference('fontSize', Number(value))} options={[12, 13, 14, 15, 16, 17].map((size) => ({ value: String(size), label: String(size) }))} /><span className="settings-unit">px</span></div></div>
                    <div className="settings-profile-row"><div><strong>工作步骤展示</strong><p>选择希望看到多少工具调用细节。</p></div><Select label="工作步骤展示" value={preferences.stepDisplay} onChange={(value) => updatePreference('stepDisplay', value as Preferences['stepDisplay'])} options={[{ value: 'compact', label: '精简' }, { value: 'standard', label: '标准' }, { value: 'detailed', label: '详细' }]} /></div>
                    <div className="settings-profile-row"><div><strong>工作步骤收起时机</strong><p>选择何时自动收起工作步骤。</p></div><Select label="工作步骤收起时机" value={preferences.stepCollapse} onChange={(value) => updatePreference('stepCollapse', value as Preferences['stepCollapse'])} options={[{ value: 'after-answer', label: '回答结束后' }, { value: 'keep-open', label: '保持展开' }, { value: 'manual', label: '手动控制' }]} /></div>
                    <div className="settings-profile-row"><div><strong>显示代码工作视图</strong><p>开启后，在回复前显示本轮访问和修改的文件摘要。</p></div><button className={`switch ${preferences.showCodeView ? 'is-on' : ''}`} role="switch" aria-checked={preferences.showCodeView} onClick={() => updatePreference('showCodeView', !preferences.showCodeView)}><span /></button></div>
                    <div className="settings-profile-row"><div><strong>快捷键</strong><p>查看当前可用的键盘操作。</p></div><button className="settings-outline" onClick={() => setShortcutsOpen(true)}><Keyboard />编辑快捷键</button></div>
                    <div className="settings-profile-row"><div><strong>网页链接默认打开方式</strong><p>对话中网页链接的打开位置。</p></div><Select label="网页链接默认打开方式" value={preferences.linkOpen} onChange={(value) => updatePreference('linkOpen', value as Preferences['linkOpen'])} options={[{ value: 'external', label: '系统浏览器' }, { value: 'window', label: '应用内窗口' }]} /></div>
                    <div className="settings-profile-row"><div><strong>繁忙时的发送行为</strong><p>智能体运行时 Enter 键和发送按钮的行为。</p></div><Select label="繁忙时的发送行为" value={preferences.busySend} onChange={(value) => updatePreference('busySend', value as Preferences['busySend'])} options={[{ value: 'queue', label: '排队发送' }, { value: 'steer', label: '引导当前任务' }]} /></div>
                    <div className="settings-profile-row"><div><strong>性能与用量</strong><p>选择状态栏信息的展示详细程度。</p></div><Select label="性能与用量" value={preferences.performance} onChange={(value) => updatePreference('performance', value as Preferences['performance'])} options={[{ value: 'simple', label: '简洁' }, { value: 'detailed', label: '详细' }]} /></div>
                  </div>
                </section>
              </div>
            )}
            {settingsData && settingsTab === 'models' && (
              <div className="settings-sections">
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>已启用模型 <span className="count-badge">{enabledModels.length}</span></h2><p>这里管理所有会话可用的模型；具体使用哪个模型，在对话输入框中选择。</p></div></div>
                  {enabledModels.length > 0 ? <>
                    <div className="model-view-bar"><span>查看方式</span><div className="model-view-toggle" role="group" aria-label="模型查看方式"><button className={modelView === 'all' ? 'is-active' : ''} onClick={() => setModelView('all')}>全部</button><button className={modelView === 'provider' ? 'is-active' : ''} onClick={() => setModelView('provider')}>按来源</button></div></div>
                    {modelView === 'all' ? <div className="model-card-grid">{enabledModels.map(renderModelCard)}</div> : <div className="model-groups">{enabledModelGroups.map((group) => <section className="model-group" key={group.name}><div className="model-group-head"><ProviderIcon className="model-card-avatar" provider={group.provider} name={group.name} icon={settingsData?.providers.find((entry) => entry.id === group.provider)?.icon} size={22} /><strong>{group.name}</strong><span>{group.ids.length}</span></div><div className="model-card-grid">{group.ids.map(renderModelCard)}</div></section>)}</div>}
                  </> : <div className="settings-empty">在下方添加来源，再选择要启用的模型。</div>}
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>模型来源 <span className="count-badge">{settingsData.providers.length}</span></h2><p>管理服务地址、认证信息和可用模型。</p></div><button className="settings-add-button" aria-label="添加模型来源" onClick={() => void openEditor('provider')}>添加</button></div>
                  <div className="provider-cards">
                    {settingsData.providers.map((provider) => {
                      const list = providerModels[provider.id] ?? [];
                      const filtered = list.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
                      return <div className="provider-card" key={provider.id}>
                        <div className="provider-card-head">
                          <ProviderIcon className="provider-avatar" provider={provider.id} name={provider.name} icon={provider.icon} size={36} />
                          <div className="provider-main"><strong>{provider.name}</strong><span>{provider.id} · {provider.models} 个模型</span></div>
                          <span className={`provider-mode ${provider.authConfigured === false ? 'is-missing' : ''}`}>{provider.authConfigured === false ? '未配置凭据' : provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key'}</span>
                          <div className="row-actions"><button className="icon-button row-edit" aria-label={`编辑 ${provider.name}`} title="编辑" onClick={() => void openEditor('provider', provider.id)}><Pencil /></button><button className="settings-outline row-action" onClick={() => void loadProviderModels(provider.id)} aria-expanded={expandedProvider === provider.id}>{expandedProvider === provider.id ? '收起模型' : '管理模型'}</button></div>
                        </div>
                        {provider.authConfigured === false && <p className="provider-auth-hint">已启用此来源的模型，但尚未配置凭据。点击“编辑”完成连接。</p>}
                        {provider.mode === 'env' && <div className={`provider-env-hint ${provider.envAvailable ? 'is-set' : ''}`}>{provider.envAvailable ? '环境变量已设置' : '环境变量未设置'} · <code>{provider.envName}</code></div>}
                        {expandedProvider === provider.id && <div className="provider-model-panel">
                          <div className="provider-model-tools"><input className="model-search" aria-label={`搜索 ${provider.name} 的模型`} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索名称或模型 ID…" /><span>{list.filter((item) => enabledModels.includes(item.id)).length}/{list.length} 已启用</span></div>
                          <div className="provider-model-list">
                            {filtered.slice(0, 150).map((item) => <label className="provider-model-row" key={item.id}><input type="checkbox" disabled={settingsBusy} checked={enabledModels.includes(item.id)} onChange={(event) => void setEnabled(event.target.checked ? [...enabledModels, item.id] : enabledModels.filter((id) => id !== item.id))} /><span>{item.name}</span>{item.supportsImages && <em>图片</em>}{item.contextWindow && <small>{Math.round(item.contextWindow / 1000)}K</small>}</label>)}
                            {filtered.length === 0 && <div className="settings-empty">{providerModels[provider.id] ? '没有匹配的模型' : '正在加载模型…'}</div>}
                          </div>
                        </div>}
                      </div>;
                    })}
                    {settingsData.providers.length === 0 && <div className="settings-empty">还没有模型来源，添加一个开始使用。</div>}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>自定义模型 <span className="count-badge">{settingsData.customModels?.length || 0}</span></h2><p>手动添加模型，或调整名称、上下文与能力。</p></div><button className="settings-add-button" aria-label="添加自定义模型" onClick={() => void openEditor('model')}>添加</button></div>
                  <div className="custom-model-list">{settingsData.customModels?.map((item) => <div className="custom-model-row" key={`${item.providerId}/${item.modelId}`}><div className="provider-main"><strong>{item.name}</strong><span>{item.providerId}/{item.modelId}</span></div><div className="model-capabilities">{item.contextWindow && <span>{Math.round(item.contextWindow / 1000)}K</span>}{item.supportsImages && <span>图片</span>}{item.reasoning && <span>推理</span>}</div><button className="icon-button row-edit" aria-label={`编辑模型 ${item.name}`} title="编辑" onClick={() => void openEditor('model', `${item.providerId}/${item.modelId}`)}><Pencil /></button><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除模型 ${item.name}`} title="删除" onClick={() => void deleteCustomModel(item.providerId, item.modelId, item.name)}><Trash2 /></button></div>)}</div>
                  {!settingsData.customModels?.length && <div className="settings-empty">还没有自定义模型。</div>}
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
              <div className="settings-sections">
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>扩展包 <span className="count-badge">{settingsData.packages.length}</span></h2><p>从 npm 或 Git 仓库安装扩展。</p></div><button className="settings-add-button" aria-label="安装扩展包" onClick={() => void openEditor('package')}>添加</button></div>
                  <div className="package-list">{settingsData.packages.map((pkg) => <div className="package-row" key={pkg.source}><Plug /><div className="provider-main"><strong>{pkg.name}</strong><span>{pkg.source}</span></div><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`移除扩展包 ${pkg.name}`} title="移除" onClick={() => void removePackage(pkg.source)}><Trash2 /></button></div>)}{settingsData.packages.length === 0 && <div className="settings-empty">还没有安装扩展包。</div>}</div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>本地扩展</h2><p>从本机导入扩展文件或目录。</p></div><button className="settings-add-button" aria-label="添加本地扩展" onClick={() => void openEditor('extension')}>添加</button></div>
                  {(['user', 'project'] as const).map((scope) => {
                    const items = settingsData.extensions.filter((item) => item.scope === scope);
                    return <div className="skill-group" key={scope}><div className="skill-group-title">{scope === 'user' ? '全局' : '项目'}<span>{items.length}</span></div>{items.map((item) => <div className="skill-settings-row" key={item.path}><Plug /><div><strong>{item.name}</strong><p>{item.kind === 'directory' ? '扩展目录' : '扩展文件'}</p><span>{item.path}</span></div><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除扩展 ${item.name}`} title="删除" onClick={() => void deleteExtension(item.path, item.name)}><Trash2 /></button></div>)}{items.length === 0 && <div className="settings-empty settings-empty--small">暂无{scope === 'user' ? '全局' : '项目'}扩展</div>}</div>;
                  })}
                </section>
                {settingsData.extensionData.length > 0 && <section className="settings-card"><div className="settings-card-head"><div><h2>扩展运行数据</h2></div></div><div className="package-list">{settingsData.extensionData.map((name) => <div className="package-row" key={name}><Plug /><div className="provider-main"><strong>{name}</strong></div></div>)}</div></section>}
              </div>
            )}
            {settingsData && settingsTab === 'about' && (
              <section className="settings-card about-card">
                <div className="about-brand"><BrandMark /><div><h2>Pi Studio</h2><p>让想法，在这里成为现实。</p></div><span className="preview-badge">预览版</span></div>
                <dl className="about-list"><div><dt>内核</dt><dd>@earendil-works/pi-coding-agent</dd></div><div><dt>凭据文件</dt><dd>{settingsData.authPath}</dd></div><div><dt>MCP 配置</dt><dd>{settingsData.mcpPath}</dd></div><div><dt>模型配置</dt><dd>{settingsData.modelsPath}</dd></div></dl>
              </section>
            )}
          </section>
          {editor && <SettingsDialog
            title={editor.kind === 'provider' ? editor.editId ? '编辑模型来源' : '添加模型来源' : editor.kind === 'model' ? editor.editId ? '编辑自定义模型' : '添加自定义模型' : editor.kind === 'mcp' ? editor.editId ? '编辑 MCP 服务器' : '添加 MCP 服务器' : editor.kind === 'package' ? '安装扩展包' : editor.kind === 'skill' ? '添加技能' : '添加本地扩展'}
            description={editor.kind === 'mcp' ? '配置工具连接，保存后在新会话中生效。' : editor.kind === 'provider' ? '设置连接方式与认证信息。' : editor.kind === 'model' ? '配置模型的名称与能力。' : editor.kind === 'package' ? '请输入可信的扩展包地址。' : '选择生效范围，再从本机导入。'}
            action={editor.kind === 'skill' ? '选择文件夹并添加' : editor.kind === 'extension' ? '选择文件并添加' : editor.kind === 'package' ? '安装' : editor.editId ? '保存更改' : '添加'}
            busy={settingsBusy} loading={editorLoading} unavailable={Boolean(editor.editId && (editor.kind === 'provider' ? !providerDraft.providerId : editor.kind === 'mcp' ? !originalMcpArgsRef.current : editor.kind === 'model' ? !customModel.modelId : false))} error={editorError} onClose={closeEditor} onSubmit={submitEditor}>
            {editor.kind === 'provider' && <div className="settings-form-grid">
              <label>来源 ID<input autoFocus={!editor.editId} required disabled={Boolean(editor.editId)} value={providerDraft.providerId} onChange={(event) => setProviderDraft({ ...providerDraft, providerId: event.target.value })} placeholder="my-provider" /></label>
              <div className="settings-field"><span>API 类型</span><Select label="API 类型" value={providerDraft.api} onChange={(value) => setProviderDraft({ ...providerDraft, api: value })} options={[...apiTypeOptions, ...(apiTypeOptions.some((option) => option.value === providerDraft.api) ? [] : [{ value: providerDraft.api, label: providerDraft.api }])]} /></div>
              <label className="field-wide">服务地址<input autoFocus={Boolean(editor.editId)} required type="url" value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label className="field-wide">API Key<input aria-label="API Key" aria-describedby="provider-key-help" type="password" autoComplete="new-password" value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} placeholder={editor.editId ? '已保存的凭据不显示，留空保持原值' : 'API Key 或 $ENV_VAR'} /><small id="provider-key-help">支持环境变量引用，例如 $MINIMAX_CN_API_KEY。</small></label>
              <label className="field-wide">图标 URL<input value={providerDraft.icon} onChange={(event) => setProviderDraft({ ...providerDraft, icon: event.target.value })} placeholder="可选，https://... 或 data:image/..." /><small>用于替换默认的品牌图标，留空使用内置图标。</small></label>
              {!editor.editId && <><label>首个模型 ID<input required value={providerDraft.modelId} onChange={(event) => setProviderDraft({ ...providerDraft, modelId: event.target.value })} placeholder="model-id" /></label><label>显示名称<input value={providerDraft.modelName} onChange={(event) => setProviderDraft({ ...providerDraft, modelName: event.target.value })} placeholder="可选，默认使用模型 ID" /></label></>}
            </div>}
            {editor.kind === 'model' && <div className="settings-form-grid">
              <div className="settings-field"><span>模型来源</span><Select label="模型来源" autoFocus={!editor.editId} disabled={Boolean(editor.editId)} value={customModel.providerId} onChange={(value) => setCustomModel({ ...customModel, providerId: value })} options={[{ value: '', label: '选择来源' }, ...(settingsData?.providers ?? []).map((provider) => ({ value: provider.id, label: provider.name }))]} /></div>
              <label>模型 ID<input required disabled={Boolean(editor.editId)} value={customModel.modelId} onChange={(event) => setCustomModel({ ...customModel, modelId: event.target.value })} placeholder="model-id" /></label>
              <label className="field-wide">显示名称<input autoFocus={Boolean(editor.editId)} value={customModel.name} onChange={(event) => setCustomModel({ ...customModel, name: event.target.value })} placeholder="可选，默认使用模型 ID" /></label>
              <label>上下文长度<input type="number" min="1" step="1" value={customModel.contextWindow} onChange={(event) => setCustomModel({ ...customModel, contextWindow: event.target.value })} placeholder="默认值" /></label>
              <label>最大输出<input type="number" min="1" step="1" value={customModel.maxTokens} onChange={(event) => setCustomModel({ ...customModel, maxTokens: event.target.value })} placeholder="默认值" /></label>
              <div className="settings-checkboxes field-wide"><label><input type="checkbox" checked={customModel.supportsImages} onChange={(event) => setCustomModel({ ...customModel, supportsImages: event.target.checked })} />支持图片</label><label><input type="checkbox" checked={customModel.reasoning} onChange={(event) => setCustomModel({ ...customModel, reasoning: event.target.checked })} />推理模型</label></div>
            </div>}
            {editor.kind === 'mcp' && <div className="settings-form-grid">
              <label>名称<input autoFocus required value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} placeholder="例如 filesystem" /></label>
              <div className="settings-field"><span>传输方式</span><Select label="传输方式" value={mcpDraft.transport} onChange={(value) => setMcpDraft({ ...mcpDraft, transport: value })} options={[{ value: 'stdio', label: '本地进程 · stdio' }, { value: 'http', label: 'Streamable HTTP' }]} /></div>
              <label className="field-wide">描述<input value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.target.value })} placeholder="简要说明用途，可选" /></label>
              {mcpDraft.transport === 'stdio' ? <><label className="field-wide">启动命令<input required value={mcpDraft.command} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} placeholder="npx" /></label><label className="field-wide">启动参数<textarea aria-label="启动参数" aria-describedby="mcp-args-help" value={mcpDraft.args} onChange={(event) => setMcpDraft({ ...mcpDraft, args: event.target.value })} rows={4} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'} /><small id="mcp-args-help">每行一个参数，路径中的空格会保留。</small></label></> : <label className="field-wide">服务器地址<input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
              <label className="field-wide">环境变量<textarea aria-label="环境变量" value={mcpDraft.env} onChange={(event) => setMcpDraft({ ...mcpDraft, env: event.target.value })} rows={3} placeholder={'TOKEN=...\nBASE_URL=https://...'} /><small>每行一个 KEY=value，留空表示不设置。</small></label>
            </div>}
            {editor.kind === 'package' && <div className="settings-form-grid"><label className="field-wide">扩展包地址<input aria-label="扩展包地址" autoFocus required value={packageDraft} onChange={(event) => setPackageDraft(event.target.value)} placeholder="npm:pi-tools 或 git:github.com/user/pi-plugin" /><small>扩展拥有本机访问权限，请确认来源可信。</small></label></div>}
            {(editor.kind === 'skill' || editor.kind === 'extension') && <div className="resource-import"><span className="field-label">生效范围</span><div className="scope-options"><label className={resourceScope === 'user' ? 'is-selected' : ''}><input type="radio" name="scope" checked={resourceScope === 'user'} onChange={() => setResourceScope('user')} /><div><strong>全局</strong><span>在所有工作区中使用</span></div></label>{editor.kind === 'extension' && <label className={resourceScope === 'project' ? 'is-selected' : ''}><input type="radio" name="scope" disabled={!workspace} checked={resourceScope === 'project'} onChange={() => setResourceScope('project')} /><div><strong>当前项目</strong><span>{activeWorkspace?.name || '请先选择工作区'}</span></div></label>}</div><p className="import-note">{editor.kind === 'skill' ? '请选择包含 SKILL.md 的技能文件夹。' : '请选择扩展文件，或包含 index.ts / index.js 的文件夹。'}</p></div>}
          </SettingsDialog>}
        </div>
      )}

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

      {shortcutsOpen && <DetailDialog className="shortcuts-dialog" onClose={() => setShortcutsOpen(false)}>
        <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Keyboard /></span><div><h2>快捷键</h2><p>Pi Studio 桌面端当前可用的键盘操作。</p></div></div><button className="icon-button" aria-label="关闭快捷键" onClick={() => setShortcutsOpen(false)}><X /></button></header>
        <div className="shortcut-list">
          {[['发送消息', 'Enter'], ['换行', 'Shift + Enter'], ['打开命令与技能', '/'], ['引用工作区文件', '@'], ['关闭浮层', 'Esc'], ['打开设置', 'Cmd + ,']].map(([label, key]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
        </div>
        <footer className="detail-footer"><span /><button className="settings-outline" onClick={() => setShortcutsOpen(false)}>关闭</button></footer>
      </DetailDialog>}

      {filesOpen && (
        <>
        {!panelFullscreen && <button className="file-panel-backdrop" aria-label="关闭右侧面板" tabIndex={-1} onClick={closePanel} />}
        <aside className={`file-panel ${panelEntered ? 'is-open' : ''} ${panelFullscreen ? 'is-fullscreen' : ''} ${panelSplit ? 'is-split' : ''}`}>
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
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activatePanelTab(tab); } }}
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
              <button className="panel-tab-add" title="打开工作区文件" aria-label="打开工作区文件" onClick={openFilesTab}><Plus /></button>
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

