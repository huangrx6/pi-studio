import { useEffect, useRef, useState, type RefObject } from 'react';
import { errorText } from '../../shared/error-text';
import { useSurfaceActive } from '../../shared/surface-visibility';
import type { GitAction, GitHead, GitReadParams, GitReadResult, GitState } from '../../types/git-types';
import { useGitRepositories } from './useWorkspaceRepositories';

export const gitChangedEvent = 'pi-studio:git-changed';

export function useGitRevision(pollReady?: RefObject<boolean>) {
  const active = useSurfaceActive();
  const wasActive = useRef(active);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const resumed = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    const refresh = () => setRevision(n => n + 1);
    if (resumed) refresh();
    const timer = pollReady ? window.setInterval(() => { if (pollReady.current && !document.hidden) refresh(); }, 10_000) : undefined;
    window.addEventListener(gitChangedEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(gitChangedEvent, refresh);
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [active, pollReady]);
  return revision;
}

export function useGitRead<K extends keyof GitReadResult>(id: string | undefined, kind: K, params: GitReadParams[K], revision: number) {
  const repository = useGitRepositories().selected?.id;
  const key = JSON.stringify([id, kind, params, repository]);
  const [result, setResult] = useState<{ key: string; revision: number; data?: GitReadResult[K]; error?: string }>();
  useEffect(() => {
    if (!id || !repository) return;
    let active = true;
    const input = { ...JSON.parse(key)[2], kind, repository };
    window.piApi.gitRead<K>(id, input).then(data => {
      if (active) setResult({ key, revision, data });
    }, error => {
      if (active) setResult({ key, revision, error: errorText(error) });
    });
    return () => { active = false; };
  }, [id, key, kind, repository, revision]);
  return { data: result?.key === key ? result.data : undefined, error: result?.key === key ? result.error : undefined,
    loading: !!id && (result?.key !== key || result.revision !== revision) };
}

export function useGitState(id: string, summaryOnly: boolean, revision: number) {
  const repository = useGitRepositories().selected?.id;
  const scope = JSON.stringify([id, repository]);
  const previous = useRef<{ scope: string; data: GitState } | null>(null);
  const [result, setResult] = useState<{ scope: string; summaryOnly: boolean; revision: number; data?: GitState; error?: string }>();
  useEffect(() => {
    if (!repository) return;
    let active = true;
    const cached = !summaryOnly && previous.current?.scope === scope ? previous.current.data : undefined;
    void window.piApi.gitRead(id, { kind: 'state', repository, summaryOnly, knownFilesVersion: cached?.filesVersion }).then(next => {
      if (!active) return;
      const data = next.filesUnchanged && cached ? { ...next, files: cached.files } : next;
      if (!summaryOnly) previous.current = { scope, data };
      setResult({ scope, summaryOnly, revision, data });
    }, cause => { if (active) setResult({ scope, summaryOnly, revision, error: errorText(cause) }); });
    return () => { active = false; };
  }, [id, repository, scope, summaryOnly, revision]);
  const current = result?.scope === scope && result.summaryOnly === summaryOnly ? result : undefined;
  return { data: current?.data, error: current?.error, loading: current?.revision !== revision };
}

export function useGitAction(id: string) {
  const repository = useGitRepositories().selected?.id;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(position: GitHead, action: GitAction) {
    if (!repository || lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await window.piApi.gitWrite(id, { ...action, repository, branch: position.branch, head: position.head });
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
      window.dispatchEvent(new Event(gitChangedEvent));
    }
  }
  return { act, busy, error };
}
