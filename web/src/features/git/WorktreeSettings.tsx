import { useGitRepositories } from './useWorkspaceRepositories';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
import { PreferenceGroup } from '../../shared/PreferenceGroup';
import { GitDirectory, GitSettingsList } from './GitSettingsList';
import { gitChangedEvent } from './useGitTools';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ModalDismiss } from '../../shared/useModalDialog';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import type { GitWorkspaceStatus, GitWorktree, WorktreeResults, WorktreeReview } from '../../types/git-types';

function CreateTreeDialog({ cwd, mainPath, close, created }: {
  cwd: string; mainPath: string; close: () => void; created: (path: string, open: boolean) => void;
}) {
  const showToast = useSettingsToast();
  const repository = useGitRepositories().selected!.id;
  const [refs, setRefs] = useState<WorktreeResults['options']>();
  const initialized = useRef(false);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [base, setBase] = useState('');
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
      if (!initialized.current) {
        initialized.current = true;
        setBase(data.head ? data.branch : data.branches[0]?.name || '');
        setExisting(data.branches.find(branch => !branch.occupied)?.name || '');
      }
    }, e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [cwd, repository, revision]);
  const branches = refs?.branches || [];
  const start = base ? branches.find(item => item.name === base)?.head : (refs?.branch ? '' : refs?.head);
  const branch = mode === 'new' ? name.trim() : existing;
  const duplicate = mode === 'new' && !!branch && branches.some(item => item.name === branch);
  const eligible = mode === 'new' ? !!start && !duplicate : branches.some(item => item.name === branch && !item.occupied);
  const split = Math.max(mainPath.lastIndexOf('/'), mainPath.lastIndexOf('\\'));
  const parent = destination ? destination.replace(/[\\/]+$/, '') + mainPath[split] : mainPath.slice(0, split + 1);
  const suggested = branch ? mainPath.slice(split + 1) + '-' + branch.replace(/[\\/]/g, '-') : '';
  const directory = folder ?? suggested;
  function reloadBranches() {
    setError(null); setRefs(undefined); setRevision(n => n + 1);
  }
  async function create(dismiss: ModalDismiss) {
    if (!refs || !eligible || busy) return;
    setBusy(true); setError(null);
    try {
      const target = await window.piApi.gitWorktree(cwd, { repository, kind: 'create', mode, name: branch, folder: directory.trim(),
        parent: destination || undefined, baseBranch: mode === 'new' && base ? base : undefined, head: start || refs.head });
      await dismiss(() => created(target, open));
    } catch (e) { showToast(errorText(e), 'error'); setBusy(false); }
  }
  return <SettingsDialog title="创建工作树" description="在独立目录检出分支，当前工作区可以继续使用。"
    action="创建工作树" busyAction="正在创建…" busy={busy} loading={!refs && !error} error={error}
    unavailable={!refs || !branch || !eligible || !directory.trim()} onClose={close} onSubmit={dismiss => void create(dismiss)}>
    {refs && <div className="git-tree-form">
      <section className="git-tree-form-section" aria-label="分支">
        <div className="git-tree-form-head"><h3>分支</h3><div className="settings-segments" role="group" aria-label="分支来源">
          <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>新建分支</button>
          <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>已有分支</button>
        </div></div>
        {mode === 'new' ? <div className="git-tree-branch-fields">
          <label className="git-tree-field">新分支名称<input value={name} placeholder="feature/review" onChange={e => setName(e.target.value)}
            aria-invalid={duplicate || undefined} />{duplicate && <small>同名分支已存在。</small>}</label>
          <div className="git-tree-field"><span>起点分支{start && <code className="git-base-commit" title={start}>{start.slice(0, 8)}</code>}</span>
            <Select label="起点分支" value={base} onChange={setBase} placeholder="请选择起点" options={[
              ...(!refs.branch && refs.head ? [{ value: '', label: '当前提交（游离 HEAD）', description: refs.head.slice(0, 8) }] : []),
              ...branches.map(item => ({ value: item.name, label: item.name, description: (item.name === refs.branch ? '当前分支 · ' : '') + item.head.slice(0, 8) })),
            ]} />
          </div>
          {!start && <small className="git-tree-help">{branches.length ? '请选择有效的起点分支。' : '请先在仓库中创建首次提交。'}</small>}
        </div> : <div className="git-tree-field"><span>本地分支</span>
          <Select label="本地分支" value={existing} onChange={setExisting} placeholder="没有可用的本地分支"
            options={branches.map(item => ({ value: item.name, label: item.name, disabled: item.occupied, description: item.occupied ? '已被工作树占用' : undefined }))} />
          {!branches.some(item => !item.occupied) && <small>没有空闲的本地分支，可以选择「新建分支」。</small>}
        </div>}
      </section>
      <section className="git-tree-form-section" aria-label="存放位置">
        <div className="git-tree-form-head"><h3>存放位置</h3>
          <button type="button" className="settings-outline" onClick={async () => {
            try { const selected = await window.piApi.pickWorktreeParent(); if (selected) setDestination(selected); }
            catch (e) { showToast(errorText(e), 'error'); }
          }}>更改存放位置</button>
        </div>
        <label className="git-tree-field">文件夹名称<input value={directory} placeholder="输入文件夹名称" onChange={e => setFolder(e.target.value)} />
          <small title={parent + directory}><bdi dir="ltr">{parent + directory}</bdi></small></label>
      </section>
      <label className="git-tree-check"><input type="checkbox" checked={open} onChange={e => setOpen(e.target.checked)} />创建后打开工作区</label>
    </div>}
    {error && <button type="button" className="settings-outline git-tree-retry" onClick={reloadBranches}>刷新分支</button>}
  </SettingsDialog>;
}

