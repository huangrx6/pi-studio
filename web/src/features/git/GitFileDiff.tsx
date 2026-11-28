import { createContext, useContext, useState } from 'react';
import { Eye } from 'lucide-react';
import './styles/git-file-diff.css';
import { DiffView } from '../conversation/DiffView';
import { DeferredFilePreview } from '../../shared/DeferredFilePreview';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import { prefersFilePreview } from '../../shared/file-preview';
import { DEFAULT_PREFERENCES, type GitDiffPreferences } from '../../shared/preferences';
import type { GitDiffSource, GitFileSide } from '../../types/git-types';
import { useGitRead, useGitRevision } from './useGitTools';
import { useGitRepositories } from './useWorkspaceRepositories';

export const GitDiffDefaults = createContext<GitDiffPreferences>(DEFAULT_PREFERENCES);

const versionNames = {
  commit: { before: '父提交版本', after: '提交版本' },
  index: { before: 'HEAD 版本', after: '暂存版本' },
  worktree: { before: '暂存版本', after: '工作区版本' },
};
type Props = { sessionId: string; source: GitDiffSource; revision: number };

function VersionPreview({ sessionId, source, side }: Omit<Props, 'revision'> & { side: GitFileSide }) {
  const { selected } = useGitRepositories();
  const [retry, setRetry] = useState(0);
  const [openError, setOpenError] = useState('');
  const { data, error } = useGitRead(sessionId, 'preview', { ...source, side }, retry);
  if (error) return <p role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>;
  const openWorkingFile = selected && source.layer === 'worktree' && side === 'after' && data?.mimeType !== 'inode/symlink' && data?.mimeType !== 'application/x-gitlink'
    ? () => { void window.piApi.openWith({ cwd: selected.root, path: source.path, source: 'workspace' }).catch(cause => setOpenError(errorText(cause))); } : undefined;
  return <>{openError && <p role="alert">{openError}</p>}
    <DeferredFilePreview file={data || null} loading={!data} onOpenExternal={openWorkingFile} /></>;
}

function FileReview({ sessionId, source, revision }: Props) {
  const { data, error } = useGitRead(sessionId, 'diff', source, revision);
  const { selected, repositories, select } = useGitRepositories();
  const { gitDiffLayout, gitDiffWrap } = useContext(GitDiffDefaults);
  const [mode, setMode] = useState<'diff' | 'preview'>();
  const [side, setSide] = useState<GitFileSide>();
  if (!data) return error ? <p role="alert">{error}</p> : <LoadingState variant="panel">正在读取差异…</LoadingState>;
  const target = selected?.root.replace(/\\/g, '/').replace(/\/$/, '') + '/' + source.path.replace(/\/$/, '');
  const nested = repositories.find(repo => repo.root.replace(/\\/g, '/') === target);
  const canDiff = !data.binary && data.patch !== '嵌套 Git 仓库';
  const preview = !canDiff || (mode ? mode === 'preview' : !!nested || prefersFilePreview(source.path));
  const activeSide = side && data.sides.includes(side) ? side : data.sides.at(-1);
  const labels = { ...versionNames[source.layer] };
  if (data.beforeStage) labels.before = ['', '共同祖先版本', '本地版本', '对方版本'][data.beforeStage];
  if (preview && activeSide) return <>
    <div className="git-preview-tools">
      <div role="group" aria-label="文件版本">{data.sides.map(item => data.sides.length === 1
        ? <span key={item}>{labels[item]}</span>
        : <button type="button" key={item} aria-pressed={item === activeSide} onClick={() => setSide(item)}>{labels[item]}</button>)}</div>
      {canDiff && <button type="button" onClick={() => setMode('diff')}>查看差异</button>}
      {nested && <button type="button" className="text-button" onClick={() => select(nested.id)}>打开子仓库</button>}
    </div>
    <VersionPreview key={activeSide + data.previewVersion} sessionId={sessionId} source={source} side={activeSide} />
  </>;
  const showPreview = <button type="button" className="icon-button" aria-label="文件预览" title="文件预览" onClick={() => setMode('preview')}><Eye /></button>;
  if (data.patch && !/^@@ /m.test(data.patch)) return <><div className="diff-view-head"><FileKindIcon path={source.path} /><strong title={source.path}>{source.path}</strong>{showPreview}</div>
    <pre className="git-diff-metadata">{data.patch}</pre></>;
  return <DiffView key={gitDiffLayout} file={data} responsive actions={showPreview} options={{ layout: gitDiffLayout, wrap: gitDiffWrap, wordDiff: true, hideImports: false }} />;
}

export function GitFileDiff(props: Omit<Props, 'revision'>) {
  const revision = useGitRevision();
  return <section className="git-file-diff" aria-label={'文件差异 ' + props.source.path}>
    <FileReview key={JSON.stringify(props.source)} {...props} revision={revision} />
  </section>;
}
