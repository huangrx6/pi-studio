const fs = require('node:fs/promises');
const path = require('node:path');
const { runGit } = require('./git-workspace.cjs');
const { SEARCH_IGNORED_DIRS } = require('./workspace.cjs');

const scans = new Map();
const skipDirectory = new Set([...SEARCH_IGNORED_DIRS, '.pi', '.pi-studio', '.hg', '.svn', '.idea', '.gradle', '__pycache__']);

async function rootAt(directory) {
  const { stdout, error } = await runGit(directory, ['rev-parse', '--show-toplevel']);
  if (error?.code === 'ENOENT') throw new Error('无法运行 Git，请检查 Git 安装和工作区目录。');
  if (error?.killed) throw new Error('读取 Git 仓库超时，请刷新后重试。');
  if (error || !stdout) return null;
  return fs.realpath(stdout.replace(/\r?\n$/, '')).catch(() => null);
}

// "." represents the repository containing the opened workspace, even when it is a subdirectory.
// A child selector must resolve to that exact worktree, never to a parent found by Git's upward search.
async function resolveGitRepository(cwd, id = '.') {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('没有选定工作区。');
  if (id === '.') {
    const root = await rootAt(cwd);
    if (root) return root;
    throw new Error('当前目录没有 Git 仓库。');
  }
  if (typeof id !== 'string' || id.includes('\0') || path.win32.isAbsolute(id) || (path.sep === '\\' && id.includes('\\')) ||
      id.split('/').some(part => !part || part === '.' || part === '..' || ['.git', '.pi'].includes(part.toLowerCase()))) {
    throw new Error('请选择工作区内的仓库。');
  }
  const base = await fs.realpath(cwd);
  const directory = path.join(base, id);
  const canonical = await fs.realpath(directory).catch(() => null);
  const marker = canonical === directory && await fs.lstat(path.join(directory, '.git')).catch(() => null);
  if (!(marker && (marker.isFile() || marker.isDirectory())) || await rootAt(directory) !== directory) {
    throw new Error('所选仓库已变化，请刷新仓库列表。');
  }
  return directory;
}

async function discover(cwd) {
  const base = await fs.realpath(cwd);
  const primary = await rootAt(base);
  const repositories = primary ? [{ id: '.', name: path.basename(primary), root: primary }] : [];
  // Walk directories in batches. Ordinary directories cost a readdir, and only .git markers invoke Git.
  const directories = [base];
  const seen = new Set(directories);
  function enqueue(directory) {
    if (!seen.has(directory)) { seen.add(directory); directories.push(directory); }
  }
  for (let next = 0; next < directories.length;) {
    const batch = directories.slice(next, next + 12);
    next += batch.length;
    await Promise.all(batch.map(async directory => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirectory.has(entry.name)) enqueue(path.join(directory, entry.name));
      }
      const marker = entries.find(entry => entry.name === '.git');
      if (!marker || !(marker.isDirectory() || marker.isFile())) return;
      if (directory !== base) {
        // A checkout can disappear while another branch or worktree is being prepared.
        if (await rootAt(directory).catch(() => null) !== directory) return;
        repositories.push({ id: path.relative(base, directory).split(path.sep).join('/'), name: path.basename(directory), root: directory });
      }
      // A declared submodule may live inside an otherwise skipped dependency directory.
      if (entries.some(entry => entry.name === '.gitmodules' && entry.isFile())) {
        const { stdout } = await runGit(directory, ['config', '--no-includes', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
        for (const line of stdout.split('\0').filter(Boolean)) {
          const name = line.slice(line.indexOf('\n') + 1);
          if (path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '..' || p === '.' || ['.git', '.pi'].includes(p.toLowerCase()))) continue;
          const target = path.join(directory, name);
          if (!seen.has(target) && await fs.realpath(target).catch(() => null) === target) enqueue(target);
        }
      }
    }));
  }
  return repositories.sort((a, b) => a.id === '.' ? -1 : b.id === '.' ? 1 : a.id.localeCompare(b.id));
}

function listGitRepositories(cwd) {
  if (!scans.has(cwd)) scans.set(cwd, discover(cwd).finally(() => scans.delete(cwd)));
  return scans.get(cwd);
}

module.exports = { listGitRepositories, resolveGitRepository };
