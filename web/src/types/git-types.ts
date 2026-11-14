export type GitDirtyStatus = {
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
};

export type GitWorktree = {
  path: string;
  branch: string | null;
  detached: boolean;
};

export type GitWorkspaceStatus = {
  available: boolean;
  reason?: 'no-workspace' | 'invalid-workspace' | 'git-unavailable' | 'not-a-repository' | string;
  repositoryRoot?: string;
  branch?: string | null;
  commit?: string | null;
  dirty: GitDirtyStatus;
  worktree: {
    isWorktree: boolean;
    path?: string;
    branch?: string | null;
    mainPath?: string;
    name?: string;
  };
  worktrees: GitWorktree[];
};
