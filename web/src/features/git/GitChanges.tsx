import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleCheck, FileCheck2, FilePenLine, Files, GitBranch, GitCommitHorizontal, History, Minus, Plus, TriangleAlert } from 'lucide-react';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { GitAction, GitFile, GitState } from '../../types/git-types';
import { GitFileDiff } from './GitFileDiff';
import { GitFileList } from './GitFileList';

type Execute = (action: GitAction) => Promise<boolean>;
type Layer = 'index' | 'worktree';
type Selection = { layer: Layer; path: string };
const changeNames: Record<string, string> = { A: '新增', D: '删除', M: '修改', R: '重命名', C: '复制', T: '类型变更', '?': '未跟踪' };

function CommitForm({ sessionId, state, focus, disabled, busy, staged, conflicts, execute }: {
  sessionId: string; state: GitState; focus: boolean; disabled: boolean; busy: boolean; staged: number; conflicts: boolean; execute: Execute;
}) {
  const key = 'pi-studio:git-message:' + sessionId + '/' + state.branch;
  const [message, setMessage] = useState(() => sessionStorage.getItem(key) || '');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  function update(value: string) {
    setMessage(value);
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  }
  return <form className="git-commit-form" onSubmit={async e => {
    e.preventDefault();
    if (await execute({ kind: 'commit', message, indexVersion: state.indexVersion })) update('');
  }}>
    <div className="git-commit-caption"><label htmlFor="git-commit-message">提交说明</label>
      <span className="git-commit-target" title={state.branch || state.head}><GitBranch />{state.branch || '游离 HEAD'}</span>
    </div>
    <textarea id="git-commit-message" ref={input} value={message} maxLength={32000} rows={2}
      placeholder="简述本次修改…" readOnly={busy} onChange={e => update(e.target.value)} />
    <div className="git-commit-footer">
      <small>{staged ? `已暂存 ${staged} 项` : '暂无暂存修改'}</small>
      <button type="submit" className="git-primary" aria-label={state.merging ? '提交合并' : '提交暂存的修改'}
        disabled={disabled || !message.trim() || conflicts || (!staged && !state.merging)}>
        <GitCommitHorizontal />{state.merging ? '提交合并' : '提交'}
      </button>
    </div>
  </form>;
}

