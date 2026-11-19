import { useContext, useEffect, useState } from 'react';
import { GitBranch, Columns2, GitCommitHorizontal, PanelsTopLeft, RotateCw, Rows3 } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import { Select } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { errorText } from '../../shared/error-text';
import type { GitDiffPreferences, Preferences } from '../../shared/preferences';
import type { PiWorkspace } from '../../shell/app-types';
import type { GitWorkspaceStatus } from '../../types/git-types';
import '../appearance/styles/general-settings.css';
import { WorktreeSettings } from './WorktreeSettings';
import { GitRepositoryPicker } from './GitRepositoryPicker';
import { GitRepositoryContext, useWorkspaceRepositories } from './useWorkspaceRepositories';
import './styles/git-settings.css';

const layouts = [
  { value: 'auto', label: '自适应', Icon: PanelsTopLeft },
  { value: 'unified', label: '单列', Icon: Rows3 },
  { value: 'split', label: '左右对照', Icon: Columns2 },
] as const;

type StatusRead = { key: string; revision: number; status?: GitWorkspaceStatus; error?: string };

function upstreamStatus(status: GitWorkspaceStatus) {
  if (status.statusReadFailed) return '未能读取';
  if (!status.upstream) return status.branch ? '未设置' : '无上游';
  const { ahead, behind, name } = status.upstream;
  if (ahead === undefined || behind === undefined) return name + ' · 无比较数据';
  const changes = [ahead && '领先 ' + ahead, behind && '落后 ' + behind].filter(Boolean);
  return name + ' · ' + (changes.join(' / ') || '已对齐');
}

function RepositoryStatus({ status, name }: { status: GitWorkspaceStatus; name: string }) {
  const { dirty } = status;
  return <div className="general-settings-card git-settings-repo">
      <div className="git-settings-repo-head">
        <div><strong>{name}</strong><small title={status.repositoryRoot}><bdi dir="ltr">{status.repositoryRoot}</bdi></small></div>
        {status.commit && <code title="当前提交"><GitCommitHorizontal aria-hidden="true" />{status.commit}</code>}
      </div>
      <dl className="git-settings-refs">
        <div><dt>当前分支</dt><dd>{status.branch || '游离 HEAD'}{!status.commit && status.branch && <small>尚无提交</small>}</dd></div>
        <div><dt title="基于最近获取的上游引用">上游分支</dt><dd>{upstreamStatus(status)}</dd></div>
      </dl>
      <div className="git-settings-changes">
        <span>{status.statusReadFailed ? '未能读取工作区变更' : dirty.total ? dirty.total + ' 个文件有变更' : '工作区干净'}</span>
        {!status.statusReadFailed && dirty.total > 0 && <span>已暂存 {dirty.staged} · 未暂存 {dirty.unstaged} · 未跟踪 {dirty.untracked}</span>}
      </div>
    </div>;
}

const unavailable: Record<string, string> = {
  'no-workspace': '打开工作区后即可查看仓库状态。',
  'invalid-workspace': '找不到工作区目录，请检查目录位置。',
  'git-unavailable': '无法运行 Git，请检查本机的 Git 安装。',
  'not-a-repository': '这个工作区没有 Git 仓库。',
};

