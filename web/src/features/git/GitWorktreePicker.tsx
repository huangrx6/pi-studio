import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, Settings2 } from 'lucide-react';
import { worktreeIcon } from './git-icons';
import { errorText } from '../../shared/error-text';
import type { GitWorkspaceStatus } from '../../types/git-types';
import { GitContextPicker, useGitPickerData } from './GitContextPicker';
import { worktreeAvailability, worktreeHint, worktreeName, worktreeRef } from './worktree-label';
import { gitChangedEvent } from './useGitTools';

const WorktreesDialog = lazy(() => import('./WorktreesDialog'));
const listWorktrees = (cwd: string, repository: string) => window.piApi.gitWorktree(cwd, { kind: 'list', repository });
type PickerProps = { cwd: string; repository: string; status: GitWorkspaceStatus; onOpen: (path: string) => Promise<void> };

export function GitWorktreePicker(props: PickerProps) {
  const { cwd, repository, status, onOpen } = props;
  const [managing, setManaging] = useState(false);
  const path = status.worktree.path;
  if (!path) return null;
  const name = worktreeName(path, status.worktree.mainPath);
  const primary = path === status.worktree.mainPath;
  return <>
    <GitContextPicker label="切换工作树" value={name} icon={worktreeIcon(primary)} iconOnly
      title={'切换工作树\n' + worktreeHint(path, primary)} placeholder="搜索工作树名称、分支或路径">
      {(query, close) => <WorktreeOptions {...props} query={query} close={close} onManage={() => { close(); setManaging(true); }} />}
    </GitContextPicker>
    {managing && <Suspense fallback={null}><WorktreesDialog cwd={cwd} repository={repository} activeCwd={cwd}
      title="管理工作树" onClose={() => setManaging(false)} onOpen={async target => { await onOpen(target); setManaging(false); }} /></Suspense>}
  </>;
}

function WorktreeOptions({ cwd, repository, status, onOpen, query, close, onManage }: PickerProps & {
  query: string; close: () => void; onManage: () => void;
}) {
  const { data, loading, error } = useGitPickerData(cwd, repository, listWorktrees);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const primary = data?.[0];
  const main = primary?.unavailable === 'bare' ? undefined : primary?.path;
  const matches = data?.filter(tree => [tree.path, tree.branch, worktreeName(tree.path, main)]
    .some(value => value?.toLowerCase().includes(query.toLowerCase()))) || [];
  async function open(path: string) {
    if (busy || loading) return;
    setBusy(true); setNotice('');
    try {
      const target = await window.piApi.gitWorktree(cwd, { repository, kind: 'open', path });
      if (!mounted.current) return;
      await onOpen(target);
      if (mounted.current) close();
    } catch (cause) {
      if (mounted.current) { setNotice(errorText(cause)); window.dispatchEvent(new Event(gitChangedEvent)); }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return <>
    <div className="git-branch-options git-worktree-options">
      {matches.map(tree => {
        const current = tree.path === status.worktree.path;
        const Icon = worktreeIcon(tree.path === main);
        const name = worktreeName(tree.path, main);
        const availability = worktreeAvailability(tree);
        const ref = worktreeRef(tree) || availability || '分支未知';
        return <button type="button" key={tree.path} aria-current={current || undefined}
          disabled={current || busy || loading || Boolean(tree.unavailable)} onClick={() => void open(tree.path)} title={tree.path}
          aria-label={[ref, name, availability !== ref && availability, tree.path].filter(Boolean).join(' · ')}>
          <Icon aria-hidden="true" />
          <span className="git-worktree-option"><span><strong>{ref}</strong>{availability && availability !== ref && <small>{availability}</small>}</span>
            <span className="git-path">{name}</span></span>
          {current && <Check aria-label="当前工作树" />}
        </button>;
      })}
      {!matches.length && <p className="git-branch-empty" role={error ? 'alert' : 'status'}>{error || (loading ? '正在读取工作树…' : '没有匹配的工作树')}</p>}
    </div>
    <button type="button" className="git-branch-open-workbench" disabled={busy} onClick={onManage}><Settings2 aria-hidden="true" />管理工作树…</button>
    {notice && <p role="alert">{notice}</p>}
  </>;
}
