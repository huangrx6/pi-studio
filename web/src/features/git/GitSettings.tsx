import { useContext, useEffect, useId, useState } from 'react';
import { ArrowUpRight, ChevronRight, FileDiff, Folder, GitCommitHorizontal, RotateCw } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { Select } from '../../shared/Select';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { errorText } from '../../shared/error-text';
import type { GitDiffPreferences, Preferences } from '../../shared/preferences';
import type { PiWorkspace } from '../../shell/app-types';
import type { GitFile, GitWorkspaceStatus } from '../../types/git-types';
import { GitRepositoryPicker } from './GitRepositoryPicker';
import { GitDirectory, GitSettingsList } from './GitSettingsList';
import { WorktreeSettings } from './WorktreeSettings';
import { gitChangedEvent, useGitRevision } from './useGitTools';
import { GitRepositoryContext, useWorkspaceRepositories } from './useWorkspaceRepositories';
import './styles/git-settings.css';

const layouts = [
  { value: 'auto', label: '自适应' }, { value: 'unified', label: '单列' }, { value: 'split', label: '左右对照' },
] as const;

const unavailable: Record<string, string> = {
  'no-workspace': '打开工作区后即可查看仓库状态。',
  'invalid-workspace': '找不到工作区目录，请检查目录位置。',
  'git-unavailable': '无法运行 Git，请检查本机的 Git 安装。',
  'not-a-repository': '这个工作区没有 Git 仓库。',
};

function upstreamStatus(status: GitWorkspaceStatus) {
  if (status.statusReadFailed) return '未能读取';
  if (!status.upstream) return status.branch ? '未设置' : '无上游';
  const { ahead, behind, name } = status.upstream;
  if (ahead === undefined || behind === undefined) return name + ' · 无比较数据';
  const changes = [ahead && '领先 ' + ahead, behind && '落后 ' + behind].filter(Boolean);
  return name + ' · ' + (changes.join(' / ') || '已对齐');
}

function fileStatus(file: GitFile) {
  if (file.conflict) return '合并冲突';
  if (file.index === '?') return '未跟踪';
  return [file.index !== ' ' && '已暂存', file.worktree !== ' ' && '未暂存'].filter(Boolean).join(' · ');
}
const fileSearch = (file: GitFile) => [file.path, file.previousPath, fileStatus(file)].join(' ');

function ChangedFiles({ cwd, repository, revision }: { cwd: string; repository: string; revision: number }) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ files?: GitFile[]; error?: string }>();
  useEffect(() => {
    let active = true;
    window.piApi.gitWorkspaceChanges(cwd, repository).then(
      files => { if (active) setResult({ files }); },
      error => { if (active) setResult({ error: errorText(error) }); },
    );
    return () => { active = false; };
  }, [cwd, repository, revision, retry]);
  if (!result) return <LoadingState variant="section">正在读取变更文件…</LoadingState>;
  if (!result.files) return <div className="git-settings-message"><span role="alert">{result.error}</span>
    <button className="settings-outline" type="button" onClick={() => { setResult(undefined); setRetry(n => n + 1); }}>重新读取</button></div>;
  return <GitSettingsList items={result.files} label="变更文件" placeholder="搜索文件路径或状态" searchText={fileSearch} pageSize={6}>
    {file => <li className="git-change-file" key={file.path}>
      <FileDiff aria-hidden="true" />
      <span className="git-change-path" title={file.previousPath ? file.previousPath + ' → ' + file.path : file.path}>
        {file.previousPath && <span>{file.previousPath} → </span>}{file.path}
      </span><span>{fileStatus(file)}</span>
    </li>}
  </GitSettingsList>;
}

function RepositoryStatus({ cwd, repository, revision, status, name, onOpenChanges }: {
  cwd: string; repository: string; revision: number; status: GitWorkspaceStatus; name: string; onOpenChanges?: () => void;
}) {
  const { dirty } = status;
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return <>
    <div className="git-repo-identity">
      <div><strong>{name}</strong>{status.repositoryRoot && <GitDirectory path={status.repositoryRoot} />}</div>
      {onOpenChanges && <button type="button" className="settings-outline" onClick={onOpenChanges}>打开版本控制<ArrowUpRight aria-hidden="true" /></button>}
    </div>
    <dl className="git-settings-refs">
      <div><dt>当前分支</dt><dd><span>{status.branch || '游离 HEAD'}</span>{status.commit
        ? <code title="当前提交"><GitCommitHorizontal aria-hidden="true" />{status.commit}</code> : <small>尚无提交</small>}</dd></div>
      <div><dt>上游分支</dt><dd title="根据最近获取的上游引用计算">{upstreamStatus(status)}</dd></div>
    </dl>
    <div className="git-settings-changes">
      {status.statusReadFailed || !dirty.total ? <p className="git-change-summary">{status.statusReadFailed ? '未能读取工作区变更，请刷新重试。' : '工作区干净'}</p> : <>
        <button type="button" aria-expanded={expanded} aria-controls={listId} className="git-change-disclosure" onClick={() => setExpanded(value => !value)}>
          <span>{dirty.total} 个文件有变更</span><small>已暂存 {dirty.staged} · 未暂存 {dirty.unstaged} · 未跟踪 {dirty.untracked}</small><ChevronRight aria-hidden="true" />
        </button>
        <div id={listId} hidden={!expanded}>{expanded && <ChangedFiles cwd={cwd} repository={repository} revision={revision} />}</div>
      </>}
    </div>
  </>;
}