function RemoveTreeDialog({ cwd, activeCwd, tree, close, removed }: {
  cwd: string; activeCwd: string; tree: GitWorktree; close: () => void; removed: () => void;
}) {
  const showToast = useSettingsToast();
  const repository = useGitRepositories().selected!.id;
  const [review, setReview] = useState<WorktreeReview>();
  const [error, setError] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState(0);
  useEffect(() => {
    let active = true;
    window.piApi.gitWorktree(cwd, { repository, kind: 'inspect', path: tree.path, activeCwd }).then(
      result => { if (active) setReview(result); }, e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [cwd, repository, activeCwd, tree.path, read]);
  async function remove(dismiss: ModalDismiss) {
    if (!review || busy) return;
    setBusy(true);
    try {
      await window.piApi.gitWorktree(cwd, { repository, kind: 'remove', path: tree.path, activeCwd, version: review.version });
      await dismiss(removed);
    } catch (e) { showToast(errorText(e), 'error'); setNeedsReview(true); setBusy(false); }
  }
  const retry = needsReview || Boolean(error);
  function checkAgain() {
    setError(null); setNeedsReview(false); setReview(undefined); setRead(n => n + 1);
  }
  return <SettingsDialog title="移除工作树？" action={retry ? '重新检查' : review?.missing ? '解除关联' : '移入回收站'} busyAction="正在移除…"
    busy={busy} loading={!review && !error} unavailable={!review && !retry} error={error} onClose={close}
    onSubmit={dismiss => { if (retry) checkAgain(); else void remove(dismiss); }}>
    <div className="git-tree-fields">
      <div><strong>{tree.branch || '游离 HEAD'}</strong><small>{tree.path}</small></div>
      {review && <>
        {review.dirty.total > 0 && <p className="git-tree-warning" role="alert">有 {review.dirty.total} 个文件含未提交的修改：已暂存 {review.dirty.staged}，未暂存 {review.dirty.unstaged}，未跟踪 {review.dirty.untracked}。</p>}
        {review.dirty.staged > 0 && <p>回收站保留磁盘上的文件。若要保留暂存区里的版本，请先提交。</p>}
        {review.ignored && <p>此目录还包含 Git 忽略的本地文件，将一并移入回收站。</p>}
        <p>{review.missing ? '目录已不存在，将清除此工作树的 Git 关联和暂存区。' : '整个目录将移入系统回收站，并解除 Git 工作树关联。'}
          {tree.branch ? '本地分支及提交会保留。' : '若要保留游离提交 ' + review.head.slice(0, 8) + '，请先为它创建分支。'}</p>
      </>}
    </div>
  </SettingsDialog>;
}

const treeSearch = (tree: GitWorktree) => [tree.branch, tree.path, tree.locked ? '已锁定' : ''].join(' ');

export function WorktreeSettings({ cwd, activeCwd, status, onOpen }: {
  cwd: string; activeCwd: string; status: GitWorkspaceStatus; onOpen: (target: string) => Promise<void>;
}) {
  const showToast = useSettingsToast();
  const repository = useGitRepositories().selected!.id;
  const [create, setCreate] = useState(false);
  const [remove, setRemove] = useState<GitWorktree>();
  const [menu, setMenu] = useState<{ tree: GitWorktree; anchor: HTMLButtonElement; x: number; y: number }>();
  const [opening, setOpening] = useState('');
  const mounted = useRef(true);
  const copyRequest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function open(target: string) {
    setOpening(target);
    try {
      const path = await window.piApi.gitWorktree(cwd, { repository, kind: 'open', path: target });
      if (mounted.current) await onOpen(path);
    } catch (e) { if (mounted.current) showToast(errorText(e), 'error'); }
    finally { if (mounted.current) setOpening(''); }
  }
  function changed(note: string) {
    setCreate(false); setRemove(undefined); showToast(note);
    window.dispatchEvent(new Event(gitChangedEvent));
  }
  async function copyPath(path: string) {
    const request = ++copyRequest.current;
    const current = () => mounted.current && request === copyRequest.current;
    try {
      await navigator.clipboard.writeText(path);
      if (current()) showToast('已复制工作树路径');
    } catch {
      if (current()) showToast('无法复制工作树路径。', 'error');
    }
  }
  const mainPath = status.worktree.mainPath;
  const currentTree = status.worktrees.find(tree => tree.path === status.worktree.path);
  const trees = currentTree && currentTree !== status.worktrees[0]
    ? [currentTree, ...status.worktrees.filter(tree => tree !== currentTree)] : status.worktrees;
  function treeActions(tree: GitWorktree): MenuAction[] {
    const actions: MenuAction[] = [{ label: '复制路径', run: () => void copyPath(tree.path) }];
    if (tree.path !== mainPath) {
      const current = tree.path === status.worktree.path || activeCwd === tree.path || activeCwd.startsWith(tree.path + '/') || activeCwd.startsWith(tree.path + '\\');
      actions.push({ label: current ? '请先切换工作区' : tree.locked ? '工作树已锁定' : '移除工作树', disabled: current || tree.locked,
        destructive: true, run: () => setRemove(tree) });
    }
    return actions;
  }
  return <PreferenceGroup title="工作树" description={status.worktrees.length + ' 个检出目录，共用这个仓库的提交历史。'} actions={
    <button className="settings-outline" type="button" disabled={!mainPath || !status.worktrees.length || !!opening}
      onClick={() => setCreate(true)}><Plus aria-hidden="true" />创建工作树</button>}>
    {trees.length ? <GitSettingsList items={trees} label="工作树" placeholder="搜索分支或目录" pageSize={5} searchText={treeSearch}>
      {tree => <li key={tree.path} className="git-worktree-row">
        <button type="button" className="git-tree-open settings-row-link" disabled={!!opening} aria-label={'打开工作区 ' + tree.path}
          onClick={() => void open(tree.path)}>
          <span className="git-tree-identity">
            <span className="git-tree-branch"><strong>{tree.branch || '游离 HEAD'}</strong>
              {tree.path === mainPath && <small>主工作树</small>}{tree.path === status.worktree.path && <small>当前</small>}{tree.locked && <small>已锁定</small>}
            </span>
            <GitDirectory path={tree.path} />
          </span>
          <span className="git-tree-open-label settings-row-link-indicator">{opening === tree.path ? '正在打开…' : '打开'}<ChevronRight aria-hidden="true" /></span>
        </button>
        <button type="button" className="icon-button" aria-label={'更多工作树操作 ' + tree.path} title="更多操作"
          aria-haspopup="menu" aria-expanded={menu?.tree.path === tree.path} disabled={!!opening} onClick={e => {
            const anchor = e.currentTarget;
            const bounds = anchor.getBoundingClientRect();
            setMenu(menu?.tree.path === tree.path ? undefined : { tree, anchor, x: bounds.right, y: bounds.bottom + 4 });
          }}><MoreHorizontal /></button>
      </li>}
    </GitSettingsList> : <p className="git-list-note">未能读取工作树列表，请刷新仓库状态。</p>}
    {menu && <ActionMenu x={menu.x} y={menu.y} anchor={menu.anchor} align="end" items={treeActions(menu.tree)} onClose={() => setMenu(undefined)} />}
    {create && mainPath && <CreateTreeDialog cwd={cwd} mainPath={mainPath} close={() => { setCreate(false); window.dispatchEvent(new Event(gitChangedEvent)); }}
      created={(target, enter) => { changed('已创建工作树'); if (enter) void open(target); }} />}
    {remove && <RemoveTreeDialog cwd={cwd} activeCwd={activeCwd} tree={remove} close={() => setRemove(undefined)} removed={() => changed('已移除工作树')} />}
  </PreferenceGroup>;
}
