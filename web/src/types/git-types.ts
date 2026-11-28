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
  unavailable?: 'prunable' | 'bare' | 'inaccessible';
};

export type WorktreeReview = { version: string; dirty: GitDirtyStatus; ignored: boolean; missing: boolean; head: string };
export type WorktreeInputs = {
  list: object;
  options: object;
  create: { mode: 'existing' | 'new'; name: string; folder: string; parent?: string; head: string; baseBranch?: string };
  open: { path: string; expectedBranch?: string };
  inspect: { path: string; activeCwd: string };
  remove: { path: string; activeCwd: string; version: string };
};
export type WorktreeResults = {
  list: GitWorktree[];
  options: { head: string; branch: string; branches: { name: string; head: string; occupied: boolean }[] };
  create: string;
  open: string;
  inspect: WorktreeReview;
  remove: void;
};

export type GitRepository = { id: string; name: string; root: string };
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

export type GitTab = 'changes' | 'history' | 'sync';
export type GitHead = { branch: string; head: string };
export type GitBranchRef = { name: string; head: string; remote: boolean; worktree: string; upstreamRemote: string; upstreamBranch: string };
export type GitBranches = GitHead & { root: string; branches: GitBranchRef[] };
export type GitCheckout = GitHead & { repository: string; kind: 'switch' | 'create'; name: string; remoteBranch?: boolean };
export type GitFile = { path: string; previousPath?: string; index: string; worktree: string; conflict: boolean };
export type GitState = GitHead & { root: string; files: GitFile[]; filesVersion: string; filesUnchanged: boolean; merging: boolean; mergeHead: string; indexVersion: string; remotes: string[]; upstreamRemote: string; upstreamBranch: string; ahead: number; behind: number; gone: boolean };
export type GitHistoryRow = { hash: string; graph: string; connectors: string[]; author: string; date: string; refs: string; subject: string };
export type GitCommit = { hash: string; parents: string[]; author: string; email: string; date: string; message: string; files: { path: string; previousPath?: string; code: string }[] };
export type GitRemoteInfo = { name: string; fetchUrls: string[]; pushUrls: string[]; editableFetch: string; editablePush: string; explicitPush: boolean; version: string };
export type GitSyncKind = 'pull' | 'push';
export type GitSyncPreview = GitHead & { remote: string; operation: GitSyncKind; target: string; remoteHead: string; address: string;
  setUpstream: boolean; incoming: number; outgoing: number; dirty: boolean; mergeMode: 'ff' | 'ff-only' | 'no-ff'; version: string };
export type GitDiffSource = { path: string; previousPath?: string } & ({ layer: 'commit'; hash: string } | { layer: 'index' | 'worktree' });
export type GitFileSide = 'before' | 'after';
export type GitReadParams = {
  state: { summaryOnly?: boolean; knownFilesVersion?: string };
  history: { query?: string; offset?: number };
  detail: { hash: string };
  remoteInfo: { remote: string };
  syncPreview: { operation: GitSyncKind; remote: string; targetIndex?: number; remoteVersion?: string };
  syncCommits: { tip: string; exclude: string; offset: number };
  diff: GitDiffSource;
  preview: GitDiffSource & { side: GitFileSide };
};
export type GitReadResult = {
  state: GitState;
  history: { rows: GitHistoryRow[]; more: boolean; total: number; pageSize: number; offset: number };
  detail: GitCommit;
  remoteInfo: GitRemoteInfo;
  syncPreview: GitSyncPreview;
  syncCommits: { hash: string; subject: string }[];
  diff: import('./chat-types').TurnDiffFile & { sides: GitFileSide[]; beforeStage?: 1 | 2 | 3; previewVersion: string };
  preview: import('./file-preview-types').FilePreviewResult;
};
export type GitAction =
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'commit'; message: string; indexVersion: string }
  | { kind: 'abortMerge'; mergeHead: string }
  | { kind: 'fetch'; remote: string }
  | { kind: GitSyncKind; remote: string; version: string; force?: boolean; targetIndex?: number }
  | { kind: 'remoteAdd'; name: string; url: string }
  | { kind: 'remoteRename'; remote: string; name: string; version: string }
  | { kind: 'remoteEdit'; remote: string; field: 'push' | 'fetch'; url: string; version: string }
  | { kind: 'remoteRemove'; remote: string; version: string };
