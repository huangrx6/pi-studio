import { useEffect, useRef, useState } from 'react';
import { Check, Cloud, Files, History, RefreshCw, TriangleAlert } from 'lucide-react';
import { SessionViewHeader } from '../../shell/SessionViewHeader';
import type { GitAction, GitTab } from '../../types/git-types';
import { gitChangedEvent, useGitAction, useGitState, useGitRevision } from './useGitTools';
import { GitChanges } from './GitChanges';
import { GitHistory } from './GitHistory';
import { GitSync } from './GitSync';
import { GitDiffDefaults } from './GitFileDiff';
import type { GitDiffPreferences } from '../../shared/preferences';
import './styles/git-workspace.css';

const successes: Record<GitAction['kind'], string> = {
  stage: '已暂存', unstage: '已取消暂存', commit: '已提交', fetch: '已获取远程更新', pull: '拉取完成', push: '推送完成', switch: '已切换分支', create: '已创建分支',
  remoteAdd: '已添加远程', remoteEdit: '已更新远程地址', remoteRename: '已重命名远程', remoteRemove: '已移除远程',
  abortMerge: '已中止合并',
};
const tabs = [
  ['changes', '变更', Files], ['history', '提交历史', History], ['sync', '远程同步', Cloud],
] as const;

export default function GitWorkspacePage({ sessionId, tab, onTab, diffPreferences, openFile }: {
  sessionId: string; tab: GitTab; onTab: (tab: GitTab) => void; diffPreferences: GitDiffPreferences; openFile: (root: string, path: string) => void;
}) {
  const pollReady = useRef(false);
  const revision = useGitRevision(pollReady);
  const state = useGitState(sessionId, tab === 'sync' || tab === 'history', revision);
  const mutation = useGitAction(sessionId);
  useEffect(() => { pollReady.current = tab !== 'history' && !state.loading && !mutation.busy; }, [tab, state.loading, mutation.busy]);
  const view = tab === 'commit' ? 'changes' : tab;
  const [feedback, setFeedback] = useState<{ view: typeof view; message?: string; detail?: string }>();
  useEffect(() => {
    if (feedback?.message) {
      const timer = window.setTimeout(() => setFeedback(undefined), 5000);
      return () => window.clearTimeout(timer);
    }
  }, [feedback]);
  async function execute(action: GitAction, detail?: string) {
    if (!state.data || state.loading || mutation.busy) return false;
    setFeedback({ view });
    const ok = await mutation.act(state.data, action);
    if (ok) setFeedback({ view, message: successes[action.kind], detail });
    return ok;
  }
  const repo = state.data?.root;
  const error = state.error || (feedback?.view === view && mutation.error);
  const success = feedback?.view === view && feedback.message;
  return <section className="git-workspace-page" aria-label="Git 工作台"><div className="git-workspace-column">
    <SessionViewHeader title="版本控制" summary={repo && <span title={repo}>{repo.split(/[\\/]/).filter(Boolean).at(-1) || repo}</span>}>
      <button type="button" className="icon-button git-refresh" aria-label="刷新 Git" title="刷新 Git" disabled={mutation.busy}
        onClick={() => { setFeedback(undefined); window.dispatchEvent(new Event(gitChangedEvent)); }}><RefreshCw /></button>
    </SessionViewHeader>
    <div className="git-view-toolbar"><nav className="git-view-tabs" aria-label="Git 视图">{tabs.map(([key, title, Icon]) =>
      <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => onTab(key)}><Icon />{title}</button>)}</nav>
      <div className="git-operation-note" role="status">{mutation.busy ? <><RefreshCw className="spin" />正在处理…</> : success && <><Check /><span>{success}</span>{feedback?.detail && <span>{feedback.detail}</span>}</>}</div>
    </div>
    {error && <p role="alert" className="git-feedback"><TriangleAlert />{error}</p>}
    <GitDiffDefaults.Provider value={diffPreferences}>{tab === 'history' ? <GitHistory sessionId={sessionId} revision={revision} /> : !state.data ? !state.error && <p className="git-muted">正在读取仓库…</p>
      : tab === 'sync' ? <GitSync sessionId={sessionId} revision={revision} state={state.data} busy={mutation.busy} error={mutation.error}
          disabled={mutation.busy || state.loading} execute={execute} openChanges={() => onTab('changes')} />
      : <GitChanges key={state.data.branch} state={state.data} sessionId={sessionId} revision={revision} focusCommit={tab === 'commit'} busy={mutation.busy}
          disabled={mutation.busy || state.loading} execute={execute} actionError={mutation.error} openFile={openFile} openHistory={() => onTab('history')} />}</GitDiffDefaults.Provider>
  </div></section>;
}
