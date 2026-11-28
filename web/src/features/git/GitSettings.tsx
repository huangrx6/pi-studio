import { useContext, useEffect, useState } from 'react';
import { FileDiff, Folder, PanelRightOpen, RotateCw } from 'lucide-react';
import { BranchIcon } from './git-icons';
import { HintButton } from '../../shared/HintButton';
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

function RepositoryStatus({ cwd, repository, revision, status }: {
  cwd: string; repository: string; revision: number; status: GitWorkspaceStatus;
}) {
  const { dirty } = status;
  const summary = status.statusReadFailed ? '变更读取失败' : dirty.total ? dirty.total + ' 个文件有变更' : '工作区干净';
  return <PreferenceGroup title="仓库状态" summary={summary} lazy>
    <dl className="git-settings-refs">
      {status.repositoryRoot && <div><dt>仓库目录</dt><dd><GitDirectory path={status.repositoryRoot} /></dd></div>}
      <div><dt>{status.branch ? '当前分支' : '当前提交'}</dt><dd><span>{status.branch || (status.commit ? '游离 HEAD' : '尚无提交')}</span>
        {status.commit ? <code title="当前提交">{status.commit}</code> : status.branch && <small>尚无提交</small>}</dd></div>
      <div><dt>上游分支</dt><dd title="根据最近获取的上游引用计算">{upstreamStatus(status)}</dd></div>
    </dl>
    {status.statusReadFailed ? <p className="git-change-summary">未能读取文件变更，请刷新仓库状态。</p>
      : dirty.total > 0 && <>
        <p className="git-change-summary">已暂存 {dirty.staged} · 未暂存 {dirty.unstaged} · 未跟踪 {dirty.untracked}</p>
        <ChangedFiles cwd={cwd} repository={repository} revision={revision} />
      </>}
  </PreferenceGroup>;
}

type StatusRead = { key: string; revision: number; status?: GitWorkspaceStatus; error?: string };
const cachedGitReads = new Map<string, StatusRead>();

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
  const other = useWorkspaceRepositories(conversation?.cwd === target ? '' : target);
  const repositories = conversation?.cwd === target ? conversation : other;
  const repository = repositories.selected;
  const key = JSON.stringify([target, repository?.id]);
  const revision = useGitRevision();
  const [read, setRead] = useState<StatusRead | undefined>(() => cachedGitReads.get(key));
  const canRead = !!target && (!!repository || (!repositories.loading && !repositories.error));
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    window.piApi.gitWorkspaceStatus(target, repository?.id).then(
      status => {
        if (!active) return;
        const next = { key, revision, status };
        cachedGitReads.set(key, next);
        setRead(next);
      },
      error => {
        if (active) setRead({ key, revision, error: errorText(error) });
      },
    );
    return () => { active = false; };
  }, [target, revision, key, repository?.id, canRead]);
  const current = (read?.key === key ? read : undefined) ?? cachedGitReads.get(key);
  const loading = repositories.loading || (canRead && current?.revision !== revision);
  const error = repositories.error || current?.error;
  const status = current?.status;
  function refresh() {
    repositories.refresh();
    window.dispatchEvent(new Event(gitChangedEvent));
  }
  return <div className="settings-preference-page git-settings">
    <SettingsPageHeader iconPosition="end" title="Git" icon={<BranchIcon aria-hidden="true" />} />
    <div className="settings-preference-groups">
      <GitRepositoryContext.Provider value={repositories}>
        <div className="git-settings-scope" role="group" aria-label="工作区和仓库">
          <span className="git-scope-label">工作区</span>
          {options.length > 1 ? <Select label="工作区" leadingIcon={<Folder />} value={target} options={options} onChange={setPicked} />
            : <span className="git-scope-name" title={target}><Folder aria-hidden="true" />{selected?.label || '尚未选择'}</span>}
          <GitRepositoryPicker label="设置中的项目仓库" />
          <div className="git-scope-actions">
            {status?.available && conversation?.cwd === target && onOpenChanges &&
              <HintButton className="icon-button" aria-label="打开 Git 面板" onClick={onOpenChanges}><PanelRightOpen aria-hidden="true" /></HintButton>}
            <HintButton className="icon-button" aria-label="刷新 Git 状态" disabled={!target || loading} onClick={refresh}>
              <RotateCw className={loading ? 'spin' : ''} aria-hidden="true" /></HintButton>
          </div>
        </div>
        {error ? <div className="git-settings-message"><p role="alert" className="settings-error">{error}</p>
          <button type="button" className="settings-outline" onClick={refresh}>重试</button></div>
          : loading && !current ? <LoadingState variant="section">正在读取仓库状态…</LoadingState>
          : status?.available && repository ? <>
            <WorktreeSettings key={key} cwd={target} repository={repository.id} activeCwd={cwd} status={status} onOpen={onOpenWorktree} />
            <RepositoryStatus key={'status:' + key} cwd={target} repository={repository.id} revision={revision} status={status} />
          </> : <div className="git-settings-message"><p>{!target ? unavailable['no-workspace'] : unavailable[status?.reason || 'not-a-repository'] || '无法读取当前仓库。'}</p>
            <button type="button" className="settings-outline" onClick={onChooseWorkspace}>打开工作区</button></div>}
      </GitRepositoryContext.Provider>
      <PreferenceGroup title="差异显示" description="适用于所有工作区。">
        <PreferenceRow title="默认布局" description="自适应会随面板宽度切换布局。" control={<div className="settings-segments" role="group" aria-label="默认差异布局">
          {layouts.map(({ value, label }) => <button type="button" key={value} aria-pressed={preferences.gitDiffLayout === value}
            onClick={() => onChange('gitDiffLayout', value)}>{label}</button>)}
        </div>} />
        <PreferenceRow title="长行自动换行" control={<button type="button" role="switch" aria-label="长行自动换行" aria-checked={preferences.gitDiffWrap}
          className={'switch' + (preferences.gitDiffWrap ? ' is-on' : '')} onClick={() => onChange('gitDiffWrap', !preferences.gitDiffWrap)}><span /></button>} />
      </PreferenceGroup>
    </div>
  </div>;
}
