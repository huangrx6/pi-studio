const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getGitWorkspaceStatus } = require('../../electron/services/git-workspace.cjs');

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-git-workspace-')));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Pi Studio Test']);
  git(root, ['config', 'user.email', 'test@pi-studio.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

test('Git workspace status reports branch, commit, dirty counts and worktree identity', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n');
  git(root, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');

  const status = await getGitWorkspaceStatus(root);
  assert.equal(status.available, true);
  assert.equal(status.repositoryRoot, root);
  assert.equal(status.branch, git(root, ['branch', '--show-current']));
  assert.match(status.commit, /^[0-9a-f]+$/);
  assert.deepEqual(status.dirty, { total: 2, staged: 1, unstaged: 1, untracked: 1 });
  assert.equal(status.worktree.isWorktree, false);
  assert.equal(status.worktrees.length, 1);

  const child = path.join(path.dirname(root), `${path.basename(root)}-feature`);
  git(root, ['worktree', 'add', '-q', '-b', 'feature', child, 'HEAD']);
  const childStatus = await getGitWorkspaceStatus(child);
  assert.equal(childStatus.available, true);
  assert.equal(childStatus.branch, 'feature');
  assert.equal(childStatus.worktree.isWorktree, true);
  assert.equal(childStatus.worktree.name, path.basename(child));
  assert.equal(childStatus.worktrees.length, 2);
  assert.equal(childStatus.worktree.path, child);
});

test('Git workspace status degrades safely outside a repository', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-no-git-')));
  const status = await getGitWorkspaceStatus(directory);
  assert.equal(status.available, false);
  assert.equal(status.reason, 'not-a-repository');
  assert.deepEqual(status.dirty, { total: 0, staged: 0, unstaged: 0, untracked: 0 });
  assert.deepEqual(status.worktrees, []);
});
