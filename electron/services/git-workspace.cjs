const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GIT_OPTIONS = {
  encoding: 'utf8',
  timeout: 1500,
  maxBuffer: 256 * 1024,
  windowsHide: true,
};

async function runGit(cwd, args) {
  try {
    const result = await execFileAsync('git', args, { cwd, ...GIT_OPTIONS });
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

function parseDirty(stdout) {
  const dirty = emptyDirty();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    dirty.total += 1;
    if (line.startsWith('??')) {
      dirty.untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') dirty.staged += 1;
    if (line[1] && line[1] !== ' ') dirty.unstaged += 1;
  }
  return dirty;
}

function parseWorktrees(stdout, repositoryRoot) {
  return stdout
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const rawPath = lines.find((line) => line.startsWith('worktree '))?.slice(9).trim();
      if (!rawPath) return null;
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const branch = branchLine?.slice(7).trim().replace(/^refs\/heads\//, '') || null;
      return {
        path: path.resolve(repositoryRoot, rawPath),
        branch,
        detached: lines.includes('detached'),
      };
    })
    .filter(Boolean);
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
    return unavailable(rootResult.error.code === 'ENOENT' ? 'git-unavailable' : 'not-a-repository');
  }

  const repositoryRoot = path.resolve(rootResult.stdout.trim() || resolvedCwd);
  const [branchResult, commitResult, statusResult, worktreeResult] = await Promise.all([
    runGit(resolvedCwd, ['branch', '--show-current']),
    runGit(resolvedCwd, ['rev-parse', '--short', 'HEAD']),
    runGit(resolvedCwd, ['status', '--porcelain=v1', '--untracked-files=all']),
    runGit(resolvedCwd, ['worktree', 'list', '--porcelain']),
  ]);

  const worktrees = parseWorktrees(worktreeResult.stdout, repositoryRoot);
  const selected = findWorktree(worktrees, resolvedCwd);
  const main = worktrees[0] || null;
  const branch = branchResult.stdout.trim() || null;
  const commit = commitResult.stdout.trim() || null;
  const isWorktree = Boolean(selected && main && selected.path !== main.path);

  return {
    available: true,
    repositoryRoot,
    branch,
    commit,
    dirty: parseDirty(statusResult.stdout),
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

module.exports = { getGitWorkspaceStatus };
