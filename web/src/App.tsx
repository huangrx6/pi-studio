import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Check, ChevronDown, ChevronLeft, ChevronsDown, ChevronsUp, Clock3, Cpu, FileCode2, FileText, Folder, FolderOpen, Info,
  Layers3, LoaderCircle, MessageSquare, PanelLeft, PanelRight, Pencil, Plug, Search, Settings, SquarePen, Trash2, X,
} from 'lucide-react';
import appIcon from '../../assets/icon.png';
import { Select } from './components/Select';
import { SettingsDialog } from './components/SettingsDialog';
import { ModelPicker } from './components/ModelPicker';
import type { ModelSelection, ThinkingLevel } from './model-types';

const settingsPages = [
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
type PiMessage = { role: 'user' | 'assistant'; text: string; streaming?: boolean };
type CustomModelConfig = { providerId: string; modelId: string; name: string; contextWindow?: number; maxTokens?: number; supportsImages: boolean; reasoning: boolean };
type SettingsEditor = { kind: 'provider' | 'model' | 'mcp' | 'package' | 'skill' | 'extension'; editId?: string };
type SettingsSnapshot = {
  customModels: CustomModelConfig[];
  providers: Array<{ id: string; name: string; mode: string; authConfigured?: boolean; envName?: string; envAvailable?: boolean; models: number }>;
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

export function App() {
  const [workspaces, setWorkspaces] = useState<PiWorkspace[]>([]);
  const [stateLoading, setStateLoading] = useState(true);
  const [workspace, setWorkspace] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelSelection>({ modelRef: '', label: '', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off', defaultThinkingLevel: 'off' });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readStored<string[]>(UI_KEYS.expanded, [])));
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => readStored<string[]>(UI_KEYS.workspaceOrder, []));
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => readStored<Record<string, string[]>>(UI_KEYS.sessionOrder, {}));
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [draggingItem, setDraggingItem] = useState<DragItem | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const [session, setSession] = useState<{ id: string; cwd: string; title: string } | null>(null);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string; model: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }>>>({});
  const [customModel, setCustomModel] = useState({ providerId: '', modelId: '', name: '', contextWindow: '', maxTokens: '', supportsImages: false, reasoning: false });
  const [packageDraft, setPackageDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'models' | 'mcp' | 'skills' | 'extensions' | 'about'>('models');
  const [settingsData, setSettingsData] = useState<SettingsSnapshot | null>(null);
  const [editor, setEditor] = useState<SettingsEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [resourceScope, setResourceScope] = useState<'user' | 'project'>('user');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '' });
  const [mcpDraft, setMcpDraft] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '', env: '' });
  const [treePath, setTreePath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [file, setFile] = useState<{ path: string; size: number; binary: boolean; text: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsContentRef = useRef<HTMLElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<string | null>(null);
  const editorRequestRef = useRef(0);
  const originalMcpArgsRef = useRef<string[] | null>(null);
  const workspaceOrderRef = useRef(workspaceOrder);
  const sessionOrderRef = useRef(sessionOrder);
  const dragRef = useRef<DragItem | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

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
    setProviderDraft({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '' });
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
      setProviderDraft({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '' });
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

  useEffect(() => window.piApi.onPrompt((event) => {
    if (event.requestId !== requestRef.current) return;
    if (event.type === 'delta') {
      setMessages((current) => {
        const copy = [...current];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, text: last.text + (event.text ?? '') };
        else copy.push({ role: 'assistant', text: event.text ?? '' });
        return copy;
      });
    }
    if (event.type === 'done') {
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
      setError(null);
      void loadState();
    }
    if (event.type === 'error') {
      setError(event.message ?? '执行失败');
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
    }
  }), [loadState]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (filesOpen && workspace) void loadTree('');
  }, [filesOpen, workspace]);

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

  function makeDragPreview(event: React.DragEvent, label: string, kind: '工作区' | '会话') {
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
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function openSession(item: PiSessionSummary) {
    const detail = await window.piApi.session(item.id);
    if (!detail) return;
    setSession({ id: detail.id, cwd: detail.cwd, title: detail.title });
    setMessages(detail.messages.map((message) => ({ ...message })));
    setWorkspace(detail.cwd);
    expandWorkspace(detail.cwd);
    setError(null);
    setBusy(false);
  }

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    let current = session;
    if (!current) {
      if (!workspace) await loadState();
      const created = await window.piApi.createSession(workspace);
      current = { id: created.id, cwd: created.cwd, title: created.title };
      setSession(current);
      setMessages([]);
    }
    setPrompt('');
    setBusy(true);
    setError(null);
    setMessages((existing) => [...existing, { role: 'user', text }, { role: 'assistant', text: '', streaming: true }]);
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    try {
      await window.piApi.prompt({ sessionId: current.id, text, requestId });
      const saved = await window.piApi.session(current.id);
      if (saved) setSession({ id: saved.id, cwd: saved.cwd, title: saved.title });
      await loadState();
    } catch (error) {
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
      setFile(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setFileBusy(false); }
  }

  async function openFile(target: string) {
    if (!workspace) return;
    setFileBusy(true);
    try { setFile(await window.piApi.file(workspace, target)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setFileBusy(false); }
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

  return (
    <div className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
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

      <main className={`main ${isNewConversation ? 'is-new-conversation' : ''}`}>
        <header className="chat-header">
          {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={() => setSidebarCollapsed(false)}><PanelLeft /></button>}
          {!isNewConversation && <div className="chat-heading">
            <h1>{session?.title || 'Pi Studio'}</h1>
            <div className="chat-meta"><span className={`state-dot ${busy ? 'is-busy' : ''}`} />{busy ? '正在处理' : '准备就绪'}{activeWorkspace && <><span>·</span><span className="workspace-name">{activeWorkspace.name}</span></>}</div>
          </div>}
          <div className="chat-actions">
            <button className={`icon-button ${filesOpen ? 'is-active' : ''}`} onClick={() => setFilesOpen((value) => !value)} aria-label="文件查看器"><PanelRight size={16} /></button>
          </div>
        </header>
        {!isNewConversation && <div className="chat-tabs">
          <button className="tab is-active">对话</button>
          <button className="tab" disabled title="执行轨迹即将推出">轨迹</button>
          <span className="chat-tabs-note">{messages.length > 0 ? `${messages.length} 条消息` : '从一个想法开始'}</span>
        </div>}

        {!isNewConversation && <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-column">
            {messages.length > 0 && (
              <div className="messages">
                {messages.map((message, index) => (
                  <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                    {message.role === 'user' ? (
                      <div className="user-bubble">{message.text}</div>
                    ) : (
                      <div className="assistant-text">{message.text}<span className={message.streaming ? 'caret' : 'caret hidden'} /></div>
                    )}
                  </div>
                ))}
                {busy && !messages.some((message) => message.role === 'assistant' && message.text) && (
                  <div className="thinking"><span /><span /><span />正在思考</div>
                )}
              </div>
            )}
            {error && <div className="error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
          </div>
        </div>}

        <div className="composer-dock">
          {isNewConversation && <div className="new-conversation-intro">
            <span className="new-conversation-context" title={workspace}>{activeWorkspace?.name || (workspace ? workspace.split('/').pop() : 'Pi Studio')}</span>
            <h2>今天，<em>想做点什么？</em></h2>
            <p>从一个念头开始。</p>
          </div>}
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
              }}
              aria-label="发送给 Pi 的消息"
              placeholder="描述你的想法，或交给 Pi 一个任务…"
              rows={2}
            />
            <div className="composer-bar">
              <div className="composer-right">
                <ModelPicker selection={modelSelection} disabled={busy || stateLoading} hidden={settingsOpen} loadCatalog={loadModelCatalog} onSelectModel={selectModel} onSelectThinking={selectThinking} onManage={() => void openSettings('models')} />
                <button className="send-button" disabled={busy || !prompt.trim()} onClick={() => void send()} aria-label={busy ? '正在生成回复' : '发送消息'} title="发送消息"><ArrowUp /></button>
              </div>
            </div>
          </div>
          <div className="composer-hint"><span>Pi Studio <span className="preview-badge">预览版</span></span><span><kbd>↵</kbd> 发送 <span className="hint-divider">·</span> <kbd>⇧ ↵</kbd> 换行</span></div>
          {isNewConversation && error && <div className="new-conversation-error error-card" role="alert"><strong>暂时无法完成操作</strong><p>{error}</p></div>}
        </div>
      </main>

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
          <aside className="settings-nav">
            <div className="settings-nav-head"><span>设置</span><button autoFocus className="icon-button" aria-label="关闭设置" title="返回对话 · Esc" onClick={() => setSettingsOpen(false)}><X /></button></div>
            {settingsPages.map((page) => <button key={page.id} className={`settings-nav-row ${settingsTab === page.id ? 'is-active' : ''}`} aria-current={settingsTab === page.id ? 'page' : undefined} onClick={() => { setSettingsTab(page.id); setModelQuery(''); }}><page.icon />{page.label}</button>)}
            <button className="settings-nav-foot" onClick={() => setSettingsOpen(false)}><ChevronLeft /><span>返回工作台</span><kbd>Esc</kbd></button>
          </aside>
          <section className="settings-content" ref={settingsContentRef}>
            {settingsError && <div className="settings-error" role="alert">{settingsError}</div>}
            {!settingsData && !settingsError && <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在加载设置…</div>}
            {settingsData && settingsTab === 'models' && (
              <div className="settings-sections">
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>已启用模型 <span className="count-badge">{enabledModels.length}</span></h2><p>点击模型切换当前对话使用的模型。</p></div></div>
                  {enabledModels.length > 0 ? <div className="enabled-model-list">
                    {enabledModels.map((id) => <div className={`enabled-model-row ${id === modelRef ? 'is-active' : ''}`} key={id}>
                      <button className="enabled-model-main" onClick={() => void selectModel(id).then(async () => setSettingsData(await window.piApi.settings(workspace)))}><span>{models.find((item) => item.id === id)?.name ?? id}</span><small>{id}</small>{id === modelRef && <Check />}</button>
                      <button className="settings-mini-button" disabled={settingsBusy} onClick={() => void setEnabled(enabledModels.filter((item) => item !== id))}>移除</button>
                    </div>)}
                  </div> : <div className="settings-empty">在下方添加来源，再选择要启用的模型。</div>}
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>模型来源 <span className="count-badge">{settingsData.providers.length}</span></h2><p>管理服务地址、认证信息和可用模型。</p></div><button className="settings-add-button" aria-label="添加模型来源" onClick={() => void openEditor('provider')}>添加</button></div>
                  <div className="provider-cards">
                    {settingsData.providers.map((provider) => {
                      const list = providerModels[provider.id] ?? [];
                      const filtered = list.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
                      return <div className="provider-card" key={provider.id}>
                        <div className="provider-card-head">
                          <div className="provider-avatar">{provider.name.slice(0, 1)}</div>
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
                <div className="mcp-settings-list">
                  {settingsData.mcp.map((server) => <div className="mcp-settings-row" key={server.name}>
                    <div className="provider-main"><strong>{server.name}</strong>{server.description && <p>{server.description}</p>}<span title={server.target}>{server.transport} · {server.target}</span></div>
                    <div className="row-actions"><button className="icon-button row-edit" aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => void openEditor('mcp', server.name)}><Pencil /></button><span className={`resource-status ${server.enabled ? 'is-on' : ''}`}>{server.enabled ? '已启用' : '已停用'}</span><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除 MCP ${server.name}`} title="删除" onClick={() => void deleteMcp(server.name)}><Trash2 /></button><button className={`switch ${server.enabled ? 'is-on' : ''}`} role="switch" aria-checked={server.enabled} disabled={settingsBusy} onClick={() => void toggleMcp(server.name, !server.enabled)} aria-label={`${server.name} ${server.enabled ? '禁用' : '启用'}`}><span /></button></div>
                  </div>)}
                  {settingsData.mcp.length === 0 && <div className="settings-empty">还没有 MCP 服务器。</div>}
                </div>
                <p className="settings-footnote">更改会在新会话中生效。</p>
              </section>
            )}
            {settingsData && settingsTab === 'skills' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>技能 <span className="count-badge">{settingsData.skills.length}</span></h2><p>为 Pi 添加可复用的工作方法。</p></div><button className="settings-add-button" aria-label="添加技能" onClick={() => void openEditor('skill')}>添加</button></div>
                {(['user', 'project', 'temporary'] as const).map((scope) => {
                  const items = settingsData.skills.filter((skill) => skill.scope === scope);
                  const label = scope === 'user' ? '全局' : scope === 'project' ? '项目' : '其他';
                  return <div className="skill-group" key={scope}><div className="skill-group-title">{label}<span>{items.length}</span></div>{items.map((skill) => <div className="skill-settings-row" key={skill.path}><FileCode2 /><div><strong>{skill.name}</strong><p>{skill.description}</p><span>{skill.path}</span></div><button className="icon-button resource-delete" disabled={settingsBusy} aria-label={`删除技能 ${skill.name}`} title="删除" onClick={() => void deleteSkill(skill.path, skill.name)}><Trash2 /></button></div>)}{items.length === 0 && <div className="settings-empty settings-empty--small">暂无{label}技能</div>}</div>;
                })}
                <p className="settings-footnote">添加或修改技能后，在新会话中使用。</p>
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
            {(editor.kind === 'skill' || editor.kind === 'extension') && <div className="resource-import"><span className="field-label">生效范围</span><div className="scope-options"><label className={resourceScope === 'user' ? 'is-selected' : ''}><input type="radio" name="scope" checked={resourceScope === 'user'} onChange={() => setResourceScope('user')} /><div><strong>全局</strong><span>在所有工作区中使用</span></div></label><label className={resourceScope === 'project' ? 'is-selected' : ''}><input type="radio" name="scope" disabled={!workspace} checked={resourceScope === 'project'} onChange={() => setResourceScope('project')} /><div><strong>当前项目</strong><span>{activeWorkspace?.name || '请先选择工作区'}</span></div></label></div><p className="import-note">{editor.kind === 'skill' ? '请选择包含 SKILL.md 的技能文件夹。' : '请选择扩展文件，或包含 index.ts / index.js 的文件夹。'}</p></div>}
          </SettingsDialog>}
        </div>
      )}

      {filesOpen && (
        <>
        <button className="file-panel-backdrop" aria-label="关闭文件抽屉" tabIndex={-1} onClick={() => setFilesOpen(false)} />
        <aside className="file-panel">
          <div className="file-panel-head">
            <div><strong>工作区文件</strong><span title={workspace}>{activeWorkspace?.name || workspace}</span></div>
            <button className="icon-button" aria-label="关闭文件查看器" title="关闭文件查看器" onClick={() => setFilesOpen(false)}><X /></button>
          </div>
          {!file ? (
            <>
              <div className="file-toolbar">
                <button className="icon-button" aria-label="返回上级目录" title="返回上级目录" disabled={!treePath} onClick={() => void loadTree(treePath.split('/').slice(0, -1).join('/'))}><ChevronLeft /></button>
                <span className="path-label">{treePath ? `/${treePath}` : '/'}</span>
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
            </>
          ) : (
            <>
              <div className="file-toolbar">
                <button className="icon-button" aria-label="返回文件列表" title="返回文件列表" onClick={() => setFile(null)}><ChevronLeft /></button>
                <span className="path-label">{file.path}</span>
                <small>{filesize(file.size)}</small>
              </div>
              {file.binary ? <div className="file-empty"><FileText /><strong>暂不支持预览此文件</strong><span>可以在其他应用中查看二进制文件。</span></div> : <pre className="file-code"><code>{file.text.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><span>{line || ' '}</span></span>)}</code></pre>}
            </>
          )}
          {fileBusy && <div className="file-loading" role="status"><LoaderCircle className="spin" />正在读取文件…</div>}
        </aside>
        </>
      )}
    </div>
  );
}
