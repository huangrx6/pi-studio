import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, LoaderCircle, RotateCw } from 'lucide-react';
import type { GitWorkspaceStatus } from '../../types/git-types';
import type { PiWorkspace } from '../../shell/app-types';
import { Select } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import './git-settings.css';

export function GitSettings({ cwd, workspaces }: { cwd: string; workspaces: PiWorkspace[] }) {
  const [targetWorkspace, setTargetWorkspace] = useState(cwd || workspaces[0]?.cwd || '');
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const workspaceOptions = useMemo(() => workspaces.map((workspace) => ({ value: workspace.cwd, label: workspace.name })), [workspaces]);

  const load = useCallback(async () => {
    if (!targetWorkspace) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStatus(await window.piApi.gitWorkspaceStatus(targetWorkspace));
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [targetWorkspace]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!targetWorkspace && (cwd || workspaces[0]?.cwd)) setTargetWorkspace(cwd || workspaces[0].cwd);
  }, [cwd, targetWorkspace, workspaces]);

  const selectedName = workspaces.find((workspace) => workspace.cwd === targetWorkspace)?.name
    || targetWorkspace.split(/[\\/]/).filter(Boolean).at(-1)
    || '当前目录';

  return <div className="settings-sections git-settings">
    <SettingsPageHeader
      icon={<GitBranch />}
      title="Git 与 Worktree"
      meta={<span>管理当前项目的分支、提交、改动和 worktree。</span>}
      actions={<button type="button" className="icon-button" aria-label="刷新 Git 状态" title="刷新" disabled={loading} onClick={() => void load()}><RotateCw className={loading ? 'spin' : ''} /></button>}
    />
    {workspaceOptions.length > 1 && <label className="git-settings-workspace">
      <span>工作区</span>
      <Select label="工作区" value={targetWorkspace} options={workspaceOptions} onChange={setTargetWorkspace} />
    </label>}
    {error && <div className="settings-error" role="alert">{error}</div>}
    {loading && !status && <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在读取 Git 状态…</div>}
    {!loading && status && !status.available && <div className="git-settings-empty">
      <strong>{selectedName} 不是 Git 项目</strong>
      <span>切换到 Git 仓库后，这里会显示分支、提交和 worktree 信息。</span>
    </div>}
    {status?.available && <>
      <div className="git-settings-summary" aria-label="Git 状态摘要">
        <div><span>分支</span><strong>{status.branch || '分离 HEAD'}</strong></div>
        <div><span>提交</span><strong className="git-settings-mono">{status.commit || '—'}</strong></div>
        <div><span>变更</span><strong className={status.dirty.total ? 'is-dirty' : ''}>{status.dirty.total} 个文件</strong></div>
        <div><span>当前工作树</span><strong>{status.worktree.isWorktree ? status.worktree.name : '主工作树'}</strong></div>
      </div>
      <section className="git-settings-section" aria-labelledby="git-worktrees-title">
        <div className="git-settings-section-heading"><div><h2 id="git-worktrees-title">Worktree</h2><p>{status.worktrees.length} 个工作树 · {status.repositoryRoot}</p></div></div>
        <div className="git-worktree-list">
          {status.worktrees.map((worktree) => <article className={`git-worktree-row ${worktree.path === status.worktree.path ? 'is-current' : ''}`} key={worktree.path}>
            <div><strong>{worktree.path === status.worktree.mainPath ? '主工作树' : (worktree.path.split(/[\\/]/).filter(Boolean).at(-1) || worktree.path)}</strong>{worktree.path === status.worktree.path && <span>当前</span>}<small>{worktree.branch || '分离 HEAD'} · {worktree.path}</small></div>
          </article>)}
          {!status.worktrees.length && <div className="settings-empty">没有可显示的 worktree。</div>}
        </div>
      </section>
    </>}
  </div>;
}
