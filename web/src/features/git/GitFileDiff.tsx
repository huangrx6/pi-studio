import { createContext, useContext } from 'react';
import { DiffView } from '../conversation/DiffView';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { DEFAULT_PREFERENCES, type GitDiffPreferences } from '../../shared/preferences';
import type { GitDiffSource } from '../../types/git-types';
import { useGitRead } from './useGitTools';

export const GitDiffDefaults = createContext<GitDiffPreferences>(DEFAULT_PREFERENCES);

export function GitFileDiff({ sessionId, source, revision }: { sessionId: string; source: GitDiffSource; revision: number }) {
  const { data, error } = useGitRead(sessionId, 'diff', source, revision);
  const { gitDiffLayout, gitDiffWrap } = useContext(GitDiffDefaults);
  return <section className="git-file-diff" aria-label={'文件差异 ' + source.path}>
    {data && (data.patch && !data.binary && !/^@@ /m.test(data.patch)
      ? <><div className="diff-view-head"><FileKindIcon path={source.path} /><strong title={source.path}>{source.path}</strong></div>
        <pre className="git-diff-metadata">{data.patch}</pre></> : <DiffView key={gitDiffLayout} file={data} responsive
          options={{ layout: gitDiffLayout, wrap: gitDiffWrap, wordDiff: true, hideImports: false }} />)}
    {!data && <p role={error ? 'alert' : 'status'}>{error || '正在读取差异…'}</p>}
  </section>;
}
