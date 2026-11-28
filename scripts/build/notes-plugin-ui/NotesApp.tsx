import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen, Code2, Columns2, ExternalLink, FileText, FolderOpen,
  ListTree, PanelLeft, Plus, RefreshCw, Save as SaveIcon, X,
} from 'lucide-react';
import libraryIcon from '../../../assets/official-plugins/packages/notes-library/assets/icon.png';
import {
  askAboutNote, label, message, notePath, request, retry, useBridge,
  type Entry, type Library, type Note, type Save, type Search, type Section, type Tree,
} from './bridge';
import { DEFAULT_APPEARANCE, notesTheme, type Appearance, type Scheme } from './appearance';
import { AttachmentReader, HtmlReader, MarkdownReader, type Heading } from './Reader';
import { NotesTree } from './NotesTree';
import { ManageEntry, Modal, MoveEntry, NewEntry, type CreateKind } from './NotesDialogs';
import { Breadcrumb, IconButton, SaveStatus, ThemeMenu } from './Toolbar';
import { ResizableOutline, SIDEBAR_BOUNDS } from './ResizableOutline';

type Mode = 'read' | 'source' | 'split';
type Draft = { note: Note; text: string; external?: Note | null };
type StoredDraft = { text: string; revision: string };
type Popup = { kind: 'settings' | 'leave' | 'compare' } | { kind: 'create'; parent: string }
  | { kind: 'manage' | 'rename' | 'move' | 'trash'; entry: Entry };
const EMPTY_TREE: Tree = { entries: [], sections: {}, partial: false };
const MODES = [
  { key: 'read', text: '阅读', icon: BookOpen },
  { key: 'source', text: '源码', icon: Code2 },
  { key: 'split', text: '分屏', icon: Columns2 },
] as const;