type StatusRead = { key: string; revision: number; status?: GitWorkspaceStatus; error?: string };

export function GitSettings({ cwd, workspaces, preferences, onChange, onOpenWorktree, onChooseWorkspace, onOpenChanges }: {
  cwd: string; workspaces: PiWorkspace[]; preferences: GitDiffPreferences;
  onOpenWorktree: (path: string) => Promise<void>; onChooseWorkspace: () => void; onOpenChanges?: () => void;
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
  const revision = useGitRevision();
  const [read, setRead] = useState<StatusRead>();
  const canRead = !!target && (!!repository || (!repositories.loading && !repositories.error));
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    window.piApi.gitWorkspaceStatus(target, repository?.id).then(
      status => { if (active) setRead({ key, revision, status }); },
      error => { if (active) setRead({ key, revision, error: errorText(error) }); },
    );
    return () => { active = false; };
  }, [target, revision, key, repository?.id, canRead]);
  const current = read?.key === key ? read : undefined;
  const loading = repositories.loading || (canRead && current?.revision !== revision);
  const error = repositories.error || current?.error;
  const status = current?.status;
  function refresh() {
    repositories.refresh();
    window.dispatchEvent(new Event(gitChangedEvent));
  }
  return <div className="settings-preference-page git-settings">
    <SettingsPageHeader iconPosition="end" title="Git 工作流" meta="查看仓库变更，管理工作树与差异阅读偏好。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 8v16m0-5c0-6 16-2 16-11" /><circle cx="8" cy="5" r="2.8" /><circle cx="8" cy="27" r="2.8" />
        <circle cx="24" cy="5" r="2.8" stroke="var(--accent)" /></svg>} />
    <div className="settings-preference-groups">
      <GitRepositoryContext.Provider value={repositories}>
        <PreferenceGroup title="仓库状态" actions={<>
          {options.length > 1 && <Select label="工作区" leadingIcon={<Folder />} value={target} options={options} onChange={setPicked} />}
          <GitRepositoryPicker label="设置中的项目仓库" />
          <button type="button" className="icon-button" aria-label="刷新 Git 状态" title="刷新 Git 状态" disabled={!target || loading}
            onClick={refresh}><RotateCw className={loading ? 'spin' : ''} /></button>
        </>}>
          {error ? <div className="git-settings-message"><p role="alert" className="settings-error">{error}</p>
            <button type="button" className="settings-outline" onClick={onChooseWorkspace}>打开工作区</button></div>
            : loading && !current ? <LoadingState variant="section">正在读取仓库状态…</LoadingState>
            : status?.available && repository ? <RepositoryStatus key={key} cwd={target} repository={repository.id}
              name={options.length > 1 && repository.name === selected?.label ? '仓库目录' : repository.name}
              revision={revision} status={status} onOpenChanges={conversation?.cwd === target ? onOpenChanges : undefined} />
            : <div className="git-settings-message"><p>{!target ? unavailable['no-workspace'] : unavailable[status?.reason || 'not-a-repository'] || '无法读取当前仓库。'}</p>
              <button type="button" className="settings-outline" onClick={onChooseWorkspace}>打开工作区</button></div>}
        </PreferenceGroup>
        {status?.available && repository && <WorktreeSettings key={key} cwd={target} activeCwd={cwd} status={status} onOpen={onOpenWorktree} />}
      </GitRepositoryContext.Provider>
      <PreferenceGroup title="差异审阅" summary={layouts.find(layout => layout.value === preferences.gitDiffLayout)?.label + ' · ' + (preferences.gitDiffWrap ? '自动换行' : '不换行')} defaultOpen>
        <PreferenceRow title="默认布局" description="应用于所有工作区。自适应会根据可用宽度切换布局。" control={<div className="settings-segments" role="group" aria-label="默认差异布局">
          {layouts.map(({ value, label }) => <button type="button" key={value} aria-pressed={preferences.gitDiffLayout === value}
            onClick={() => onChange('gitDiffLayout', value)}>{label}</button>)}
        </div>} />
        <PreferenceRow title="长行自动换行" control={<button type="button" role="switch" aria-label="长行自动换行" aria-checked={preferences.gitDiffWrap}
          className={'switch' + (preferences.gitDiffWrap ? ' is-on' : '')} onClick={() => onChange('gitDiffWrap', !preferences.gitDiffWrap)}><span /></button>} />
      </PreferenceGroup>
    </div>
  </div>;
}
