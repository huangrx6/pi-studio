// User-created worktrees are ordinary Git worktrees. Git owns their branch and registration.
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkWorktreeSpace } = require('../core/worktree-space.cjs');
const { createHash } = require('node:crypto');
const { gitRead, runGitCommand: run, validateBranch, withRepositoryWrite, withGitLock } = require('./git-tools.cjs');
const { parseStatus, parseWorktrees } = require('./git-workspace.cjs');

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function trees(cwd) {
  const list = parseWorktrees(await run(cwd, ['worktree', 'list', '--porcelain', '-z']), cwd);
  if (!list.length) throw new Error('无法读取 Git 工作树列表。');
  return list;
}
async function statOrMissing(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function createTree(root, input) {
  const { name, folder, mode } = input;
  if (!['existing', 'new'].includes(mode)) throw new Error('请选择分支类型。');
  await validateBranch(root, name);
  if (typeof folder !== 'string' || !folder.trim() || folder === '.' || folder === '..' ||
      /[<>:"/\\|?*\x00-\x1f]/.test(folder) || /[ .]$/.test(folder) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)) throw new Error('请输入有效的文件夹名称。');
  const [list, refs] = await Promise.all([trees(root), gitRead(root, { kind: 'branches' })]);
  const ref = refs.branches.find(row => !row.remote && row.name === name);
  if (mode === 'existing' && (!ref || ref.worktree)) throw new Error(ref ? '该分支已由另一工作树使用。' : '本地分支已不存在。');
  if (mode === 'new' && ref) throw new Error('同名分支已存在。');
  if (mode === 'new' && (!refs.head || refs.head !== input.head)) throw new Error('起点提交已变化，请重新打开创建窗口。');
  if (input.parent && (typeof input.parent !== 'string' || !path.isAbsolute(input.parent))) throw new Error('请选择工作树的目标目录。');
  const parent = await fs.realpath(input.parent || path.dirname(list[0].path));
  if (!(await fs.stat(parent)).isDirectory() || list.some(tree => contains(tree.path, parent))) {
    throw new Error('请选择现有工作树以外的目录。');
  }
  const target = path.join(parent, folder);
  if (list.some(row => row.path === target) || await statOrMissing(target)) throw new Error('目标文件夹已存在，请换一个名称。');
  await checkWorktreeSpace(root, mode === 'new' ? refs.head : 'refs/heads/' + name, path.dirname(target));
  try {
    await run(root, ['worktree', 'add', ...(mode === 'new' ? ['-b', name] : []), '--', target, mode === 'new' ? refs.head : name]);
  } catch (error) {
    // A failing checkout hook can leave a usable registration, or just the new branch.
    if ((await trees(root)).some(tree => tree.path === target)) throw new Error('Git 已登记此工作树，但检出未正常结束。请关闭弹框，在工作树列表中打开并检查。');
    if (mode === 'new' && await run(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], { allowed: [1] })) {
      throw new Error('分支已存在，工作树尚未建成。请重新打开创建窗口，选择已有分支。');
    }
    throw error;
  }
  return target;
}

async function treeAt(root, target) {
  const list = await trees(root);
  const tree = list.find(row => row.path === target);
  if (!tree) throw new Error('此工作树已不属于所选仓库，请刷新。');
  const stat = await statOrMissing(target);
  const common = await fs.realpath(path.resolve(root, (await run(root, ['rev-parse', '--git-common-dir'])).trimEnd()));
  const registrations = path.join(common, 'worktrees');
  let admin;
  if (stat) {
    if (!stat.isDirectory() || await fs.realpath(target) !== target) throw new Error('工作树目录已被替换，请刷新检查。');
    const top = (await run(target, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
    const gitdir = (await run(target, ['rev-parse', '--absolute-git-dir'])).replace(/\r?\n$/, '');
    if (path.relative(target, top) !== '') throw new Error('目录与工作树登记不一致。');
    if (tree !== list[0]) {
      admin = await fs.realpath(gitdir);
      if (path.dirname(admin) !== registrations) throw new Error('目录属于另一个仓库。');
      const link = (await fs.readFile(path.join(gitdir, 'gitdir'), 'utf8')).replace(/\r?\n$/, '');
      if (await fs.realpath(path.resolve(gitdir, link)) !== path.join(target, '.git')) throw new Error('工作树关联已变化，请刷新。');
    }
  } else if (tree !== list[0]) {
    // A missing checkout can still own submodule history under its registration.
    for (const entry of await fs.readdir(registrations, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(registrations, entry.name);
      const backlink = (await fs.readFile(path.join(dir, 'gitdir'), 'utf8')).replace(/\r?\n$/, '');
      if (path.resolve(dir, backlink) === path.join(target, '.git')) { admin = dir; break; }
    }
    if (!admin) throw new Error('无法核对工作树登记，请用 Git 检查。');
  }
  return { list, tree, stat, admin };
}

async function reviewRemoval(root, input, assertUnused) {
  const { tree, list, stat, admin } = await treeAt(root, input.path);
  const target = tree.path;
  if (tree === list[0]) throw new Error('主工作树不能移除。');
  if (tree.locked) throw new Error('此工作树已锁定，请先检查其用途。');
  const active = input.activeCwd && await fs.realpath(input.activeCwd).catch(() => input.activeCwd);
  if (contains(target, root) || (active && contains(target, active))) throw new Error('请先切换到其他工作区，再移除此工作树。');
  if (list.some(other => other !== tree && contains(target, other.path))) throw new Error('此目录内还有其他工作树。');
  if (admin && await statOrMissing(path.join(admin, 'modules'))) {
    throw new Error('此工作树单独存有子模块的 Git 历史。请先备份子模块，并使用 Git 管理此工作树。');
  }
  await assertUnused?.(target);
  const raw = stat ? await run(target, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch',
    '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']) : '';
  const { dirty, ignored } = parseStatus(raw);
  const version = createHash('sha256').update(JSON.stringify([target, tree.branch, tree.head, stat?.dev, stat?.ino, raw])).digest('hex');
  return { version, dirty, ignored, missing: !stat, head: tree.head };
}

async function manageWorktree(cwd, input, { trashItem, assertUnused } = {}) {
  if (input?.kind === 'options') {
    const { head, branch, branches } = await gitRead(cwd, { kind: 'branches' });
    return { head, branch, branches: branches.filter(ref => !ref.remote).map(ref => ({ name: ref.name, occupied: Boolean(ref.worktree) })) };
  }
  if (input?.kind === 'open') {
    const { tree, stat } = await treeAt(cwd, input.path);
    if (!stat) throw new Error('此工作树目录已不存在。');
    return tree.path;
  }
  return withRepositoryWrite(cwd, async root => {
    if (input?.kind === 'create') return createTree(root, input);
    if (!['inspect', 'remove'].includes(input?.kind)) throw new Error('未知的工作树操作。');
    if (input.kind === 'inspect') return reviewRemoval(root, input, assertUnused);
    return withGitLock(input.path, async () => {
      const review = await reviewRemoval(root, input, assertUnused);
      if (review.version !== input.version) throw new Error('工作树状态已变化，请重新检查后确认。');
      if (!review.missing) {
        try { await trashItem(input.path); }
        catch { throw new Error('无法将目录移入系统回收站，请检查目录权限或占用情况后重试。'); }
      }
      // Remove only the missing registration. Never prune other worktrees or force-remove files.
      if (await statOrMissing(input.path)) throw new Error('目录仍然存在，已停止解除关联。');
      try { await run(root, ['worktree', 'remove', '--', input.path]); }
      catch {
        if ((await trees(root)).some(tree => tree.path === input.path)) {
          throw new Error('目录已不存在，Git 关联尚未清除。请重新检查后解除关联。');
        }
      }
    });
  });
}

module.exports = { manageWorktree, contains };
