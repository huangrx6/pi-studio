import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Check, ChevronDown, ChevronLeft, Cpu, FileCode2, FileText, Folder, FolderOpen, Info, MoreHorizontal,
  PanelRight, Paperclip, Plug, Search, Settings, SlidersHorizontal, SquarePen, X,
} from 'lucide-react';

type PiSessionSummary = { id: string; cwd: string; title: string; updatedAt: number; messageCount: number };
type PiWorkspace = { cwd: string; name: string; sessions: PiSessionSummary[] };
type PiMessage = { role: 'user' | 'assistant'; text: string; streaming?: boolean };
type SettingsSnapshot = {
  providers: Array<{ id: string; name: string; mode: string; models: number }>;
  mcp: Array<{ name: string; transport: string; enabled: boolean; target: string; description: string }>;
  skills: Array<{ name: string; description: string; path: string; scope: string }>;
  extensions: Array<{ name: string; scope: string; path: string; kind: string }>;
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

export function App() {
  const [workspaces, setWorkspaces] = useState<PiWorkspace[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [model, setModel] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [session, setSession] = useState<{ id: string; cwd: string; title: string } | null>(null);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'models' | 'mcp' | 'skills' | 'extensions' | 'about'>('models');
  const [settingsData, setSettingsData] = useState<SettingsSnapshot | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '' });
  const [mcpDraft, setMcpDraft] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '' });
  const [treePath, setTreePath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [file, setFile] = useState<{ path: string; size: number; binary: boolean; text: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestRef = useRef<string | null>(null);

  const loadState = useCallback(async () => {
    const next = await window.piApi.state();
    setWorkspaces(next.workspaces);
    setModel(next.model.label);
    setExpanded((current) => {
      const ids = new Set(current);
      for (const item of next.workspaces) ids.add(item.cwd);
      return ids;
    });
    setWorkspace((current) => current || next.workspaces[0]?.cwd || next.cwd);
  }, []);

  async function openSettings() {
    setSettingsOpen(true);
    setSettingsError(null);
    try {
      const [snapshot, modelResult] = await Promise.all([window.piApi.settings(workspace), window.piApi.models()]);
      setSettingsData(snapshot);
      setModels(modelResult.models);
      setModelRef(modelResult.current);
      setModel(snapshot.model.label);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveProviderKey(providerId: string) {
    const apiKey = keyDrafts[providerId]?.trim();
    if (!apiKey) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const snapshot = await window.piApi.setKey({ providerId, apiKey });
      setSettingsData(snapshot);
      setModel(snapshot.model.label);
      setKeyDrafts((current) => ({ ...current, [providerId]: '' }));
      await loadState();
    } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setSettingsBusy(false); }
  }

  async function saveProvider() {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const result = await window.piApi.addProvider(providerDraft);
      setSettingsData(result.settings);
      setModels(result.models.models);
      setModelRef(result.models.current);
      setProviderDraft({ providerId: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', apiKey: '' });
      await loadState();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function saveMcp() {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const next = await window.piApi.addMcp(mcpDraft);
      setSettingsData(next);
      setMcpDraft({ name: '', transport: 'stdio', command: '', args: '', url: '', description: '' });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function importResource(kind: 'skill' | 'extension', scope: 'user' | 'project') {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const next = kind === 'skill'
        ? await window.piApi.addSkill({ scope, cwd: workspace })
        : await window.piApi.addExtension({ scope, cwd: workspace });
      if (next) setSettingsData(next);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
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

  async function openModels() {
    const result = await window.piApi.models();
    setModels(result.models);
    setModelRef(result.current);
    setModelQuery('');
    setModelsOpen((value) => !value);
  }

  async function selectModel(next: string) {
    const result = await window.piApi.setModel(next);
    setModel(result.label);
    setModelRef(next);
    setModelsOpen(false);
  }

  useEffect(() => { void loadState(); }, [loadState]);

  useEffect(() => window.piApi.onOpenSettings(() => { void openSettings(); }), [workspace]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  async function startSession(cwd = workspace) {
    if (!cwd) return;
    const created = await window.piApi.createSession(cwd);
    setSession({ id: created.id, cwd: created.cwd, title: created.title });
    setMessages([]);
    setError(null);
    setPrompt('');
    setWorkspace(cwd);
    setBusy(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function openSession(item: PiSessionSummary) {
    const detail = await window.piApi.session(item.id);
    if (!detail) return;
    setSession({ id: detail.id, cwd: detail.cwd, title: detail.title });
    setMessages(detail.messages.map((message) => ({ ...message })));
    setWorkspace(detail.cwd);
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="brand">
          <span className="pi-mark">π</span>
          <span className="brand-name">Pi Studio</span>
          <button className="icon-button collapse"><PanelRight size={15} /></button>
        </div>
        <button className="new-chat" onClick={() => void startSession()}><SquarePen size={15} /><span>新会话</span></button>
        <nav className="nav">
          <button className="nav-row is-active"><span className="nav-glyph">◌</span>对话</button>
          <button className="nav-row"><span className="nav-glyph">◇</span>插件</button>
          <button className="nav-row"><span className="nav-glyph">◷</span>自动化任务</button>
          <button className="nav-row"><span className="nav-glyph">⌘</span>更多</button>
        </nav>
        <div className="workspace-head">
          <span>工作区</span>
          <div>
            <button className="icon-button"><Search size={14} /></button>
            <button className="icon-button"><SlidersHorizontal size={14} /></button>
            <button className="icon-button" onClick={chooseFile}><FolderOpen size={14} /></button>
          </div>
        </div>
        <div className="workspace-list">
          {workspaces.map((item) => {
            const isOpen = expanded.has(item.cwd);
            const isActive = workspace === item.cwd;
            return (
              <div className="workspace" key={item.cwd}>
                <button
                  className={`workspace-row ${isActive ? 'is-active' : ''}`}
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
                        className={`session-row ${session?.id === sessionItem.id ? 'is-active' : ''}`}
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
        </div>
        <div className="sidebar-bottom">
          <button className="bottom-row" onClick={() => void openSettings()}><Settings size={16} /><span>设置</span><span className="status"><i />Pi SDK 本地</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="chat-header">
          <div className="chat-heading">
            <h1>{session?.title || 'Pi Studio'}</h1>
            <div className="chat-meta"><span className="state-dot" />{session ? 'Pi Agent' : '准备就绪'}<span>·</span><span className="branch">main</span></div>
          </div>
          <div className="chat-actions">
            <button className="icon-button" onClick={() => void openSettings()} aria-label="设置"><Settings size={16} /></button>
            <button className={`icon-button ${filesOpen ? 'is-active' : ''}`} onClick={() => setFilesOpen((value) => !value)} aria-label="文件查看器"><PanelRight size={16} /></button>
            <button className="icon-button"><MoreHorizontal size={16} /></button>
          </div>
        </header>
        <div className="chat-tabs">
          <button className="tab is-active">对话</button>
          <button className="tab">轨迹</button>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-column">
            {!session && messages.length === 0 ? (
              <div className="hero">
                <span className="hero-mark">π</span>
                <h1>今天想让 Pi 做什么？</h1>
                <span className="preview-badge">预览版</span>
              </div>
            ) : (
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
                {error && <div className="error-card"><strong>执行失败</strong><p>{error}</p></div>}
              </div>
            )}
          </div>
        </div>

        <div className="composer-dock">
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
              }}
              placeholder="描述你想要构建的内容，/ 调用指令，@ 文件或对话"
              rows={2}
            />
            <div className="composer-bar">
              <div className="composer-left">
                <button className="icon-button"><Paperclip size={17} /></button>
                <button className="workspace-chip" onClick={chooseFile}><Folder size={14} />{activeWorkspace?.name || '选择工作区'}<ChevronDown size={12} /></button>
              </div>
              <div className="composer-right">
                <button className="model-label" onClick={() => void openModels()}>{model}<ChevronDown size={11} /></button>
                <button className="send-button" disabled={busy || !prompt.trim()} onClick={() => void send()}><ArrowUp size={16} /></button>
              </div>
            </div>
          </div>
        </div>
        {modelsOpen && (
          <div className="model-popover" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-popover__head">选择模型<span>{models.length} 个</span></div>
            <input autoFocus className="model-search" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" />
            <div className="model-list">
              {models.filter((item) => item.name.toLowerCase().includes(modelQuery.toLowerCase())).map((item) => (
                <button key={item.id} className={`model-row ${item.id === modelRef ? 'is-active' : ''}`} onClick={() => void selectModel(item.id)}>
                  <span>{item.name}</span>
                  <small>{item.id.split('/')[0]}</small>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {settingsOpen && (
        <div className="settings-overlay">
          <aside className="settings-nav">
            <div className="settings-nav-head"><span>设置</span><button className="icon-button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
            <div className="settings-search"><Search size={14} /><span>搜索设置</span></div>
            <button className={`settings-nav-row ${settingsTab === 'models' ? 'is-active' : ''}`} onClick={() => setSettingsTab('models')}><Cpu size={15} />模型与账号</button>
            <button className={`settings-nav-row ${settingsTab === 'mcp' ? 'is-active' : ''}`} onClick={() => setSettingsTab('mcp')}><Plug size={15} />MCP 服务器</button>
            <button className={`settings-nav-row ${settingsTab === 'skills' ? 'is-active' : ''}`} onClick={() => setSettingsTab('skills')}><FileCode2 size={15} />技能</button>
            <button className={`settings-nav-row ${settingsTab === 'extensions' ? 'is-active' : ''}`} onClick={() => setSettingsTab('extensions')}><Plug size={15} />扩展</button>
            <button className={`settings-nav-row ${settingsTab === 'about' ? 'is-active' : ''}`} onClick={() => setSettingsTab('about')}><Info size={15} />关于</button>
            <div className="settings-nav-foot">Pi Studio · Pi SDK</div>
          </aside>
          <section className="settings-content">
            <header className="settings-title">
              <h1>{settingsTab === 'models' ? '模型与账号' : settingsTab === 'mcp' ? 'MCP 服务器' : settingsTab === 'skills' ? '技能' : settingsTab === 'extensions' ? '扩展' : '关于'}</h1>
              <p>{settingsTab === 'models' ? '配置 Pi 的模型来源和凭据。' : settingsTab === 'mcp' ? '管理 Pi 的 MCP 服务器配置。' : settingsTab === 'skills' ? 'Pi 会从本机技能目录加载这些技能。' : settingsTab === 'extensions' ? '扩展运行在 Pi 进程内，仅加载可信代码。' : 'Pi Studio 运行在 Pi Agent SDK 上。'}</p>
            </header>
            {settingsError && <div className="settings-error">{settingsError}</div>}
            {settingsData && settingsTab === 'models' && (
              <div className="settings-sections">
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>当前模型</h2><p>选择下一个新会话使用的 Pi 模型。</p></div><span className="settings-model-current">{settingsData.model.label}</span></div>
                  <div className="settings-model-list">
                    {models.slice(0, 120).map((item) => (
                      <button key={item.id} className={`settings-model-row ${item.id === modelRef ? 'is-active' : ''}`} onClick={() => void selectModel(item.id).then(async () => { const next = await window.piApi.settings(); setSettingsData(next); })}>
                        <span>{item.name}</span><small>{item.id.split('/')[0]}</small>{item.id === modelRef && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-head"><div><h2>来源与凭据</h2><p>只显示 Pi 已配置的来源。Key 保存在 Pi 的 auth.json，不会写入项目。</p></div></div>
                  <details className="settings-add">
                    <summary>添加自定义来源</summary>
                    <div className="settings-form-grid">
                      <label>来源 ID<input value={providerDraft.providerId} onChange={(event) => setProviderDraft({ ...providerDraft, providerId: event.target.value })} placeholder="my-provider" /></label>
                      <label>Base URL<input value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
                      <label>API<select value={providerDraft.api} onChange={(event) => setProviderDraft({ ...providerDraft, api: event.target.value })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
                      <label>模型 ID<input value={providerDraft.modelId} onChange={(event) => setProviderDraft({ ...providerDraft, modelId: event.target.value })} placeholder="model-id" /></label>
                      <label>显示名称<input value={providerDraft.modelName} onChange={(event) => setProviderDraft({ ...providerDraft, modelName: event.target.value })} placeholder="My Model" /></label>
                      <label>API Key<input type="password" value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} placeholder="sk-..." /></label>
                    </div>
                    <button className="settings-save settings-form-submit" disabled={settingsBusy} onClick={() => void saveProvider()}>保存到 Pi models.json</button>
                  </details>
                  <div className="provider-list">
                    {settingsData.providers.map((provider) => (
                      <div className="provider-row" key={provider.id}>
                        <div className="provider-main"><strong>{provider.name}</strong><span>{provider.id} · {provider.models} 个模型</span></div>
                        <span className="provider-mode">{provider.mode === 'oauth' ? 'OAuth' : provider.mode === 'env' ? '环境变量' : 'API Key'}</span>
                        <input type="password" value={keyDrafts[provider.id] ?? ''} onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder="输入新的 API Key" />
                        <button className="settings-save" disabled={settingsBusy || !keyDrafts[provider.id]?.trim()} onClick={() => void saveProviderKey(provider.id)}>保存</button>
                      </div>
                    ))}
                    {settingsData.providers.length === 0 && <div className="settings-empty">还没有可配置的 Pi 来源。</div>}
                  </div>
                </section>
              </div>
            )}
            {settingsData && settingsTab === 'mcp' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>已配置的 MCP</h2><p>来自 {settingsData.mcpPath}。保存后新会话生效。</p></div></div>
                <details className="settings-add">
                  <summary>添加 MCP 服务器</summary>
                  <div className="settings-form-grid">
                    <label>名称<input value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} placeholder="filesystem" /></label>
                    <label>传输<select value={mcpDraft.transport} onChange={(event) => setMcpDraft({ ...mcpDraft, transport: event.target.value })}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></select></label>
                    {mcpDraft.transport === 'stdio' ? <><label>命令<input value={mcpDraft.command} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} placeholder="npx" /></label><label>参数<input value={mcpDraft.args} onChange={(event) => setMcpDraft({ ...mcpDraft, args: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem ." /></label></> : <label>URL<input value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
                    <label>描述<input value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.target.value })} placeholder="可选" /></label>
                  </div>
                  <button className="settings-save settings-form-submit" disabled={settingsBusy} onClick={() => void saveMcp()}>保存到 Pi mcp.json</button>
                </details>
                <div className="mcp-settings-list">
                  {settingsData.mcp.map((server) => (
                    <div className="mcp-settings-row" key={server.name}>
                      <div className="provider-main"><strong>{server.name}</strong><span>{server.transport} · {server.target}</span></div>
                      <button className={`switch ${server.enabled ? 'is-on' : ''}`} disabled={settingsBusy} onClick={() => void toggleMcp(server.name, !server.enabled)} aria-label={`${server.name} ${server.enabled ? '禁用' : '启用'}`}><span /></button>
                    </div>
                  ))}
                  {settingsData.mcp.length === 0 && <div className="settings-empty">还没有 MCP 服务器。</div>}
                </div>
              </section>
            )}
            {settingsData && settingsTab === 'skills' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>已加载技能</h2><p>从 Pi 的技能目录发现；技能修改后需要新会话。</p></div></div>
                <div className="skill-settings-list">
                  {settingsData.skills.map((skill) => (
                    <div className="skill-settings-row" key={skill.path}><FileCode2 size={16} /><div><strong>{skill.name}</strong><p>{skill.description}</p><span>{skill.scope} · {skill.path}</span></div></div>
                  ))}
                  {settingsData.skills.length === 0 && <div className="settings-empty">还没有发现技能。</div>}
                </div>
              </section>
            )}
            {settingsData && settingsTab === 'extensions' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>Pi 扩展</h2><p>扩展运行在 Pi 进程内，拥有宿主权限。只加载你信任的扩展。</p></div><div className="settings-add-actions"><button className="settings-save" disabled={settingsBusy} onClick={() => void importResource('extension', 'user')}>添加全局扩展</button><button className="settings-outline" disabled={settingsBusy} onClick={() => void importResource('extension', 'project')}>添加项目扩展</button></div></div>
                {(['user', 'project'] as const).map((scope) => {
                  const items = settingsData.extensions.filter((item) => item.scope === scope);
                  return <div className="skill-group" key={scope}><div className="skill-group-title">{scope === 'user' ? '全局' : '项目'}</div>{items.map((item) => <div className="skill-settings-row" key={item.path}><Plug size={16} /><div><strong>{item.name}</strong><p>{item.kind === 'directory' ? '扩展目录' : '扩展文件'}</p><span>{item.path}</span></div></div>)}{items.length === 0 && <div className="settings-empty settings-empty--small">暂无{scope === 'user' ? '全局' : '项目'}扩展</div>}</div>;
                })}
              </section>
            )}
            {settingsData && settingsTab === 'about' && (
              <section className="settings-card">
                <div className="settings-card-head"><div><h2>Pi Studio</h2><p>基于 Pi Agent SDK 的桌面工作台。</p></div></div>
                <dl className="about-list"><div><dt>内核</dt><dd>@earendil-works/pi-coding-agent</dd></div><div><dt>凭据文件</dt><dd>{settingsData.authPath}</dd></div><div><dt>MCP 配置</dt><dd>{settingsData.mcpPath}</dd></div></dl>
              </section>
            )}
          </section>
        </div>
      )}

      {filesOpen && (
        <aside className="file-panel">
          <div className="file-panel-head">
            <div><strong>文件</strong><span>{workspace}</span></div>
            <button className="icon-button" onClick={() => setFilesOpen(false)}><X size={15} /></button>
          </div>
          {!file ? (
            <>
              <div className="file-toolbar">
                <button className="icon-button" disabled={!treePath} onClick={() => void loadTree(treePath.split('/').slice(0, -1).join('/'))}><ChevronLeft size={15} /></button>
                <span className="path-label">{treePath ? `/${treePath}` : '/'}</span>
              </div>
              <div className="file-tree">
                {entries.map((entry) => (
                  <button key={entry.path} className="file-row" onClick={() => entry.type === 'directory' ? void loadTree(entry.path) : void openFile(entry.path)}>
                    {entry.type === 'directory' ? <Folder size={15} /> : <FileText size={15} />}
                    <span>{entry.name}</span>
                    {entry.type === 'file' && <small>{filesize(entry.size)}</small>}
                    {entry.type === 'directory' && <ChevronDown size={13} className="chevron-left" />}
                  </button>
                ))}
                {entries.length === 0 && <div className="file-empty">这个目录是空的</div>}
              </div>
            </>
          ) : (
            <>
              <div className="file-toolbar">
                <button className="icon-button" onClick={() => setFile(null)}><ChevronLeft size={15} /></button>
                <span className="path-label">{file.path}</span>
                <small>{filesize(file.size)}</small>
              </div>
              {file.binary ? <div className="file-empty">二进制文件不可预览</div> : <pre className="file-code">{file.text}</pre>}
            </>
          )}
          {fileBusy && <div className="file-loading">读取中…</div>}
        </aside>
      )}
    </div>
  );
}
