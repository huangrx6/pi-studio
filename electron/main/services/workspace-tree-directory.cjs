const path = require('node:path');
const fs = require('node:fs/promises');
const { parseWorktrees, runGit } = require('./git-workspace.cjs');

// Directory identity belongs to Studio. Only complete, explicitly opened checkout
// roots can share a project heading. Opening a subfolder never authorizes its parent.
async function readTree(cwd) {
  let canonical;
  try { canonical = await fs.realpath(cwd); }
  catch (error) { return { missing: ['ENOENT', 'ENOTDIR'].includes(error.code) }; }
  try { await fs.stat(path.join(canonical, '.git')); }
  catch (error) {
    if (error.code === 'ENOTDIR') return { missing: true };
    return error.code === 'ENOENT' ? { tree: null } : {};
  }
  const { stdout, error } = await runGit(canonical, ['worktree', 'list', '--porcelain', '-z']);
  if (error) return {};
  const list = parseWorktrees(stdout, canonical);
  const current = list.find(entry => path.relative(entry.path, canonical) === '');
  if (!current) return { tree: null };
  return { tree: {
    projectRoot: list[0].path,
    main: current === list[0],
    branch: current.branch || current.head.slice(0, 8),
    detached: current.detached,
  } };
}

const inflight = new Map();
function inspect(cwd) {
  if (!inflight.has(cwd)) inflight.set(cwd, readTree(cwd).finally(() => inflight.delete(cwd)));
  return inflight.get(cwd);
}

async function describeWorkspaceTrees(workspaces, db) {
  const stored = db.workspaceTreeRecords();
  const described = [...workspaces];
  let next = 0;
  async function readNext() {
    while (next < workspaces.length) {
      const index = next++;
      const item = workspaces[index];
      const last = stored.get(item.cwd);
      const result = await inspect(item.cwd);
      if (result.tree !== undefined && JSON.stringify(result.tree) !== JSON.stringify(last ?? null)) {
        db.setWorkspaceTreeRecord(item.cwd, result.tree);
      }
      const tree = result.tree === undefined ? last : result.tree;
      if (tree || result.missing) described[index] = { ...item, ...(tree && { worktree: tree }), ...(result.missing && { missing: true }) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, workspaces.length) }, readNext));
  return described;
}

module.exports = { describeWorkspaceTrees };
