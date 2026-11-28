import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { errorText } from '../../shared/error-text';
import type { GitRepository } from '../../types/git-types';

export function useWorkspaceRepositories(cwd = '') {
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ cwd: string; revision: number; items: GitRepository[]; error?: string }>();
  const [choice, setChoice] = useState<{ cwd: string; id: string }>();
  const known = useRef(new Map<string, GitRepository[]>());
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (!cwd) return;
    let active = true;
    async function discover() {
      try {
        const items = await window.piApi.gitRepositories(cwd);
        if (active) {
          known.current.set(cwd, items);
          setRead({ cwd, revision, items });
        }
      } catch (error) {
        if (active) setRead({ cwd, revision, items: [], error: errorText(error) });
      }
    }
    void discover();
    return () => { active = false; };
  }, [cwd, revision]);
  useEffect(() => (
    window.piApi.onWorkbenchRefresh?.(event => {
      if (event.scope !== 'all' && event.scope !== 'git') return;
      refresh();
      window.dispatchEvent(new Event('pi-studio:git-changed'));
    })
  ), [refresh]);
  const storageKey = 'pi-studio:git-repository:' + cwd;
  const select = (id: string) => {
    sessionStorage.setItem(storageKey, id);
    setChoice({ cwd, id });
  };
  const current = read?.cwd === cwd ? read : undefined;
  const repositories = current?.items || known.current.get(cwd) || [];
  const preferred = choice?.cwd === cwd ? choice.id : sessionStorage.getItem(storageKey);
  const selected = repositories.find(repo => repo.id === preferred) || repositories[0];
  const ready = !cwd || current !== undefined;
  return { cwd, repositories, selected, select, refresh, ready, loading: !!cwd && current?.revision !== revision, error: current?.error };
}

export const GitRepositoryContext = createContext<ReturnType<typeof useWorkspaceRepositories> | null>(null);
export function useGitRepositories() {
  const repositories = useContext(GitRepositoryContext);
  if (!repositories) throw new Error('缺少工作区仓库信息。');
  return repositories;
}
