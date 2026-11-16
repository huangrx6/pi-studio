import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../shared/error-text';
import type { GitAction, GitHead, GitReadParams, GitReadResult } from '../../types/git-types';

export const gitChangedEvent = 'pi-studio:git-changed';

export function useGitRevision(poll = false) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    const timer = poll ? window.setInterval(() => { if (!document.hidden) refresh(); }, 10_000) : undefined;
    window.addEventListener(gitChangedEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(gitChangedEvent, refresh);
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [poll]);
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
