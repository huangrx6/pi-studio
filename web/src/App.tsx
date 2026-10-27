import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, ChevronDown, ChevronLeft, FileText, Folder, FolderOpen, MoreHorizontal,
  PanelRight, Paperclip, Search, Settings, SlidersHorizontal, SquarePen, X,
} from 'lucide-react';

type PiSessionSummary = { id: string; cwd: string; title: string; updatedAt: number; messageCount: number };
type PiWorkspace = { cwd: string; name: string; sessions: PiSessionSummary[] };
type PiMessage = { role: 'user' | 'assistant'; text: string; streaming?: boolean };

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
          <button className="bottom-row"><Settings size={16} /><span>设置</span><span className="status"><i />Pi SDK 本地</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="chat-header">
          <div className="chat-heading">
            <h1>{session?.title || 'Pi Studio'}</h1>
            <div className="chat-meta"><span className="state-dot" />{session ? 'Pi Agent' : '准备就绪'}<span>·</span><span className="branch">main</span></div>
          </div>
          <div className="chat-actions">
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
