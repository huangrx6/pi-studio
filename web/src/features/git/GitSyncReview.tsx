import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { Select } from '../../shared/Select';
import type { GitAction, GitRemoteInfo, GitSyncKind } from '../../types/git-types';
import { useGitRead } from './useGitTools';

function CommitRange({ sessionId, title, tip, exclude, count }: {
  sessionId: string; title: string; tip: string; exclude: string; count: number;
}) {
  const [page, setPage] = useState(0);
  const { data, error } = useGitRead(count ? sessionId : undefined, 'syncCommits', { tip, exclude, offset: page * 20 }, 0);
  return <section className="git-sync-range" aria-label={title}><h3>{title}<small>{count}</small></h3>
    {!count ? <p>没有提交</p> : error ? <p role="alert">{error}</p> : !data ? <p role="status">正在读取提交…</p>
      : <ul>{data.map(commit => <li key={commit.hash}><code title={commit.hash}>{commit.hash.slice(0, 8)}</code><span>{commit.subject || '无提交说明'}</span></li>)}</ul>}
    {count > 20 && <nav aria-label={title + '翻页'}><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{page + 1} / {Math.ceil(count / 20)}</span>
      <button type="button" disabled={(page + 1) * 20 >= count} onClick={() => setPage(page + 1)}>下一页</button></nav>}
  </section>;
}

export function GitSyncReview({ sessionId, info, operation, busy, disabled, actionError, execute, close }: {
  sessionId: string; info: GitRemoteInfo; operation: GitSyncKind; busy: boolean; disabled: boolean; actionError: string;
  execute: (action: GitAction, detail?: string) => Promise<boolean>; close: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [accepted, setAccepted] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const push = operation === 'push';
  const multiple = push && info.pushUrls.length > 1;
  const [targetIndex, setTargetIndex] = useState<number | undefined>(multiple ? undefined : 0);
  const remote = info.name;
  const { data, error, loading } = useGitRead(targetIndex === undefined ? undefined : sessionId, 'syncPreview',
    { remote, operation, targetIndex, remoteVersion: info.version }, attempt);
  const title = push ? '推送' : '拉取';
  const force = Boolean(push && data?.incoming);
  const forceApproved = !!data && accepted === data.version;
  const remoteRef = data && data.remote + '/' + data.target;
  const noChange = data && (push ? !data.outgoing && !force && !data.setUpstream && !!data.remoteHead : !data.incoming);
  const fastForwardBlocked = !push && data?.mergeMode === 'ff-only' && data.incoming > 0 && data.outgoing > 0;
  const failure = error || (submitted && actionError) || null;
  return <SettingsDialog title={title + '预览'} action={force ? '确认安全强推' : '确认' + title} busyAction={'正在' + title + '…'}
    busy={busy} loading={loading} error={failure} autoFocusFirstField={false}
    unavailable={disabled || !data || !!failure || !!noChange || fastForwardBlocked || (force && !forceApproved)} onClose={close}
    onSubmit={async () => {
      if (!data) return;
      setSubmitted(true);
      const detail = push ? remoteRef + ' · ' + data.head.slice(0, 8) : remoteRef + ' → ' + data.branch + ' · ' + data.incoming + ' 个提交';
      if (await execute({ kind: operation, remote, targetIndex, version: data.version, force: force && forceApproved }, detail)) close();
    }}>
    {multiple && <div className="git-remote-form"><label>本次推送的地址<Select label="推送目标地址" placeholder="选择地址" value={String(targetIndex ?? '')}
      options={info.pushUrls.map((label, i) => ({ value: String(i), label }))}
      onChange={value => { setTargetIndex(Number(value)); setSubmitted(false); setAccepted(''); }} /></label></div>}
    {data && <div className="git-sync-review">
      <div className="git-sync-route"><div><small>{push ? '本地分支' : '远程分支'}</small><code>{push ? data.branch : remoteRef}</code></div>
        <ArrowRight aria-hidden="true" /><div><small>{push ? '远程分支' : '本地分支'}</small><code>{push ? remoteRef : data.branch}</code></div></div>
      <p className="git-sync-address">{data.address}</p>
      {noChange && <p>两端已包含本次{title}的全部提交。</p>}
      {push && !data.remoteHead && <p>将创建远程分支。下方列出新分支的完整历史。</p>}
      {data.setUpstream && <p>推送成功后，上游将设为 <code>{remoteRef}</code>。</p>}
      {!push && <p>{data.dirty && '工作区有未提交的修改。如果会覆盖这些修改，Git 会停止拉取。'}
        {fastForwardBlocked ? '两端历史已分叉，但此仓库配置为仅允许快进拉取。请先处理分叉再同步。'
          : data.incoming > 0 && (data.outgoing || (data.head && data.mergeMode === 'no-ff') ? '将创建合并提交。' : '当前分支将前进到远程提交。')}
        {data.incoming > 0 && !fastForwardBlocked && '遇到冲突时，可在「变更」中打开文件，编辑后标记为已解决，再提交合并。'}</p>}
      <CommitRange key={data.version} sessionId={sessionId} title={push ? '将推送的提交' : '将拉取的提交'} count={push ? data.outgoing : data.incoming}
        tip={push ? data.head : data.remoteHead} exclude={push ? data.remoteHead : data.head} />
      {force && <><CommitRange key={data.version + '-remote'} sessionId={sessionId} title="将从远程分支移除的提交"
        tip={data.remoteHead} exclude={data.head} count={data.incoming} />
        <p className="git-sync-warning">常规推送会被拒绝。可以先拉取并合并，或用本地历史覆盖这个远程分支。</p>
        <label className="git-force-choice"><input type="checkbox" checked={forceApproved}
          onChange={e => setAccepted(e.target.checked ? data.version : '')} />允许安全强推。若远程再次更新，本次推送将停止。</label></>}
    </div>}
    {failure && <button className="settings-outline" type="button" onClick={() => { setSubmitted(false); setAccepted(''); setAttempt(n => n + 1); }}>重新预览</button>}
  </SettingsDialog>;
}
