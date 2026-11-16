const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { manageWorktree } = require('../../electron/services/git-worktrees.cjs');

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-trees-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@studio.invalid');
  await fs.writeFile(path.join(repo, '.gitignore'), '*.ignored\n');
  git('add', '.'); git('commit', '-m', 'base'); git('branch', 'available');
  const head = git('rev-parse', 'HEAD');
  const act = (kind, args, services) => manageWorktree(repo, { kind, ...args }, services);
  return { dir, repo, git, head, act };
}

test('create and open worktrees using new or available local branches without changing the source checkout', async t => {
  const { dir, repo, git, head, act } = await fixture(t);
  const options = await act('options');
  assert.deepEqual(options.branches, [{ name: 'available', occupied: false }, { name: 'main', occupied: true }]);
  const tree = await act('create', { mode: 'existing', name: 'available', folder: '已有 分支', head });
  assert.equal(await act('open', { path: tree }), tree);
  assert.equal(git('-C', tree, 'branch', '--show-current'), 'available');
  await assert.rejects(act('create', { mode: 'existing', name: 'available', folder: 'again' }), /使用/);
  const args = { mode: 'new', name: 'feature/新功能', folder: '新功能', head };
  await assert.rejects(act('create', { ...args, name: '-bad' }), /无效/);
  await assert.rejects(act('create', { ...args, folder: '../outside' }), /文件夹/);
  await assert.rejects(act('create', { ...args, folder: path.basename(repo) }), /已存在/);
  await assert.rejects(act('create', { ...args, head: 'outdated' }), /起点/);
  const added = await act('create', args);
  assert.equal(added, path.join(dir, args.folder));
  assert.equal(git('-C', added, 'branch', '--show-current'), args.name);
  assert.equal(git('branch', '--show-current'), 'main');
});

test('preview and confirm removal of the exact checkout; retain files in trash and keep the branch', async t => {
  const { dir, repo, git, act } = await fixture(t);
  const tree = await act('create', { mode: 'existing', name: 'available', folder: 'preview' });
  await assert.rejects(act('inspect', { path: repo }), /主工作树/);
  await assert.rejects(act('inspect', { path: dir }), /不属于/);
  await assert.rejects(act('inspect', { path: tree, activeCwd: tree }), /先切换/);
  git('worktree', 'lock', tree);
  await assert.rejects(act('inspect', { path: tree }), /锁定/);
  git('worktree', 'unlock', tree);
  const clean = await act('inspect', { path: tree });
  const trash = path.join(dir, 'recycle');
  const recycle = { trashItem: item => fs.rename(item, trash) };
  await fs.writeFile(path.join(tree, 'local'), 'keep me');
  await fs.writeFile(path.join(tree, 'local.ignored'), 'ignored');
  await fs.writeFile(path.join(tree, '.gitignore'), '*.ignored\nother\n');
  git('-C', tree, 'add', '.gitignore');
  const review = await act('inspect', { path: tree });
  assert.equal(review.dirty.staged, 1);
  assert.equal(review.dirty.untracked, 1);
  assert.equal(review.ignored, true);
  await assert.rejects(act('remove', { path: tree, version: clean.version }, recycle), /已变化/);
  await assert.rejects(act('remove', { path: tree, version: review.version }, { trashItem: async () => { throw Error(); } }), /回收站/);
  assert.equal(await fs.readFile(path.join(tree, 'local'), 'utf8'), 'keep me');
  await act('remove', { path: tree, version: review.version }, recycle);
  assert.equal(await fs.readFile(path.join(trash, 'local'), 'utf8'), 'keep me');
  assert.equal(await fs.readFile(path.join(trash, 'local.ignored'), 'utf8'), 'ignored');
  assert.equal(git('rev-parse', 'available'), git('rev-parse', 'HEAD'));
  assert.doesNotMatch(git('worktree', 'list'), /preview/);
});

test('recheck ownership before removal and recover only the selected missing registration', async t => {
  const { dir, git, act } = await fixture(t);
  const tree = await act('create', { mode: 'existing', name: 'available', folder: 'old' });
  const other = await act('create', { mode: 'new', name: 'other', folder: 'other', head: git('rev-parse', 'HEAD') });
  await assert.rejects(act('inspect', { path: tree }, { assertUnused: () => { throw Error('still running'); } }), /still running/);
  const admin = git('-C', tree, 'rev-parse', '--absolute-git-dir');
  await fs.rename(tree, path.join(dir, 'recovered'));
  await fs.mkdir(tree);
  git('-C', tree, 'init', '-q');
  await assert.rejects(act('inspect', { path: tree }), /另一个仓库/);
  await fs.rename(tree, path.join(dir, 'replacement'));
  await fs.mkdir(path.join(admin, 'modules'));
  await assert.rejects(act('inspect', { path: tree }), /子模块/);
  await fs.rmdir(path.join(admin, 'modules'));
  const review = await act('inspect', { path: tree });
  assert.equal(review.missing, true);
  await act('remove', { path: tree, version: review.version });
  assert.equal(await act('open', { path: other }), other);
  assert.ok(git('rev-parse', 'available'));
});