export function NotesApp() {
  const state = useBridge();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localAppearance, setLocalAppearance] = useState<Appearance>();
  const appearanceRequest = useRef(0);
  const appearance = localAppearance ?? state.data?.appearance ?? DEFAULT_APPEARANCE;
  const palette = notesTheme(appearance.theme, state.host.scheme);
  const themeKey = palette.isCustom ? palette.id : 'studio-' + state.host.revision;

  async function changeAppearance(patch: Partial<Appearance>) {
    const id = ++appearanceRequest.current;
    setLocalAppearance(current => ({ ...(current ?? appearance), ...patch }));
    try {
      const saved = await request<Appearance>('setAppearance', patch);
      if (id === appearanceRequest.current) setLocalAppearance(saved);
    } catch (reason) {
      if (id === appearanceRequest.current) setLocalAppearance(undefined);
      throw reason;
    }
  }
  async function choose() {
    setBusy(true);
    setError('');
    try { await request('chooseDirectory'); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  let surface: ReactNode;
  if (state.error) surface = <div className="notes-welcome">
    <img className="welcome-mark" src={libraryIcon} alt="" />
    <h1>知识库暂不可用</h1><p role="alert">{state.error}</p>
    <button className="secondary" type="button" onClick={retry}><RefreshCw size="calc(var(--icon-sm) + 1px)" />重试</button>
  </div>;
  else if (state.loading && !state.data) surface = <div className="notes-welcome" role="status">正在打开知识库…</div>;
  else if (!state.data?.library) surface = <div className="notes-welcome">
    <span className="library-start-mark" aria-hidden="true"><FolderOpen size="calc(var(--icon-lg) + 2px)" strokeWidth={1.55} /></span>
    <h1>选择你的笔记目录</h1>
    <p>在一个地方阅读、编辑和整理已有的 Markdown 与 HTML 笔记。</p>
    <button className="primary" type="button" disabled={busy} onClick={() => void choose()}><FolderOpen size="var(--icon-md)" />选择目录</button>
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </div>;
  else surface = <NotesWorkspace key={state.data.library.id} library={state.data.library} sections={state.data.sections}
    revision={state.data.revision} choosing={busy} choose={choose} rootError={error}
    appearance={appearance} changeAppearance={changeAppearance} scheme={palette.scheme} themeKey={themeKey} />;
  return <div className="knowledge-app" data-knowledge-theme={palette.id} data-theme-custom={palette.isCustom || undefined}
    style={palette.style}>{surface}</div>;
}

function NotesWorkspace({ library, sections, revision, choose, choosing, rootError, appearance, changeAppearance, scheme, themeKey }: {
  library: Library; sections: Section[]; revision: number; choose: () => Promise<void>; choosing: boolean; rootError: string;
  appearance: Appearance; changeAppearance: (patch: Partial<Appearance>) => Promise<void>; scheme: Scheme; themeKey: string;
}) {
  const [tree, setTree] = useState(EMPTY_TREE);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const [searching, setSearching] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [folder, setFolder] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>('read');
  const [nav, setNav] = useState(() => !matchMedia('(max-width: 730px)').matches);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('pi-studio:notes:sidebar-width'));
      if (Number.isFinite(saved) && saved >= SIDEBAR_BOUNDS.minimum && saved <= SIDEBAR_BOUNDS.maximum) return Math.round(saved);
    } catch { /* Ignore storage unavailability in restricted frames. */ }
    return SIDEBAR_BOUNDS.initial;
  });
  function updateSidebarWidth(next: number) {
    setSidebarWidth(next);
    try { localStorage.setItem('pi-studio:notes:sidebar-width', String(next)); } catch { /* Ignore storage unavailability. */ }
  }
  const [outline, setOutline] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [backlinks, setBacklinks] = useState<Entry[]>([]);
  const [anchor, setAnchor] = useState('');
  const [popup, setPopup] = useState<Popup | null>(null);
  const [error, setError] = useState('');
  const [treeError, setTreeError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const deferred = useRef<() => void>();
  const latest = useRef<Draft | null>(null);
  latest.current = draft;
  const dirty = Boolean(draft && draft.text !== draft.note.text);
  const conflict = draft?.external !== undefined;
  const activePath = entry?.path ?? '';
  const format = entry?.kind ?? '';
  const editable = format === 'markdown' || format === 'html';
  const opened = draft?.note.path === activePath ? draft : null;
  const missingSections = sections.some(section => !tree.sections[section.id]);

  useEffect(() => {
    let live = true;
    void request<Tree>('tree', { library: library.id }).then(result => {
      if (live) { setTree(result); setTreeError(''); }
    }).catch(reason => { if (live) setTreeError(message(reason)); });
    return () => { live = false; };
  }, [library.id, refresh, revision]);

  useEffect(() => {
    if (!query.trim()) { setSearch(null); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void request<Search>('search', { query, library: library.id }).then(result => {
        if (live) setSearch(result);
      }).catch(reason => { if (live) { setSearch(null); setError(message(reason)); } })
        .finally(() => { if (live) setSearching(false); });
    }, 210);
    return () => { live = false; window.clearTimeout(timer); };
  }, [library.id, query, revision]);

  useEffect(() => {
    if (!activePath || !editable) return;
    let live = true;
    const args = { path: activePath, library: library.id };
    const stored = latest.current?.note.path === activePath ? Promise.resolve(null)
      : request<StoredDraft | null>('readDraft', args).catch(() => null);
    void Promise.all([request<Note>('read', args), stored]).then(([note, saved]) => {
      if (!live) return;
      setDraft(current => {
        if (!current || current.note.path !== note.path) {
          if (saved && saved.text !== note.text) {
            return { note: { ...note, revision: saved.revision }, text: saved.text,
              ...(saved.revision !== note.revision && { external: note }) };
          }
          return { note, text: note.text };
        }
        if (current.text === current.note.text || current.text === note.text) {
          return { note, text: note.text };
        }
        if (current.note.revision === note.revision) return { ...current, external: undefined };
        return { ...current, external: note };
      });
    }).catch(reason => {
      if (!live) return;
      const detail = message(reason);
      if (detail.includes('已移走')) {
        setDraft(current => current?.note.path === activePath ? { ...current, external: null } : current);
      }
      setError(detail);
    });
    return () => { live = false; };
  }, [activePath, editable, library.id, refresh, revision]);

  const persistDraft = useCallback((current: Draft | null) => {
    if (!current || current.text === current.note.text) return;
    const { note, text } = current;
    void request('writeDraft', { library: library.id, path: note.path, text, revision: note.revision })
      .catch(reason => setError(message(reason)));
  }, [library.id]);

  function clearDraft(path: string) {
    void request('writeDraft', { library: library.id, path, text: null }).catch(() => {});
  }

  useEffect(() => {
    if (!dirty || saving) return;
    const timer = window.setTimeout(() => persistDraft(latest.current), 300);
    return () => window.clearTimeout(timer);
  }, [draft?.note.path, draft?.text, dirty, persistDraft, saving]);

  useEffect(() => {
    if (!outline || !activePath || !editable) return;
    let live = true;
    setBacklinks([]);
    void request<Entry[]>('backlinks', { path: activePath, library: library.id }).then(items => {
      if (live) setBacklinks(items);
    }).catch(() => {});
    return () => { live = false; };
  }, [activePath, editable, library.id, outline, revision]);

  useEffect(() => {
    if (!anchor || !headings.length) return;
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  }, [anchor, headings]);

  function show(next: Popup | null) {
    setDialogError('');
    setPopup(next);
  }

  function guarded(action: () => void) {
    if (dirty) { deferred.current = action; show({ kind: 'leave' }); }
    else action();
  }

  function open(next: Entry, hash = '') {
    if (saving || busy) return;
    if (next.path === activePath) { setAnchor(hash); return; }
    guarded(() => {
      setError('');
      setDraft(null);
      setHeadings([]);
      setAnchor(hash);
      setEntry(next);
      setFolder(next.parent);
      if (matchMedia('(max-width: 730px)').matches) setNav(false);
    });
  }
  const openLink = useCallback((href: string) => {
    if (/^https?:\/\//i.test(href)) {
      void request('openLink', { url: href }).catch(reason => setError(message(reason)));
      return;
    }
    const wiki = href.startsWith('notes-wiki:');
    let link;
    try { link = wiki ? decodeURIComponent(href.slice('notes-wiki:'.length)) : href; } catch { return; }
    const [target, rawHash = ''] = link.split('#', 2);
    let hash;
    try { hash = decodeURIComponent(rawHash); } catch { hash = ''; }
    if (!target) { document.getElementById(hash)?.scrollIntoView({ block: 'start' }); return; }
    const direct = notePath(activePath, target);
    const files = tree.entries.filter(file => file.kind !== 'folder');
    const lookup = (path: string) => files.find(file => file.path === path || label(file.path) === path);
    const resolved = (direct && lookup(direct)) || (wiki && lookup(target));
    if (resolved) { open(resolved, hash); return; }
    const sameName = wiki ? files.filter(file => label(file.name).toLocaleLowerCase() === target.toLocaleLowerCase()) : [];
    if (sameName.length === 1) open(sameName[0], hash);
    else setError(sameName.length ? '有多篇同名笔记，链接可写完整的库内路径。' : '链接指向的文件目前不在知识库里。');
  }, [activePath, busy, dirty, saving, tree.entries]);

  async function save(expected: string | null | undefined = latest.current?.note.revision): Promise<boolean> {
    const current = latest.current;
    if (!current || expected === undefined || saving) return false;
    if (current.text === current.note.text && current.external === undefined) return true;
    setSaving(true);
    setError('');
    try {
      const result = await request<Save>('save', {
        path: current.note.path, text: current.text, revision: expected, library: library.id,
      });
      if (result.status === 'conflict') {
        setDraft(value => value?.note.path === current.note.path ? { ...value, external: result.current } : value);
        return false;
      }
      if (latest.current?.text === current.text) clearDraft(current.note.path);
      setDraft(value => value?.note.path === result.note.path
        ? { note: result.note, text: value.text === current.text ? result.note.text : value.text } : value);
      return true;
    } catch (reason) { setError(message(reason)); return false; }
    finally { setSaving(false); }
  }

  const shortcuts = useRef({ save });
  shortcuts.current = { save };
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.isComposing) return;
      switch (event.key.toLowerCase()) {
        case 'k':
          event.preventDefault();
          setNav(true);
          requestAnimationFrame(() => searchRef.current?.focus());
          break;
        case 's':
          event.preventDefault();
          if (latest.current?.external === undefined) void shortcuts.current.save();
          break;
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  function newEntry(parent?: string) {
    show({ kind: 'create', parent: parent ?? (folder && tree.entries.some(file => file.path === folder)
      ? folder : tree.sections.inbox ?? '') });
  }
  async function mutation<T>(method: string, args: Record<string, unknown>, after?: (result: T) => void) {
    if (busy) return;
    setBusy(true);
    setDialogError('');
    setError('');
    try {
      const result = await request<T>(method, { ...args, library: library.id });
      show(null);
      after?.(result);
    } catch (reason) { popup ? setDialogError(message(reason)) : setError(message(reason)); }
    finally { setBusy(false); }
  }
  function create(name: string, kind: CreateKind, parent: string) {
    void mutation<Save | { path: string }>('create', { name, kind, parent }, result => {
      if ('status' in result && result.status === 'conflict') {
        show({ kind: 'create', parent });
        setDialogError('这个位置已经有同名笔记。');
        return;
      }
      if ('note' in result) {
        const note = result.note;
        guarded(() => {
          setEntry({ path: note.path, parent, name, kind });
          setFolder(parent);
          setDraft({ note, text: note.text });
          setMode('split');
          requestAnimationFrame(() => editRef.current?.focus());
          if (matchMedia('(max-width: 730px)').matches) setNav(false);
        });
      } else setFolder(result.path);
    });
  }
  function move(source: Entry, parent: string, name: string) {
    const containsOpen = activePath === source.path || activePath.startsWith(source.path + '/');
    function run() {
      void mutation<{ path: string }>('move', { path: source.path, parent, name }, result => {
        if (containsOpen && entry) {
          const nextPath = result.path + activePath.slice(source.path.length);
          setDraft(null);
          setEntry({ ...entry, path: nextPath, name: nextPath.split('/').at(-1)!, parent: nextPath.split('/').slice(0, -1).join('/') });
        }
        setFolder(parent);
      });
    }
    if (containsOpen && dirty) guarded(run);
    else run();
  }
  function trash(source: Entry) {
    const containsOpen = activePath === source.path || activePath.startsWith(source.path + '/');
    void mutation('trash', { path: source.path }, () => {
      if (containsOpen) { clearDraft(activePath); setEntry(null); setDraft(null); setHeadings([]); }
      setFolder(source.parent);
    });
  }
  function openFile() {
    if (entry) void request('openFile', { path: entry.path, library: library.id }).catch(reason => setError(message(reason)));
  }

  const saveState = conflict ? 'conflict' : saving ? 'saving' : dirty ? 'dirty' : 'saved';
  const saveLabel = { conflict: '外部已修改', saving: '正在保存…', dirty: '有未保存的修改', saved: '已保存' }[saveState];
  function applyAppearance(patch: Partial<Appearance>) {
    void changeAppearance(patch).catch(reason => setError(message(reason)));
  }
  const hasNotes = tree.entries.some(item => item.kind === 'markdown' || item.kind === 'html');
  const close = () => { if (!busy && !saving) show(null); };

  return <main className="notes-shell" data-nav={nav} data-outline={outline && editable}
    style={{ '--tree-width': sidebarWidth + 'px' } as React.CSSProperties}>
    {nav && <>
      <button className="notes-nav-scrim" aria-label="关闭目录" type="button" onClick={() => setNav(false)} />
      <NotesTree tree={tree} sections={sections} selected={activePath} folder={folder}
        searchRef={searchRef} query={query} search={search} searching={searching} onQuery={setQuery}
        onOpen={open} onFolder={setFolder} onManage={target => show({ kind: 'manage', entry: target })}
        onNew={newEntry} onSettings={() => show({ kind: 'settings' })}
        onDrop={(source, target) => { if (source.parent !== target) move(source, target, source.name); }}
        welcome={missingSections && !treeError} width={sidebarWidth} onResize={updateSidebarWidth} />
    </>}
    <section className="notes-content" aria-label="笔记阅读与编辑">
      <header className="notes-toolbar">
        <div className="breadcrumb">
          <IconButton label={nav ? '收起目录' : '展开目录'} aria-pressed={nav} onClick={() => setNav(!nav)}><PanelLeft size="calc(var(--icon-md) + 1px)" /></IconButton>
          <Breadcrumb path={activePath} />
        </div>
        <div className="toolbar-actions">
          {opened && <div className="toolbar-group toolbar-save-group">
            <SaveStatus state={saveState} label={saveLabel} />
            {dirty && <IconButton className="save-button" label="保存" disabled={conflict || saving}
              onClick={() => void save()}><SaveIcon size="var(--icon-md)" /></IconButton>}
          </div>}
          {opened && <span className="toolbar-divider" aria-hidden="true" />}
          {opened && <div className="modes" role="group" aria-label="阅读和编辑模式">
            {MODES.map(({ key, text, icon: Icon }) => <IconButton key={key} label={text} aria-pressed={mode === key}
              onClick={() => setMode(key)}><Icon size="var(--icon-md)" /></IconButton>)}
          </div>}
          {opened && <span className="toolbar-divider" aria-hidden="true" />}
          <div className="toolbar-group">
            <ThemeMenu selected={appearance.theme} onChange={theme => applyAppearance({ theme })} />
            {editable && <IconButton label="大纲与反向链接" aria-pressed={outline} onClick={() => setOutline(!outline)}><ListTree size="calc(var(--icon-md) + 1px)" /></IconButton>}
          </div>
        </div>
      </header>
      {(error || treeError) && <div className="error-strip" role="alert"><span>{error || treeError}</span>
        {treeError && <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button>}
        <IconButton label="关闭提示" onClick={() => { setError(''); setTreeError(''); }}><X size="var(--icon-sm)" /></IconButton>
      </div>}
      {conflict && opened && <div className="conflict-strip" role="alert">
        <span>{opened.external ? '磁盘上的版本已修改，草稿已保留。' : '磁盘上的文件已移走，草稿已保留。'}</span>
        <button type="button" onClick={() => {
          clearDraft(activePath);
          if (opened.external) setDraft({ note: opened.external, text: opened.external.text });
          else { setEntry(null); setDraft(null); }
          setError('');
        }}>用外部版本</button>
        <button type="button" disabled={saving} onClick={() => void save(opened.external?.revision ?? null)}>保留我的</button>
        <button type="button" onClick={() => show({ kind: 'compare' })}>查看差异</button>
      </div>}
      {opened?.note.format === 'html' && mode !== 'source' && <div className="html-toolbar">
        <span>HTML · 静态预览</span>
        <button type="button" onClick={openFile}><ExternalLink size="calc(var(--icon-xs) + 1px)" />用浏览器打开</button>
      </div>}
      <div className="notes-body">
        <div className="notes-document" data-mode={opened ? mode : 'read'}>
          {opened ? <>
            {mode !== 'read' && <div className="note-editor">
              <textarea ref={editRef} aria-label="笔记源码" spellCheck={false} value={opened.text}
                readOnly={saving} onBlur={() => { if (!saving) persistDraft(latest.current); }}
                onChange={event => {
                  const value = event.target.value;
                  setDraft(current => current && { ...current, text: current.note.text.includes('\r\n')
                    ? value.replace(/\r?\n/g, '\r\n') : value });
                }} />
              <footer>{opened.note.format === 'html' ? 'HTML' : 'Markdown'}<span>{opened.text.split('\n').length} 行</span></footer>
            </div>}
            {mode !== 'source' && <div className="note-reading">
              {opened.note.format === 'html'
                ? <HtmlReader key={activePath} text={opened.text} from={activePath} library={library.id} scheme={scheme} themeKey={themeKey} />
                : <MarkdownReader key={activePath} text={opened.text} from={activePath} library={library.id} scheme={scheme}
                  onLink={openLink} onHeadings={setHeadings} />}
            </div>}
          </> : entry && !editable ? <AttachmentReader entry={entry} library={library.id} open={openFile} />
            : entry ? <div className="note-rendering" role="status">{error ? '无法打开此笔记' : '正在读取笔记…'}</div>
              : <div className="library-start">
                <h2>{hasNotes ? '选择一篇笔记开始阅读' : '从第一篇笔记开始'}</h2>
                <p>{hasNotes ? '在左侧目录浏览，或直接新建与检索本地笔记' : '支持 Markdown 与 HTML，按 PARA 结构整理知识'}</p>
              </div>}
        </div>
        {outline && editable && <ResizableOutline width={appearance.outlineWidth} onResize={outlineWidth => applyAppearance({ outlineWidth })}>
          <header className="notes-pane-title">
            <ListTree size="var(--icon-md)" aria-hidden="true" />
            <h2>大纲与引用</h2>
            <IconButton label="收起大纲" onClick={() => setOutline(false)}><X size="calc(var(--icon-sm) + 1px)" /></IconButton>
          </header>
          <div className="outline-content">
            <div className="outline-section-label">大纲</div>
            <nav aria-label="大纲">{headings.length ? headings.map(heading => <button className="pane-row outline-row" type="button"
              key={heading.id} title={heading.text} data-level={heading.level} data-current={anchor === heading.id || undefined}
              aria-current={anchor === heading.id ? 'location' : undefined}
              style={{ paddingInlineStart: (heading.level - 1) * 10 + 10 }}
              onClick={() => {
                if (mode === 'source') setMode('split');
                setAnchor(heading.id);
                requestAnimationFrame(() => document.getElementById(heading.id)?.scrollIntoView({ block: 'start' }));
              }}><span>{heading.text}</span></button>) : <p className="outline-empty">此笔记暂无标题小节</p>}</nav>
            <div className="outline-section-label">反向链接</div>
            <nav aria-label="反向链接">{backlinks.length ? backlinks.map(item =>
              <button className="pane-row outline-row" type="button" key={item.path} title={item.path} onClick={() => open(item)}>
                <FileText size="var(--icon-sm)" aria-hidden="true" />
                <span>{label(item.name)}</span>
              </button>)
              : <p className="outline-empty">暂无其他笔记引用</p>}</nav>
          </div>
          {activePath && editable && <footer className="outline-footer">
            <button type="button" className="secondary ask-button" onClick={() => askAboutNote(activePath)}>带入临时聊天</button>
          </footer>}
        </ResizableOutline>}
      </div>
    </section>
    {popup?.kind === 'settings' && <Modal title="知识库设置" onClose={close}>
      <div className="dialog-content settings-actions">
        <small><FolderOpen size="calc(var(--icon-sm) + 1px)" />当前目录　{library.name}</small>
        <button className="secondary" type="button" disabled={busy} onClick={() => void mutation('initialize', {})}>补齐 PARA 目录和规范</button>
        <button className="secondary" type="button" disabled={choosing} onClick={() => guarded(() => { void choose(); })}>选择其他目录</button>
        <p className="quiet">补齐时沿用已有分类名，并保留现有笔记和规范。</p>
        {(dialogError || rootError) && <p className="dialog-error" role="alert">{dialogError || rootError}</p>}
      </div>
    </Modal>}
    {popup?.kind === 'create' && <NewEntry parent={popup.parent} busy={busy} error={dialogError} onClose={close}
      onCreate={(name, kind) => create(name, kind, popup.parent)} />}
    {popup?.kind === 'manage' && <ManageEntry entry={popup.entry} onClose={close}
      onAction={action => action === 'new' ? newEntry(popup.entry.path) : show({ kind: action, entry: popup.entry })} />}
    {(popup?.kind === 'rename' || popup?.kind === 'move') && <MoveEntry entry={popup.entry} rename={popup.kind === 'rename'}
      folders={tree.entries.filter(item => item.kind === 'folder')} busy={busy} error={dialogError} onClose={close}
      onMove={(parent, name) => move(popup.entry, parent, name)} />}
    {popup?.kind === 'trash' && <Modal title="移到废纸篓" onClose={close}>
      <div className="dialog-content"><p>将「{popup.entry.name}」移到系统废纸篓？</p>
        {dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
      </div>
      <footer><button className="secondary" type="button" onClick={close}>取消</button>
        <button className="danger" type="button" disabled={busy} onClick={() => trash(popup.entry)}>移到废纸篓</button></footer>
    </Modal>}
    {popup?.kind === 'leave' && <Modal title="有未保存的编辑" onClose={close}>
      <div className="dialog-content"><p>离开前保存当前笔记的修改吗？</p>
        {conflict && <small className="quiet">磁盘版本有变化，可返回编辑器处理冲突。</small>}
      </div>
      <footer><button className="secondary" type="button" onClick={close}>取消</button>
        <button className="secondary" type="button" disabled={saving} onClick={() => {
          if (latest.current) clearDraft(latest.current.note.path);
          setDraft(current => current && { note: current.external ?? current.note, text: (current.external ?? current.note).text });
          show(null);
          deferred.current?.();
        }}>放弃草稿</button>
        <button className="primary" type="button" disabled={saving || conflict} onClick={() => {
          void save().then(success => { if (success) { show(null); deferred.current?.(); } });
        }}>保存并继续</button></footer>
    </Modal>}
    {popup?.kind === 'compare' && opened && <Modal title="查看差异" onClose={close} wide>
      <div className="dialog-content compare"><div><h3>磁盘版本</h3><pre>{opened.external?.text ?? '文件已移走'}</pre></div>
        <div><h3>本地草稿</h3><pre>{opened.text}</pre></div></div>
    </Modal>}
  </main>;
}
