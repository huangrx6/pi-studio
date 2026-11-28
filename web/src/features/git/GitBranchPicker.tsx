import { useState } from 'react';
import { Check, Cloud, FilePenLine, GitCommitHorizontal, PanelRightOpen, Plus } from 'lucide-react';
import { BranchIcon } from './git-icons';
import type { GitWorkspaceStatus } from '../../types/git-types';
import { errorText } from '../../shared/error-text';
import { gitChangedEvent } from './useGitTools';
import { GitContextPicker, useGitPickerData } from './GitContextPicker';
import { GitDirectory } from './GitSettingsList';
import { worktreeAvailability, worktreeName } from './worktree-label';

type BranchPickerProps = { cwd: string; repository: string; status: GitWorkspaceStatus; onOpenGit?: () => void };
const readBranches = (cwd: string, repository: string) => window.piApi.gitBranches(cwd, repository);

export function GitBranchPicker(props: BranchPickerProps) {
  const { status, cwd } = props;
  const branch = status.branch || (status.commit && '游离 ' + status.commit);
  if (!branch) return null;
  return <GitContextPicker label="切换分支" value={branch} icon={status.branch ? BranchIcon : GitCommitHorizontal}
    title={'切换分支 · ' + branch + '\n' + (status.worktree.path || cwd)} placeholder="搜索或创建分支">
    {(query, close) => <BranchOptions {...props} query={query} close={close} />}
  </GitContextPicker>;
}

function BranchOptions({ status, cwd, repository, onOpenGit, query, close }: BranchPickerProps & { query: string; close: () => void }) {
  const { data, loading, error } = useGitPickerData(cwd, repository, readBranches);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const matches = data?.branches.filter(b => b.name.toLowerCase().includes(query.toLowerCase())) || [];
  async function choose(kind: 'switch' | 'create', name: string, remoteBranch = false) {
    if (!data || loading || busy) return;
    setBusy(true); setNotice('');
    try {
      await window.piApi.gitCheckout(cwd, { repository, kind, name, remoteBranch, head: data.head, branch: data.branch });
      close();
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(gitChangedEvent));
    }
  }
  return <>
    <div className="git-branch-directory"><span>{status.worktree.isWorktree ? '链接工作树' : '主工作树'}</span><GitDirectory path={status.worktree.path || cwd} /></div>
    <div className="git-branch-options">
      {(['本地分支', '远程分支'] as const).map((label, group) => {
        const items = matches.filter(b => b.remote === Boolean(group));
        if (!items.length) return null;
        if (group === 0) items.sort((a, b) => Number(b.name === data?.branch) - Number(a.name === data?.branch));
        const Icon = group === 0 ? BranchIcon : Cloud;
        return <section key={label}><h3>{label}</h3>{items.map(b => {
          const current = !b.remote && b.name === data?.branch;
          const occupied = Boolean(b.worktree) && !current;
          const tree = occupied && status.worktrees.find(tree => tree.path === b.worktree);
          const owner = worktreeName(b.worktree, status.worktree.mainPath);
          const occupancy = tree && tree.unavailable ? worktreeAvailability(tree) : '已占用';
          return <button type="button" key={b.name} aria-current={current || undefined} disabled={busy || loading || current || occupied}
            title={current ? '当前分支' : occupied ? '占用此分支的工作树 · ' + b.worktree : '在当前目录切换到 ' + b.name}
            onClick={() => void choose('switch', b.name, b.remote)}>
            <Icon aria-hidden="true" /><span>{b.name}</span>{current ? <Check aria-label="当前分支" /> : occupied && <small>{occupancy} · {owner}</small>}
          </button>;
        })}</section>;
      })}
      {!matches.length && <p className="git-branch-empty" role={error ? 'alert' : 'status'}>{error || (loading ? '正在读取分支…' : '没有匹配的分支')}</p>}
    </div>
    {query && !data?.branches.some(b => !b.remote && b.name === query) && <button type="button" className="git-branch-create"
      disabled={!data || busy || loading} onClick={() => void choose('create', query)}><Plus aria-hidden="true" /><span>创建并切换到 <b>{query}</b></span></button>}
    {status.worktree.path === cwd && <p className="git-branch-help">在此目录切换分支会保留会话列表，并打开目标分支的标签页。</p>}
    {!!status.dirty.total && <p className="git-branch-dirty"><FilePenLine aria-hidden="true" />有未提交的修改，发生覆盖时会停止切换。</p>}
    {onOpenGit && <button type="button" className="git-branch-open-workbench" onClick={() => { close(); onOpenGit(); }}>
      <PanelRightOpen aria-hidden="true" />打开 Git
    </button>}
    {notice && <p role="alert">{notice}</p>}
  </>;
}
