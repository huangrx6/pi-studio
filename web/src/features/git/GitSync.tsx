import { useId, useState } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeftRight, ArrowUp, ChevronRight, Cloud, CloudOff, GitBranch } from 'lucide-react';
import { Select } from '../../shared/Select';
import type { GitAction, GitState } from '../../types/git-types';
import './styles/git-sync.css';

type GitSyncProps = {
  state: GitState;
  disabled: boolean;
  execute: (action: GitAction) => Promise<boolean>;
  openChanges: () => void;
};

const operations = [
  { kind: 'fetch', title: '获取', command: 'Fetch', icon: ArrowDownToLine, detail: '更新本地记录的远程分支信息。' },
  { kind: 'pull', title: '拉取', command: 'Pull', icon: ArrowDown, detail: '将远程分支的提交合并到当前分支。' },
  { kind: 'push', title: '推送', command: 'Push', icon: ArrowUp, detail: '将当前分支的提交发布到远程。' },
] as const;

function syncStatus(state: GitState, tracks: boolean) {
  if (state.merging) {
    const conflicts = state.files.filter(file => file.conflict).length;
    return { title: conflicts ? '合并等待解决冲突' : '合并等待提交',
      detail: conflicts ? `还有 ${conflicts} 个冲突文件需要处理。` : '冲突已全部解决，可以提交此次合并。' };
  }
  if (!state.branch) return { title: '当前位于游离 HEAD', detail: '切换或创建本地分支后即可拉取和推送。' };
  if (!state.head) return { title: '等待首次提交', detail: '创建本地提交后即可推送，也可从已有的远程分支拉取。' };
  if (!tracks) return state.upstreamRemote
    ? { title: '同步到其他远程', detail: `当前分支的上游是 ${state.upstreamRemote}/${state.upstreamBranch}。` }
    : { title: '尚未设置上游分支', detail: '首次推送会把下方的目标分支设为上游。' };
  if (state.gone) return { title: '上游分支已消失', detail: '本地已找不到对应的远程引用，可重新获取远程信息。' };
  if (state.ahead && state.behind) return { title: '两端各有新提交', detail: `与最近获取的上游相比，本地领先 ${state.ahead} 个提交，落后 ${state.behind} 个。拉取合并后即可推送。` };
  if (state.ahead) return { title: `有 ${state.ahead} 个本地提交待推送`, detail: '相对于最近获取的上游分支。' };
  if (state.behind) return { title: `有 ${state.behind} 个远程提交待拉取`, detail: '相对于最近获取的上游分支。' };
  return { title: '本地与上游一致', detail: '获取远程信息可检查是否有新提交。' };
}

export function GitSync({ state, disabled, execute, openChanges }: GitSyncProps) {
  const [chosen, setChosen] = useState('');
  const descriptionId = useId();
  const remote = [chosen, state.upstreamRemote, 'origin'].find(name => state.remotes.includes(name)) ?? state.remotes[0];
  const tracks = remote === state.upstreamRemote && Boolean(state.upstreamBranch);
  if (!remote) return <section className="git-remote-empty" aria-label="远程同步">
    <CloudOff aria-hidden="true" />
    <h3>尚未配置远程仓库</h3>
    <p>在此仓库中添加 Git 远程地址，然后点右上角的刷新按钮。</p>
  </section>;

  const target = state.branch ? `${remote}/${tracks ? state.upstreamBranch : state.branch}` : '';
  const status = syncStatus(state, tracks);
  return <section className="git-remote" aria-label="远程同步">
    <div className="git-remote-heading">
      <div>
        <h3>{status.title}</h3>
        <p>{status.detail}</p>
      </div>
      <Select label="远程仓库" value={remote} options={state.remotes.map(value => ({ value, label: value }))}
        leadingIcon={<Cloud />} className="git-remote-picker" onChange={setChosen} />
    </div>
    <div className="git-remote-refs">
      <div className="git-remote-ref"><span><GitBranch aria-hidden="true" />本地分支</span>
        <code dir="auto">{state.branch || state.head.slice(0, 8) || 'HEAD'}</code></div>
      <span className="git-remote-connection" aria-hidden="true"><ArrowLeftRight /></span>
      <div className="git-remote-ref"><span><Cloud aria-hidden="true" />{tracks ? '上游分支' : '目标分支'}</span>
        {target ? <code dir="auto">{target}</code> : <span>待选择本地分支</span>}</div>
    </div>
    {state.merging && <button type="button" className="git-remote-conflicts" onClick={openChanges}>查看合并中的文件<ChevronRight aria-hidden="true" /></button>}
    <ul className="git-remote-operations">{operations.map(({ kind, title, icon: Icon, command, detail }) => {
      const canOperate = kind === 'fetch' || (state.branch && !state.merging && (kind === 'pull' || state.head));
      const id = descriptionId + '-' + kind;
      return <li key={kind}>
        <Icon className="git-remote-op-icon" aria-hidden="true" />
        <div className="git-remote-op-copy"><strong>{title}</strong><p id={id}>{detail}</p></div>
        <button type="button" aria-label={title + ' ' + command} aria-describedby={id} disabled={disabled || !canOperate}
          onClick={() => void execute({ kind, remote })}>{command}</button>
      </li>;
    })}</ul>
  </section>;
}