export function GitSettings({ cwd, workspaces, preferences, onChange, onOpenWorktree }: {
  cwd: string; workspaces: PiWorkspace[]; preferences: GitDiffPreferences;
  onOpenWorktree: (path: string) => Promise<void>;
  onChange: <K extends keyof GitDiffPreferences>(key: K, value: Preferences[K]) => void;
}) {
  const [picked, setPicked] = useState('');
  const options = workspaces.map(workspace => ({ value: workspace.cwd, label: workspace.name, description: workspace.cwd }));
  if (cwd && !options.some(option => option.value === cwd)) {
    options.push({ value: cwd, label: cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd, description: cwd });
  }
  const selected = options.find(option => option.value === picked) || options.find(option => option.value === cwd) || options[0];
  const target = selected?.value || '';
  const conversation = useContext(GitRepositoryContext);
  const other = useWorkspaceRepositories(conversation?.cwd === target ? '' : target, selected?.label);
  const repositories = conversation?.cwd === target ? conversation : other;
  const repository = repositories.selected;
  const key = JSON.stringify([target, repository?.id]);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<StatusRead>();
  useEffect(() => {
    let active = true;
    if (target && repository) window.piApi.gitWorkspaceStatus(target, repository.id).then(
      status => { if (active) setRead({ key, revision, status }); },
      error => { if (active) setRead({ key, revision, error: errorText(error) }); },
    );
    return () => { active = false; };
  }, [target, revision, key, repository?.id]);
  const current = read?.key === key ? read : undefined;
  const loading = repositories.loading || Boolean(repository && current?.revision !== revision);
  const status = current?.status;
  return <div className="settings-sections git-settings">
    <SettingsPageHeader
      icon={<GitBranch />}
      title="Git 工作流"
      meta={<span>先看当前仓库，再调整差异阅读习惯</span>}
    />
    <GitRepositoryContext.Provider value={repositories}><section className="git-settings-project" aria-labelledby="git-project-title">
      <div className="git-settings-project-head">
        <h2 id="git-project-title">仓库状态</h2>
        {options.length > 1 && <Select label="工作区" value={target} options={options} onChange={setPicked} />}
        <GitRepositoryPicker label="设置中的项目仓库" />
        <button type="button" className="icon-button" aria-label="刷新 Git 状态" title="刷新 Git 状态" disabled={!target || loading}
          onClick={() => { repositories.refresh(); setRevision(value => value + 1); }}><RotateCw className={loading ? 'spin' : ''} /></button>
      </div>
      {(repositories.error || current?.error) && <p role="alert" className="settings-error">{repositories.error || current?.error}</p>}
      {loading && !current && <LoadingState variant="section">正在读取 Git 状态…</LoadingState>}
      {(!target || (!repository && !loading && !repositories.error) || (status && !status.available)) && <p className="git-settings-message">{!target ? unavailable['no-workspace'] : unavailable[status?.reason || 'not-a-repository'] || '无法读取当前仓库。'}</p>}
      {status?.available && <>
        <RepositoryStatus status={status} name={repository?.name || selected?.label || target} />
        <WorktreeSettings key={key} cwd={target} activeCwd={cwd} status={status} onOpen={onOpenWorktree}
          onChange={() => setRevision(value => value + 1)} />
      </>}
    </section></GitRepositoryContext.Provider>
    <section className="general-settings-section" aria-labelledby="git-review-settings-title">
      <header className="general-section-head">
        <h2 id="git-review-settings-title">差异审阅</h2>
        <p className="general-section-description">作用于所有工作区的变更与提交详情。</p>
      </header>
      <div className="general-settings-card">
        <div className="general-setting-row">
          <div className="general-setting-label">默认布局<small className="general-setting-description">窄栏下，自适应会改用单列。</small></div>
          <div className="general-theme-options" role="group" aria-label="默认差异布局">
            {layouts.map(({ value, label, Icon }) => <button type="button" key={value} aria-pressed={preferences.gitDiffLayout === value}
              onClick={() => onChange('gitDiffLayout', value)}><Icon aria-hidden="true" />{label}</button>)}
          </div>
        </div>
        <div className="general-setting-row">
          <span className="general-setting-label">长行自动换行</span>
          <button type="button" role="switch" aria-label="长行自动换行" aria-checked={preferences.gitDiffWrap}
            className={'switch' + (preferences.gitDiffWrap ? ' is-on' : '')} onClick={() => onChange('gitDiffWrap', !preferences.gitDiffWrap)}><span /></button>
        </div>
      </div>
    </section>
  </div>;
}
