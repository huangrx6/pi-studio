import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsUpDown, Columns2, FileCode2, FileSearch, Files, LoaderCircle, MoreHorizontal, RefreshCw, SquareArrowOutUpRight, WrapText } from 'lucide-react';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import { DiffView, type DiffOptions } from './DiffView';
import { ActionMenu, type MenuAction } from './ActionMenu';
import { Markdown } from './Markdown';
import { Select } from './Select';
import { splitPatch } from '../lib/diff-rows';

type Props = { sessionId: string; initial: TurnDiff; turns: TurnDiff[]; focusPath?: string; onOpenFile: (path: string) => void; onOpenDiff: (file: TurnDiffFile, at: number) => void };
export function ChangesView({ sessionId, initial, turns, focusPath, onOpenFile, onOpenDiff }: Props) {
  const [history, setHistory] = useState(turns);
  const [selectedAt, setSelectedAt] = useState(initial.at);
  const turn = history.find(item => item.at === selectedAt) ?? initial;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusPath ? [focusPath] : []));
  const [options, setOptions] = useState<DiffOptions>({ layout: 'auto', wrap: false, wordDiff: true, hideImports: false });
  const [full, setFull] = useState(false), [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [preview, setPreview] = useState(false), [showFiles, setShowFiles] = useState(false), [jump, setJump] = useState(false), [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<Record<string, TurnDiffFile>>({});
  const [loading, setLoading] = useState(false), [refreshing, setRefreshing] = useState(false), [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuAction[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const list = useRef<HTMLDivElement>(null);
  const jumpHost = useRef<HTMLDivElement>(null);
  const reveal = useCallback((path: string) => {
    setExpanded(current => new Set([...current, path])); setJump(false); setQuery('');
    requestAnimationFrame(() => [...(list.current?.querySelectorAll<HTMLElement>('[data-diff-path]') ?? [])].find(node => node.dataset.diffPath === path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, []);
  useEffect(() => { setHistory(turns); }, [turns]);
  useEffect(() => { setSelectedAt(initial.at); setExpanded(new Set(focusPath ? [focusPath] : [])); if (focusPath) reveal(focusPath); }, [initial.at, focusPath, reveal]);
  useEffect(() => {
    if (!jump) return;
    const outside = (event: PointerEvent) => { if (!jumpHost.current?.contains(event.target as Node)) setJump(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [jump]);
  // Only read the selected immutable snapshot; late responses cannot replace another round.
  useEffect(() => {
    let cancelled = false; setLoaded({}); setError(''); setLoading(false);
    if (!(full || ignoreWhitespace) || !turn.snapshot) return;
    const paths = turn.files.filter(file => expanded.has(file.path));
    if (!paths.length) return;
    setLoading(true);
    Promise.allSettled(paths.map(async file => [file.path, await window.piApi.turnDiffFile({ sessionId, at: turn.at, path: file.path, full, ignoreWhitespace })] as const))
      .then(items => { if (cancelled) return; const files: Record<string, TurnDiffFile> = {}; const failures: string[] = []; for (const item of items) { if (item.status === 'fulfilled') files[item.value[0]] = item.value[1]; else failures.push(String(item.reason)); } setLoaded(files); if (failures.length) setError(failures[0]); })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, turn, full, ignoreWhitespace, expanded, revision]);
  const totals = { added: turn.totalAdded ?? turn.files.reduce((n,f) => n+f.added,0), removed: turn.totalRemoved ?? turn.files.reduce((n,f) => n+f.removed,0) };
  const ordered = useMemo(() => [...history].sort((a,b) => b.at-a.at), [history]);
  const roundOptions = useMemo(() => ordered.map((item, index) => ({
    value: String(item.at),
    label: `${index === 0 ? '上一轮' : `前 ${index + 1} 轮`} · ${new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  })), [ordered]);
  const allOpen = turn.files.every(file => expanded.has(file.path));
  const toggle = (path: string) => setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const menuAt = (event: React.MouseEvent<HTMLButtonElement>, items: MenuAction[]) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right-220, y: box.bottom+6, items }); };
  const safe = (job: Promise<unknown>) => { void job.catch(err => setError(String(err))); };
  const diffFileRequest = (file: TurnDiffFile) => ({
    path: file.path,
    source: 'diff' as const,
    sessionId,
  });
  const chooseEditor = async (file: TurnDiffFile, x: number, y: number) => {
    try {
      const { apps } = await window.piApi.fileActions(diffFileRequest(file));
      const editors = apps.filter(app => /code|cursor|zed|sublime|textedit|idea|webstorm|bbedit|nova|vim|emacs/i.test(app.name));
      if (!editors.length) { setError('没有找到可用的编辑器，可以使用“在默认应用中打开”。'); return; }
      setMenu({ x, y, items: editors.map(app => ({ label: app.name, run: () => safe(window.piApi.openWith({ ...diffFileRequest(file), appPath: app.path })) })) });
    } catch (err) { setError(String(err)); }
  };
  const refresh = async () => {
    setRefreshing(true); setError('');
    try {
      const detail = await window.piApi.conversationPage({ id: sessionId, limit: 1 });
      if (!detail) throw new Error('会话记录暂时不可用，请重试');
      setHistory(detail.turnDiffs.length ? detail.turnDiffs : [initial]);
      setRevision(value => value + 1);
    }
    catch (err) { setError(String(err)); } finally { setRefreshing(false); }
  };
  const chooseSnapshotFeature = (apply: () => void) => { if (!turn.snapshot) { setError('这条历史记录未保存完整快照，只能查看已保存的差异。新产生的 Git 变更支持完整文件和忽略空白字符。'); return; } apply(); };
  return <section className="changes-view" aria-label="轮次变更">
    <div className="changes-toolbar">
      <div className="changes-round"><Select className="changes-round-select" label="选择变更轮次" value={String(turn.at)} options={roundOptions} onChange={value => { setSelectedAt(Number(value)); setExpanded(new Set()); setPreview(false); setFull(false); setIgnoreWhitespace(false); }} /><span className="diff-view-counts"><span>+{totals.added}</span><span>−{totals.removed}</span></span></div>
      <div className="changes-tools">
        <button className="icon-button" title="差异选项" aria-label="差异选项" onClick={event => menuAt(event, [
          { label: '加载完整文件', checked: full, run: () => chooseSnapshotFeature(() => setFull(!full)) },
          { label: '渲染 Markdown 预览', checked: preview, disabled: !turn.files.some(file => /\.md$/i.test(file.label)), run: () => chooseSnapshotFeature(() => { setPreview(!preview); if (!preview) setFull(true); }) },
          { label: '词级差异', checked: options.wordDiff, run: () => setOptions({ ...options, wordDiff: !options.wordDiff }) },
          { label: '忽略空白字符差异', checked: ignoreWhitespace, run: () => chooseSnapshotFeature(() => setIgnoreWhitespace(!ignoreWhitespace)) },
          { label: '隐藏单行导入内容', checked: options.hideImports, run: () => setOptions({ ...options, hideImports: !options.hideImports }) },
          { label: '复制本轮补丁', run: () => safe(navigator.clipboard.writeText(turn.files.map(file => file.patch || '').join('\n'))) },
        ])}><MoreHorizontal /></button>
        <div ref={jumpHost} className="changes-jump-host"><button className="icon-button" title="跳转到文件" aria-label="跳转到文件" aria-expanded={jump} onClick={() => setJump(!jump)}><FileSearch /></button>
          {jump && <div className="changes-jump popover-surface" onKeyDown={event => { if (event.key === 'Escape') setJump(false); }}><input autoFocus placeholder="搜索本轮文件…" aria-label="搜索本轮文件" value={query} onChange={event => setQuery(event.target.value)} /><div>{turn.files.filter(file => file.label.toLowerCase().includes(query.toLowerCase())).map(file => <button key={file.path} onClick={() => reveal(file.path)}>{file.label}</button>)}</div></div>}
        </div>
        <button className="icon-button" title="刷新" aria-label="刷新变更" disabled={refreshing || loading} onClick={() => void refresh()}><RefreshCw className={refreshing ? 'spin' : ''} /></button>
        <button className="icon-button" title="自动换行" aria-label="自动换行" aria-pressed={options.wrap} onClick={() => setOptions({ ...options, wrap: !options.wrap })}><WrapText /></button>
        <button className="icon-button" title={allOpen ? '折叠全部差异' : '展开全部差异'} aria-label={allOpen ? '折叠全部差异' : '展开全部差异'} onClick={() => setExpanded(allOpen ? new Set() : new Set(turn.files.map(file => file.path)))}><ChevronsUpDown /></button>
        <button className="icon-button" title={`差异布局：${{auto:'自动',split:'左右对照',unified:'单列'}[options.layout]}`} aria-label="差异布局" onClick={event => menuAt(event, (['auto','split','unified'] as const).map(layout => ({ label: {auto:'自动布局',split:'左右对照',unified:'单列差异'}[layout], checked: options.layout === layout, run: () => setOptions({ ...options, layout }) })))}><Columns2 /></button>
        <button className="icon-button" title="显示文件" aria-label="显示变更文件列表" aria-pressed={showFiles} onClick={() => setShowFiles(!showFiles)}><Files /></button>
      </div>
    </div>
    {error && <div className="changes-notice" role="alert">{error}<button className="text-button" onClick={() => setError('')}>关闭</button></div>}
    {loading && <div className="changes-loading" role="status"><LoaderCircle className="spin" />正在读取该轮快照…</div>}
    <div className="changes-workspace">
      {showFiles && <nav className="changes-file-list" aria-label="变更文件列表">{turn.files.map(file => <button title={file.label} key={file.path} onClick={() => reveal(file.path)}><FileCode2 /><span>{file.label}</span></button>)}</nav>}
      <div className="changes-scroll" ref={list}>
        {turn.files.map(original => { const file = loaded[original.path] ?? original, open = expanded.has(file.path); return <article className="changes-file" key={file.path} data-diff-path={file.path}>
          <header className="changes-file-head">
            <button className="changes-file-toggle" aria-expanded={open} onClick={() => toggle(file.path)} title={file.path}>{open ? <ChevronDown /> : <ChevronRight />}<FileCode2 /><span><small>{file.label.includes('/') ? file.label.slice(0,file.label.lastIndexOf('/')+1) : ''}</small>{file.label.split('/').pop()}</span></button>
            <span className="diff-view-counts"><span>+{file.added}</span><span>−{file.removed}</span></span>
            <button className="icon-button" title="在新标签页打开差异" aria-label={`在新标签页打开 ${file.label}`} onClick={() => onOpenDiff(file, turn.at)}><SquareArrowOutUpRight /></button>
            <button className="icon-button" title="文件操作" aria-label={`${file.label} 文件操作`} onClick={event => menuAt(event, [
              { label: '复制路径', run: () => safe(navigator.clipboard.writeText(file.path)) },
              { label: '打开当前文件', disabled: file.status === 'deleted', run: () => onOpenFile(file.path) },
              { label: '在编辑器中打开', disabled: file.status === 'deleted', run: () => void chooseEditor(file, event.clientX-220, event.clientY) },
              { label: '在默认应用中打开', disabled: file.status === 'deleted', run: () => safe(window.piApi.openWith(diffFileRequest(file))) },
              { label: '在 Finder 中显示', disabled: file.status === 'deleted', run: () => safe(window.piApi.revealFile(diffFileRequest(file))) },
              { label: open ? '折叠文件' : '展开文件', run: () => toggle(file.path) },
              { label: '复制文件补丁', run: () => safe(navigator.clipboard.writeText(file.patch || '')) },
            ])}><MoreHorizontal /></button>
          </header>
          {open && (preview && /\.md$/i.test(file.label) && loaded[file.path] && !file.truncated ? <div className="changes-markdown"><Markdown>{splitPatch(file.patch || '').filter(row => row.right).map(row => row.right!.text).join('\n')}</Markdown></div> : <DiffView file={file} options={options} embedded />)}
        </article>; })}
        {!turn.files.length && <div className="diff-empty">本轮没有文件变更</div>}
        {turn.truncated && <p className="diff-note">本轮文件过多，列表仅包含已保存的部分文件。</p>}
      </div>
    </div>
    {menu && <ActionMenu {...menu} onClose={closeMenu} />}
  </section>;
}
