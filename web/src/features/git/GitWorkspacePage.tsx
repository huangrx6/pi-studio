import { useEffect, useRef, useState } from 'react';
import { Check, Cloud, Files, History, RefreshCw, TriangleAlert } from 'lucide-react';
import { PanelViewSwitcher } from '../../shared/PanelViewSwitcher';
import { LoadingState } from '../../shared/LoadingState';
import type { GitAction, GitDiffSource, GitTab } from '../../types/git-types';
import { gitChangedEvent, useGitAction, useGitState, useGitRevision } from './useGitTools';
import { GitChanges } from './GitChanges';
import { GitHistory } from './GitHistory';
import { GitSync } from './GitSync';
import { GitRepositoryPicker } from './GitRepositoryPicker';
import { useGitRepositories } from './useWorkspaceRepositories';
import './styles/git-workspace.css';

const successes: Record<GitAction['kind'], string> = {
  stage: '已暂存', unstage: '已取消暂存', commit: '已提交', fetch: '已获取远程更新', pull: '拉取完成', push: '推送完成',
  remoteAdd: '已添加远程', remoteEdit: '已更新远程地址', remoteRename: '已重命名远程', remoteRemove: '已移除远程',
  abortMerge: '已中止合并',
};
const tabs = [
  ['changes', '变更', Files], ['history', '提交历史', History], ['sync', '远程同步', Cloud],
] as const;

type WorkspaceProps = {
  sessionId: string; tab: GitTab; onTab: (tab: GitTab) => void;
  onOpenDiff: (repository: string, source: GitDiffSource) => void; openFile: (root: string, path: string) => void;
};
export default function GitWorkspacePage(props: WorkspaceProps) {
  const { selected } = useGitRepositories();
  return <RepositoryPage key={JSON.stringify([props.sessionId, selected?.root])} {...props} />;
}
function RepositoryPage({ sessionId, tab, onTab, onOpenDiff, openFile }: WorkspaceProps) {
  const repositories = useGitRepositories();
  const pollReady = useRef(false);
  const revision = useGitRevision(pollReady);
  const state = useGitState(sessionId, tab === 'sync' || tab === 'history', revision);
  const mutation = useGitAction(sessionId);
  useEffect(() => { pollReady.current = tab !== 'history' && !state.loading && !mutation.busy; }, [tab, state.loading, mutation.busy]);
  const [feedback, setFeedback] = useState<{ view: GitTab; message?: string; detail?: string }>();
  useEffect(() => {
    if (feedback?.message) {
      const timer = window.setTimeout(() => setFeedback(undefined), 5000);
      return () => window.clearTimeout(timer);
    }
  }, [feedback]);
  async function execute(action: GitAction, detail?: string) {
    if (!state.data || state.loading || mutation.busy) return false;
    setFeedback({ view: tab });
    const ok = await mutation.act(state.data, action);
    if (ok) setFeedback({ view: tab, message: successes[action.kind], detail });
    return ok;
  }
  const repo = repositories.selected;
  const error = repositories.error || state.error || (feedback?.view === tab && mutation.error);
  const success = feedback?.view === tab && feedback.message;
  return <section className="git-workspace-page" aria-label="Git 工作台"><div className="git-workspace-column">
    <div className="git-view-toolbar">
      <PanelViewSwitcher label="Git 视图" choices={tabs} value={tab} onChange={onTab} />
      <button type="button" className="icon-button git-refresh" aria-label="刷新 Git" title="刷新 Git" disabled={mutation.busy}
        onClick={() => { setFeedback(undefined); repositories.refresh(); window.dispatchEvent(new Event(gitChangedEvent)); }}><RefreshCw /></button>
    </div>
    <GitRepositoryPicker />
    <div className="git-operation-note" role="status">{mutation.busy ? <><RefreshCw className="spin" />正在处理…</> : success && <><Check /><span>{success}</span>{feedback?.detail && <span>{feedback.detail}</span>}</>}</div>
    {error && <p role="alert" className="git-feedback"><TriangleAlert />{error}</p>}
    {!repo
      ? repositories.loading ? <LoadingState variant="section">正在查找项目仓库…</LoadingState> : !error && <p className="git-muted">工作区中没有找到 Git 仓库。</p>
      : tab === 'history' ? <GitHistory sessionId={sessionId} revision={revision} onOpenDiff={source => onOpenDiff(repo.id, source)} /> : !state.data ? !state.error && <LoadingState variant="section">正在读取仓库…</LoadingState>
      : tab === 'sync' ? <GitSync sessionId={sessionId} revision={revision} state={state.data} busy={mutation.busy} error={mutation.error}
          disabled={mutation.busy || state.loading} execute={execute} openChanges={() => onTab('changes')} />
      : <GitChanges key={state.data.branch} state={state.data} sessionId={sessionId} onOpenDiff={source => onOpenDiff(repo.id, source)} busy={mutation.busy}
          disabled={mutation.busy || state.loading} execute={execute} actionError={mutation.error} openFile={openFile} openHistory={() => onTab('history')} />}
  </div></section>;
}
