import { useEffect, useRef, useState } from 'react';
import { Check, CircleCheck, FileCheck2, Files, FolderOpen, GitBranch, GitCommitHorizontal, History, Minus, Plus, TriangleAlert } from 'lucide-react';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { errorText } from '../../shared/error-text';
import type { GitAction, GitFile, GitState } from '../../types/git-types';
import { GitFileDiff } from './GitFileDiff';

type Execute = (action: GitAction) => Promise<boolean>;
type Layer = 'index' | 'worktree';
type Selection = { layer: Layer; path: string };
const changeNames: Record<string, string> = { A: '新增', D: '删除', M: '修改', R: '重命名', C: '复制', T: '类型变更', '?': '未跟踪' };

function CommitForm({ sessionId, state, focus, disabled, busy, staged, execute }: {
  sessionId: string; state: GitState; focus: boolean; disabled: boolean; busy: boolean; staged: GitFile[]; execute: Execute;
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
  const conflicts = state.files.some(file => file.conflict);
  return <form className="git-commit-form" onSubmit={async e => {
    e.preventDefault();
    if (await execute({ kind: 'commit', message, indexVersion: state.indexVersion })) update('');
  }}>
    <label htmlFor="git-commit-message">提交说明</label>
    <div className="git-message-editor">
      <textarea id="git-commit-message" ref={input} value={message} maxLength={32000} rows={2}
        placeholder="简述本次修改…" readOnly={busy} onChange={e => update(e.target.value)} />
      <div className="git-commit-footer">
        <span className="git-commit-target" title={state.branch || state.head}><GitBranch />{state.branch || '游离 HEAD'}</span>
        <button type="submit" className="git-primary" aria-label={state.merging ? '提交合并' : '提交暂存的修改'}
          disabled={disabled || !message.trim() || conflicts || (!staged.length && !state.merging)}>
          <GitCommitHorizontal />{state.merging ? '提交合并' : '提交'}
        </button>
      </div>
    </div>
  </form>;
}

export function GitChanges({ state, sessionId, revision, focusCommit, disabled, busy, execute, openHistory }: {
  state: GitState; sessionId: string; revision: number; focusCommit: boolean; disabled: boolean; busy: boolean; execute: Execute; openHistory: () => void;
}) {
  const [selection, setSelection] = useState<Selection>();
  const [fileError, setFileError] = useState('');
  async function reveal(path: string) {
    setFileError('');
    try { await window.piApi.revealFile({ cwd: state.root, path }); }
    catch (error) { setFileError(errorText(error)); }
  }
  const staged = state.files.filter(file => !file.conflict && ![' ', '?'].includes(file.index));
  const groups = [
    { title: '合并冲突', icon: TriangleAlert, files: state.files.filter(file => file.conflict), layer: 'worktree' as const, conflict: true },
    { title: '工作区', icon: Files, files: state.files.filter(file => !file.conflict && file.worktree !== ' '), layer: 'worktree' as const },
    { title: '暂存区', icon: FileCheck2, files: staged, layer: 'index' as const },
  ];
  // Follow a file across staging and unstaging. A partially staged file can appear in both layers.
  const selectedGroup = groups.find(group => group.layer === selection?.layer && group.files.some(file => file.path === selection.path))
    || groups.find(group => group.files.some(file => file.path === selection?.path))
    || groups.find(group => group.files.length);
  const selectedFile = selectedGroup?.files.find(file => file.path === selection?.path) || selectedGroup?.files[0];
  const clean = !state.files.length && !state.merging;
  if (clean && !focusCommit) return <div className="git-clean">
    <CircleCheck aria-hidden="true" /><h3>工作区干净</h3>
    <p>{state.head ? '所有修改均已提交。' : '仓库中还没有可提交的文件。'}</p>
    {state.head && <button type="button" onClick={openHistory}><History />查看提交历史</button>}
  </div>;
  return <>
    {fileError && <p role="alert" className="git-feedback">{fileError}</p>}
    {state.merging && <p className="git-merge-notice" role="status"><TriangleAlert />{groups[0].files.length
      ? '请在编辑器中解决冲突，逐个标记为已解决后提交合并。' : '所有冲突已解决，可以提交合并。'}</p>}
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
            <div className="git-file-list">{files.map(file => {
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
                {conflict && <button type="button" className="git-file-action" title="在文件夹中显示冲突文件" aria-label={'定位冲突文件 ' + file.path} onClick={() => void reveal(file.path)}><FolderOpen /></button>}
                <button type="button" className="git-file-action" disabled={disabled} title={verb} aria-label={verb + ' ' + file.path} onClick={() => void change([file])}><Icon /></button>
              </div>;
            })}</div>
          </section>;
        })}</div>
        <CommitForm sessionId={sessionId} state={state} staged={staged} focus={focusCommit} disabled={disabled} busy={busy} execute={execute} />
      </div>
      <div className="git-review-preview">{selectedGroup && selectedFile
        ? <GitFileDiff sessionId={sessionId} source={{ layer: selectedGroup.layer, path: selectedFile.path }} revision={revision} />
        : <p className="git-review-empty"><CircleCheck />没有待审阅的文件</p>}</div>
    </div>
  </>;
}
