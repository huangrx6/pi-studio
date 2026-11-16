import { useEffect, useRef, useState, type RefObject } from 'react';
import { errorText } from '../../shared/error-text';
import type { GitAction, GitHead, GitReadParams, GitReadResult, GitState } from '../../types/git-types';

export const gitChangedEvent = 'pi-studio:git-changed';

export function useGitRevision(pollReady?: RefObject<boolean>) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    const timer = pollReady ? window.setInterval(() => { if (pollReady.current && !document.hidden) refresh(); }, 10_000) : undefined;
    window.addEventListener(gitChangedEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(gitChangedEvent, refresh);
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [pollReady]);
  return revision;
}

export function useGitRead<K extends keyof GitReadResult>(id: string | undefined, kind: K, params: GitReadParams[K], revision: number) {
  const key = JSON.stringify([id, kind, params]);
  const [result, setResult] = useState<{ key: string; revision: number; data?: GitReadResult[K]; error?: string }>();
  useEffect(() => {
    if (!id) return;
    let active = true;
    const input = { ...JSON.parse(key)[2], kind };
    window.piApi.gitRead<K>(id, input).then(data => {
      if (active) setResult({ key, revision, data });
    }, error => {
      if (active) setResult({ key, revision, error: errorText(error) });
    });
    return () => { active = false; };
  }, [id, key, kind, revision]);
  return { data: result?.key === key ? result.data : undefined, error: result?.key === key ? result.error : undefined,
    loading: !!id && (result?.key !== key || result.revision !== revision) };
}

export function useGitState(id: string, summaryOnly: boolean, revision: number) {
  const previous = useRef<{ id: string; data: GitState } | null>(null);
  const [result, setResult] = useState<{ id: string; summaryOnly: boolean; revision: number; data?: GitState; error?: string }>();
  useEffect(() => {
    let active = true;
    const cached = !summaryOnly && previous.current?.id === id ? previous.current.data : undefined;
    void window.piApi.gitRead(id, { kind: 'state', summaryOnly, knownFilesVersion: cached?.filesVersion }).then(next => {
      if (!active) return;
      const data = next.filesUnchanged && cached ? { ...next, files: cached.files } : next;
      if (!summaryOnly) previous.current = { id, data };
      setResult({ id, summaryOnly, revision, data });
    }, cause => { if (active) setResult({ id, summaryOnly, revision, error: errorText(cause) }); });
    return () => { active = false; };
  }, [id, summaryOnly, revision]);
  const current = result?.id === id && result.summaryOnly === summaryOnly ? result : undefined;
  return { data: current?.data, error: current?.error, loading: current?.revision !== revision };
}

export function useGitAction(id: string) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(position: GitHead, action: GitAction) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await window.piApi.gitWrite(id, { ...action, branch: position.branch, head: position.head });
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
