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
export function useGitWorkspaceStatus(cwd?: string) {
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!cwd?.trim()) {
      setStatus(EMPTY_STATUS);
      return EMPTY_STATUS;
    }
    try {
      const next = await window.piApi.gitWorkspaceStatus(cwd);
      if (request === requestRef.current) setStatus(next);
      return next;
    } catch (error) {
      const next = { ...EMPTY_STATUS, reason: error instanceof Error ? error.message : 'git-status-error' };
      if (request === requestRef.current) setStatus(next);
      return next;
    }
  }, [cwd]);

  useEffect(() => {
    requestRef.current += 1;
    setStatus(null);
    void refresh();
    if (!cwd?.trim()) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      requestRef.current += 1;
    };
  }, [cwd, refresh]);

  return { status, refresh };
}
