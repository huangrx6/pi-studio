import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitWorkspaceStatus } from '../types/git-types';

const EMPTY_STATUS: GitWorkspaceStatus = {
  available: false,
  reason: 'no-workspace',
  dirty: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
  worktree: { isWorktree: false },
  worktrees: [],
};

/**
 * Reads Git state for the active directory and refreshes it while the
 * conversation is visible. The directory is part of the request key, so
 * switching sessions/workspaces immediately discards the previous status.
 */
export function useGitWorkspaceStatus(cwd?: string, repository?: string) {
  const [result, setResult] = useState<{ cwd?: string; repository?: string; status: GitWorkspaceStatus }>();
  const requestRef = useRef(0);
  const reading = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!cwd?.trim() || !repository) {
      setResult({ cwd, repository, status: EMPTY_STATUS });
      return EMPTY_STATUS;
    }
    reading.current = request;
    try {
      const next = await window.piApi.gitWorkspaceStatus(cwd, repository);
      if (request === requestRef.current) setResult({ cwd, repository, status: next });
      return next;
    } catch (error) {
      const next = { ...EMPTY_STATUS, reason: error instanceof Error ? error.message : 'git-status-error' };
      if (request === requestRef.current) setResult({ cwd, repository, status: next });
      return next;
    } finally {
      if (reading.current === request) reading.current = 0;
    }
  }, [cwd, repository]);

  useEffect(() => {
    requestRef.current += 1;
    void refresh();
    if (!cwd?.trim() || !repository) return undefined;
    const onVisibilityChange = () => {
      if (!reading.current && document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(onVisibilityChange, 10_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const onChanged = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('pi-studio:git-changed', onChanged);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pi-studio:git-changed', onChanged);
      requestRef.current += 1;
    };
  }, [cwd, repository, refresh]);

  return { status: result && result.cwd === cwd && result.repository === repository ? result.status : null, refresh };
}
