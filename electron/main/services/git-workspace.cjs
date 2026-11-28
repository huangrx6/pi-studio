const path = require('node:path');
const { stat } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GIT_OPTIONS = {
  encoding: 'utf8',
  timeout: 1500,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
};

async function runGit(cwd, args, options) {
  try {
    const result = await execFileAsync('git', args, { cwd, ...GIT_OPTIONS, ...options });
    return { stdout: result.stdout || '', error: null };
  } catch (error) {
    return { stdout: '', error };
  }
}

function emptyDirty() {
  return { total: 0, staged: 0, unstaged: 0, untracked: 0 };
}

function unavailable(reason) {
  return {
    available: false,
    reason,
    dirty: emptyDirty(),
    worktree: { isWorktree: false },
    worktrees: [],
  };
}

function parseStatus(stdout) {
  const dirty = emptyDirty();
  let upstream, ahead, behind, ignored = false;
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (line.startsWith('! ')) {
      ignored = true;
    } else if (line.startsWith('? ')) {
      dirty.untracked += 1;
      dirty.total += 1;
    } else if (/^[12u] /.test(line)) {
      dirty.total += 1;
      if (line[2] !== '.') dirty.staged += 1;
      if (line[3] !== '.') dirty.unstaged += 1;
      if (line[0] === '2') i++; // Renames and copies include a separate NUL-delimited source path.
    }
  }
  return { dirty, ignored, upstream: upstream ? { name: upstream, ahead, behind } : undefined };
}

function parseWorktrees(stdout, repositoryRoot) {
  return stdout
    .split('\0\0')
    .map((block) => {
      const lines = block.split('\0');
      const rawPath = lines.find((line) => line.startsWith('worktree '))?.slice(9);
      if (!rawPath) return null;
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const branch = branchLine?.slice(7).trim().replace(/^refs\/heads\//, '') || null;
      return {
        path: path.resolve(repositoryRoot, rawPath),
        head: lines.find(line => line.startsWith('HEAD '))?.slice(5) || '',
        branch,
        detached: lines.includes('detached'),
        locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
        ...(lines.includes('bare') && { unavailable: 'bare' }),
        ...(lines.some(line => line === 'prunable' || line.startsWith('prunable ')) && { unavailable: 'prunable' }),
      };
    })
    .filter(Boolean);
}

async function describeWorktrees(stdout, repositoryRoot) {
  const trees = parseWorktrees(stdout, repositoryRoot);
  // Git keeps locked registrations even when their volume is offline.
  await Promise.all(trees.filter(tree => tree.locked && !tree.unavailable).map(async tree => {
    const directory = await stat(tree.path).catch(() => null);
    if (!directory?.isDirectory()) tree.unavailable = 'inaccessible';
  }));
  return trees;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findWorktree(worktrees, cwd) {
  return worktrees
    .filter((worktree) => isWithin(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)[0] || null;
}

async function getGitWorkspaceStatus(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return unavailable('no-workspace');

  let resolvedCwd;
  try {
    resolvedCwd = path.resolve(cwd);
  } catch {
    return unavailable('invalid-workspace');
  }

  const rootResult = await runGit(resolvedCwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.error) {
    if (rootResult.error.code === 'ENOENT' || rootResult.error.code === 'ENOTDIR') {
      const directory = await stat(resolvedCwd).catch(() => null);
      return unavailable(directory?.isDirectory() ? 'git-unavailable' : 'invalid-workspace');
    }
    return unavailable('not-a-repository');
  }

  const repositoryRoot = path.resolve(rootResult.stdout.trim() || resolvedCwd);
  const [branchResult, commitResult, statusResult, worktreeResult] = await Promise.all([
    runGit(resolvedCwd, ['branch', '--show-current']),
    runGit(resolvedCwd, ['rev-parse', '--short', 'HEAD']),
    runGit(resolvedCwd, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }),
    runGit(resolvedCwd, ['worktree', 'list', '--porcelain', '-z']),
  ]);

  const worktrees = await describeWorktrees(worktreeResult.stdout, repositoryRoot);
  const selected = findWorktree(worktrees, repositoryRoot);
  const main = worktrees[0] || null;
  const branch = branchResult.stdout.trim() || null;
  const commit = commitResult.stdout.trim() || null;
  const isWorktree = Boolean(selected && main && selected.path !== main.path);

  const { dirty, upstream } = parseStatus(statusResult.stdout);
  return {
    available: true,
    repositoryRoot,
    branch,
    commit,
    dirty, upstream,
    statusReadFailed: Boolean(statusResult.error),
    worktree: {
      isWorktree,
      path: selected?.path || repositoryRoot,
      branch: selected?.branch || branch,
      mainPath: main?.path || repositoryRoot,
      name: isWorktree ? path.basename(selected.path) : undefined,
    },
    worktrees,
  };
}

module.exports = { getGitWorkspaceStatus, parseStatus, parseWorktrees, describeWorktrees, runGit };