export function GitChanges({ state, sessionId, revision, focusCommit, disabled, busy, execute, openHistory, openFile, actionError }: {
  state: GitState; sessionId: string; revision: number; focusCommit: boolean; disabled: boolean; busy: boolean; execute: Execute; openHistory: () => void;
  openFile: (root: string, path: string) => void; actionError: string;
}) {
  const [selection, setSelection] = useState<Selection>();
  const [aborting, setAborting] = useState('');
  const [attemptedAbort, setAttemptedAbort] = useState(false);
  const groups = useMemo(() => [
    { title: '合并冲突', icon: TriangleAlert, files: state.files.filter(file => file.conflict), layer: 'worktree' as const, conflict: true },
    { title: '工作区', icon: Files, files: state.files.filter(file => !file.conflict && file.worktree !== ' '), layer: 'worktree' as const },
    { title: '暂存区', icon: FileCheck2, files: state.files.filter(file => !file.conflict && ![' ', '?'].includes(file.index)), layer: 'index' as const },
  ], [state.files]);
  // Follow a file across staging and unstaging. A partially staged file can appear in both layers.
  const selectedGroup = (selection && (groups.find(group => group.layer === selection.layer && group.files.some(file => file.path === selection.path))
    || groups.find(group => group.files.some(file => file.path === selection.path)))) || groups.find(group => group.files.length);
  const selectedFile = (selection && selectedGroup?.files.find(file => file.path === selection.path)) || selectedGroup?.files[0];
  const clean = !state.files.length && !state.merging;
  if (clean && !focusCommit) return <div className="git-clean">
    <CircleCheck aria-hidden="true" /><h3>工作区干净</h3>
    <p>{state.head ? '所有修改均已提交。' : '仓库中还没有可提交的文件。'}</p>
    {state.head && <button type="button" onClick={openHistory}><History />查看提交历史</button>}
  </div>;
  return <>
    {state.merging && <div className="git-merge-notice"><TriangleAlert /><span role="status">{groups[0].files.length
      ? '打开冲突文件，编辑并保存要保留的内容，再标记为已解决。全部处理后可提交合并。' : '所有冲突已解决，可以提交合并。'}</span>
      <button type="button" disabled={disabled} onClick={() => { setAttemptedAbort(false); setAborting(state.mergeHead); }}>中止合并</button></div>}
    {aborting && <SettingsDialog title="中止本次合并？" description="将放弃本次合并中已做的冲突处理，返回合并前的分支状态。"
      action="确认中止" busy={busy} loading={false} unavailable={disabled} error={attemptedAbort ? actionError : null} onClose={() => setAborting('')}
      onSubmit={async () => { setAttemptedAbort(true); if (await execute({ kind: 'abortMerge', mergeHead: aborting })) setAborting(''); }}>{null}</SettingsDialog>}
    <div className="git-review">
      <div className="git-index">
        <div className="git-groups">{groups.map(({ title, icon: GroupIcon, files, layer, conflict }) => {
          if (conflict && !files.length) return null;
          const unstaging = layer === 'index';
          function change(list: GitFile[]) {
            if (selectedFile && selectedGroup?.layer === layer && list.some(file => file.path === selectedFile.path)) {
              setSelection({ layer, path: selectedFile.path });
            }
            return execute({ kind: unstaging ? 'unstage' : 'stage', paths: list.map(file => file.path) });
          }
          const verb = conflict ? '标记为已解决' : unstaging ? '取消暂存' : '暂存';
          const Icon = conflict ? Check : unstaging ? Minus : Plus;
          return <section key={title} aria-label={title} className="git-file-group">
            <header><h3><GroupIcon />{title}<small>{files.length}</small></h3>
              {!!files.length && !conflict && <button type="button" disabled={disabled} onClick={() => void change(files)}>{unstaging ? '全部取消暂存' : '全部暂存'}</button>}
            </header>
            {!files.length && <p>{unstaging ? '暂无暂存修改' : '没有待暂存的文件'}</p>}
            <GitFileList files={files} className="git-file-list">{file => {
              const slash = file.path.lastIndexOf('/');
              const code = conflict ? 'U' : unstaging ? file.index : file.worktree;
              const label = conflict ? '冲突' : changeNames[code] || code;
              const selected = selectedFile?.path === file.path && selectedGroup?.layer === layer;
              return <div className="git-file-row" data-selected={selected || undefined} key={file.path}>
                <button className="git-file-name" type="button" aria-pressed={selected} aria-label={file.path + ' ' + label}
                  title={file.previousPath ? file.previousPath + ' → ' + file.path : file.path} onClick={() => setSelection({ layer, path: file.path })}>
                  <FileKindIcon path={file.path} />
                  <span className="git-path"><span>{file.path.slice(slash + 1)}</span>{slash >= 0 && <small>{file.path.slice(0, slash)}</small>}</span>
                  <span className="git-file-status" data-code={code}>{label}</span>
                </button>
                {conflict && <button type="button" className="git-file-action" title="打开冲突文件" aria-label={'打开冲突文件 ' + file.path}
                  onClick={() => openFile(state.root, file.path)}><FilePenLine /></button>}
                <button type="button" className="git-file-action" disabled={disabled} title={verb} aria-label={verb + ' ' + file.path} onClick={() => void change([file])}><Icon /></button>
              </div>;
            }}</GitFileList>
          </section>;
        })}</div>
        <CommitForm sessionId={sessionId} state={state} staged={groups[2].files.length} conflicts={!!groups[0].files.length} focus={focusCommit} disabled={disabled} busy={busy} execute={execute} />
      </div>
      <div className="git-review-preview">{selectedGroup && selectedFile
        ? <GitFileDiff sessionId={sessionId} source={{ layer: selectedGroup.layer, path: selectedFile.path, previousPath: selectedFile.previousPath || '' }} revision={revision} />
        : <p className="git-review-empty"><CircleCheck />没有待审阅的文件</p>}</div>
    </div>
  </>;
}
