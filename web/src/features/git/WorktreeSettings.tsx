import { useGitRepositories } from './useWorkspaceRepositories';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FolderOpen, GitBranch, Plus, Trash2 } from 'lucide-react';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import type { GitWorkspaceStatus, GitWorktree, WorktreeResults, WorktreeReview } from '../../types/git-types';

function CopyPath({ path }: { path: string }) {
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(''), 2000);
    return () => window.clearTimeout(timer);
  }, [result]);
  return <span className="git-settings-copy">
    <span role="status">{result}</span>
    <button type="button" className="icon-button" aria-label={'复制路径 ' + path} title="复制路径" onClick={async () => {
      try { await navigator.clipboard.writeText(path); setResult('已复制'); }
      catch { setResult('复制失败'); }
    }}>{result === '已复制' ? <Check /> : <Copy />}</button>
  </span>;
}

function CreateTreeDialog({ cwd, mainPath, close, created }: {
  cwd: string; mainPath: string; close: () => void; created: (path: string, open: boolean) => void;
}) {
  const repository = useGitRepositories().selected!.id;
  const [refs, setRefs] = useState<WorktreeResults['options']>();
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [existing, setExisting] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string>();
  const [destination, setDestination] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    window.piApi.gitWorktree(cwd, { repository, kind: 'options' }).then(data => {
      if (!active) return;
      setRefs(data);
      setExisting(data.branches.find(branch => !branch.occupied)?.name || '');
    }, e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [cwd, repository]);
  const branch = mode === 'new' ? name.trim() : existing;
  const split = Math.max(mainPath.lastIndexOf('/'), mainPath.lastIndexOf('\\'));
  const parent = destination ? destination.replace(/[\\/]+$/, '') + mainPath[split] : mainPath.slice(0, split + 1);
  const suggested = branch ? mainPath.slice(split + 1) + '-' + branch.replace(/[\\/]/g, '-') : '';
  const directory = folder ?? suggested;
  async function create() {
    if (!refs || busy) return;
    setBusy(true); setError(null);
    try {
      const target = await window.piApi.gitWorktree(cwd, { repository, kind: 'create', mode, name: branch, folder: directory.trim(), parent: destination || undefined, head: refs.head });
      created(target, open);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <SettingsDialog title="创建工作树" action="创建工作树" busyAction="正在创建…" busy={busy}
    loading={!refs && !error} error={error} unavailable={!refs || !branch || !directory.trim() || (mode === 'new' && !refs.head)}
    onClose={close} onSubmit={() => void create()} showBackdrop={false}>
    <div className="git-tree-fields">
      <div className="general-theme-options" role="group" aria-label="分支来源">
        <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>新建分支</button>
        <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>已有分支</button>
      </div>
      {mode === 'new' ? <label>新分支名称<input value={name} placeholder="feature/review" onChange={e => setName(e.target.value)} />
        <small>{refs?.head ? '起点为 ' + (refs.branch || '游离 HEAD') + ' · ' + refs.head.slice(0, 8) : '请先在当前仓库创建首次提交。'}</small></label>
        : <div><span>本地分支</span><Select label="本地分支" value={existing} onChange={setExisting}
          placeholder="没有可用的本地分支" options={(refs?.branches || []).map(b => ({
            value: b.name, label: b.name, disabled: b.occupied, description: b.occupied ? '已被工作树占用' : undefined,
          }))} /></div>}
      <label>文件夹名称<input value={directory} placeholder="输入文件夹名称" onChange={e => setFolder(e.target.value)} />
        <small title={parent + directory}>{parent + directory}</small></label>
      <button type="button" className="settings-outline" disabled={busy} onClick={async () => {
        try { const selected = await window.piApi.pickWorktreeParent(); if (selected) setDestination(selected); }
        catch (e) { setError(errorText(e)); }
      }}>更改存放位置</button>
      <label className="git-tree-check"><input type="checkbox" checked={open} onChange={e => setOpen(e.target.checked)} />创建后打开工作区</label>
    </div>
  </SettingsDialog>;
}

function RemoveTreeDialog({ cwd, activeCwd, tree, close, removed }: {
  cwd: string; activeCwd: string; tree: GitWorktree; close: () => void; removed: () => void;
}) {
  const repository = useGitRepositories().selected!.id;
  const [review, setReview] = useState<WorktreeReview>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState(0);
  useEffect(() => {
    let active = true;
    window.piApi.gitWorktree(cwd, { repository, kind: 'inspect', path: tree.path, activeCwd }).then(
      result => { if (active) setReview(result); }, e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [cwd, repository, activeCwd, tree.path, read]);
  async function remove() {
    if (!review || busy) return;
    setBusy(true);
    try {
      await window.piApi.gitWorktree(cwd, { repository, kind: 'remove', path: tree.path, activeCwd, version: review.version });
      removed();
    } catch (e) { setError(errorText(e)); setReview(undefined); setBusy(false); }
  }
  return <SettingsDialog title="移除工作树？" action={review?.missing ? '解除关联' : '移入回收站'} busyAction="正在移除…"
    busy={busy} loading={!review && !error} unavailable={!review} error={error} onClose={close} onSubmit={() => void remove()}>
    <div className="git-tree-fields">
      <div><strong>{tree.branch || '游离 HEAD'}</strong><small>{tree.path}</small></div>
      {review && <>
        {review.dirty.total > 0 && <p className="git-tree-warning" role="alert">有 {review.dirty.total} 个文件含未提交的修改：已暂存 {review.dirty.staged}，未暂存 {review.dirty.unstaged}，未跟踪 {review.dirty.untracked}。</p>}
        {review.dirty.staged > 0 && <p>回收站保留磁盘上的文件。若要保留暂存区里的版本，请先提交。</p>}
        {review.ignored && <p>此目录还包含 Git 忽略的本地文件，将一并移入回收站。</p>}
        <p>{review.missing ? '目录已不存在，将清除此工作树的 Git 关联和暂存区。' : '整个目录将移入系统回收站，并解除 Git 工作树关联。'}
          {tree.branch ? '本地分支及提交会保留。' : '若要保留游离提交 ' + review.head.slice(0, 8) + '，请先为它创建分支。'}</p>
      </>}
      {error && !review && <button type="button" className="settings-outline" onClick={() => { setError(null); setRead(n => n + 1); }}>重新检查</button>}
    </div>
  </SettingsDialog>;
}

export function WorktreeSettings({ cwd, activeCwd, status, onOpen, onChange }: {
  cwd: string; activeCwd: string; status: GitWorkspaceStatus; onOpen: (target: string) => Promise<void>; onChange: () => void;
}) {
  const repository = useGitRepositories().selected!.id;
  const [create, setCreate] = useState(false);
  const [remove, setRemove] = useState<GitWorktree>();
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function open(target: string) {
    setOpening(target); setError('');
    try {
      const path = await window.piApi.gitWorktree(cwd, { repository, kind: 'open', path: target });
      if (mounted.current) await onOpen(path);
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { if (mounted.current) setOpening(''); }
  }
  function changed(note: string) {
    setCreate(false); setRemove(undefined); setError(''); setMessage(note);
    onChange(); window.dispatchEvent(new Event('pi-studio:git-changed'));
  }
  const mainPath = status.worktree.mainPath;
  return <section className="git-settings-trees" aria-label="工作树">
    <header className="git-tree-heading"><h3>工作树 <small>{status.worktrees.length}</small></h3>
      <button className="settings-outline" type="button" disabled={!mainPath || !status.worktrees.length || !!opening}
        onClick={() => { setMessage(''); setCreate(true); }}><Plus />创建工作树</button></header>
    <ul>{status.worktrees.map(tree => {
      const current = tree.path === status.worktree.path;
      const main = tree.path === mainPath;
      const active = activeCwd === tree.path || activeCwd.startsWith(tree.path + '/') || activeCwd.startsWith(tree.path + '\\');
      return <li key={tree.path} className="git-worktree-row">
        <GitBranch aria-hidden="true" />
        <div className="git-settings-tree-copy">
          <div><strong>{tree.branch || '游离 HEAD'}</strong>{main && <span>主工作树</span>}
            {current && <span className="git-tree-current">当前</span>}{tree.locked && <span>已锁定</span>}</div>
          <small title={tree.path}><bdi dir="ltr">{tree.path}</bdi></small>
        </div>
        <div className="git-tree-actions">
          <button type="button" className="icon-button" title="打开工作区" aria-label={'打开工作区 ' + tree.path}
            disabled={!!opening} onClick={() => void open(tree.path)}><FolderOpen /></button>
          <CopyPath path={tree.path} />
          {!main && <button type="button" className="icon-button" aria-label={'移除工作树 ' + tree.path}
            title={current || active ? '请先切换工作区' : tree.locked ? '工作树已锁定' : '移除工作树'}
            disabled={current || active || tree.locked || !!opening} onClick={() => { setMessage(''); setRemove(tree); }}><Trash2 /></button>}
        </div>
      </li>;
    })}</ul>
    {!status.worktrees.length && <p className="git-settings-message">未能读取工作树列表。</p>}
    {message && <p className="git-tree-note" role="status">{message}</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {create && mainPath && <CreateTreeDialog cwd={cwd} mainPath={mainPath} close={() => { setCreate(false); onChange(); }}
      created={(target, enter) => { changed('已创建工作树'); if (enter) void open(target); }} />}
    {remove && <RemoveTreeDialog cwd={cwd} activeCwd={activeCwd} tree={remove} close={() => setRemove(undefined)} removed={() => changed('已移除工作树')} />}
  </section>;
}
