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
  head?: string;
  locked?: boolean;
};

export type WorktreeReview = { version: string; dirty: GitDirtyStatus; ignored: boolean; missing: boolean; head: string };
export type WorktreeInputs = {
  options: object;
  create: { mode: 'existing' | 'new'; name: string; folder: string; head: string };
  open: { path: string };
  inspect: { path: string; activeCwd: string };
  remove: { path: string; activeCwd: string; version: string };
};
export type WorktreeResults = {
  options: { head: string; branch: string; branches: { name: string; occupied: boolean }[] };
  create: string;
  open: string;
  inspect: WorktreeReview;
  remove: void;
};

export type GitWorkspaceStatus = {
  available: boolean;
  reason?: 'no-workspace' | 'invalid-workspace' | 'git-unavailable' | 'not-a-repository' | string;
  repositoryRoot?: string;
  branch?: string | null;
  commit?: string | null;
  dirty: GitDirtyStatus;
  upstream?: { name: string; ahead?: number; behind?: number };
  statusReadFailed?: boolean;
  worktree: {
    isWorktree: boolean;
    path?: string;
    branch?: string | null;
    mainPath?: string;
    name?: string;
  };
  worktrees: GitWorktree[];
};

export type GitTab = 'changes' | 'commit' | 'history' | 'sync';
export type GitHead = { branch: string; head: string };
export type GitBranchRef = { name: string; remote: boolean; worktree: string; upstreamRemote: string; upstreamBranch: string };
export type GitFile = { path: string; previousPath?: string; index: string; worktree: string; conflict: boolean };
export type GitState = GitHead & { root: string; files: GitFile[]; merging: boolean; indexVersion: string; remotes: string[]; upstreamRemote: string; upstreamBranch: string; ahead: number; behind: number; gone: boolean };
export type GitHistoryRow = { hash: string; graph: string; connectors: string[]; author: string; date: string; refs: string; subject: string };
export type GitCommit = { hash: string; parents: string[]; author: string; email: string; date: string; message: string; files: { path: string; previousPath?: string; code: string }[] };
export type GitDiffSource = { layer: 'commit'; path: string; hash: string } | { layer: 'index' | 'worktree'; path: string };
export type GitReadParams = {
  state: object;
  branches: object;
  history: { query?: string; offset?: number };
  detail: { hash: string };
  diff: GitDiffSource;
};
export type GitReadResult = {
  state: GitState;
  branches: GitHead & { root: string; branches: GitBranchRef[] };
  history: { rows: GitHistoryRow[]; more: boolean };
  detail: GitCommit;
  diff: import('./chat-types').TurnDiffFile;
};
export type GitAction =
  | { kind: 'switch' | 'create'; name: string; remoteBranch?: boolean }
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'commit'; message: string; indexVersion: string }
  | { kind: 'fetch' | 'pull' | 'push'; remote: string };
