/**
 * 工作区文件服务。
 *
 * 所有路径都先经过 resolveInWorkspace 校验，确保不会读到工作区之外的文件
 * （符号链接也会被 realpath 展开后再判断）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 文件搜索 / 目录列举时跳过的目录。 */
const SEARCH_IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', 'dist', 'build', '.next',
  'coverage', '.turbo', '.cache', 'target', 'vendor', '.venv', 'venv', 'release', '.DS_Store',
]);

/**
 * 把相对路径解析到工作区内，越界直接抛错。
 * 用 realpath 而不是 resolve，能挡住 `../` 与符号链接两种逃逸方式。
 */
function resolveInWorkspace(root, requested) {
  const canonicalRoot = fs.realpathSync(root);
  const target = path.resolve(canonicalRoot, requested || '.');
  const canonical = fs.realpathSync(target);
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) throw new Error('outside workspace');
  return canonical;
}

/** 对外的别名：把「工作区 + 相对路径」解析成绝对路径。 */
function workspaceFile(cwd, requested) {
  return resolveInWorkspace(cwd, requested);
}

/**
 * 文件模糊搜索（`@` 补全用）。
 * 广度优先遍历，最多扫描 4000 个条目，按「前缀匹配 > 名称包含 > 路径包含」排序。
 */
async function searchWorkspaceFiles(cwd, query) {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { files: [] };

  const files = [];
  const queue = [{ dir: root, rel: '' }];
  let scanned = 0;
  while (queue.length > 0 && scanned < 4000) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= 4000) break;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SEARCH_IGNORED_DIRS.has(entry.name)) {
          scanned += 1;
          files.push({ name: entry.name, path: rel, type: 'directory' });
          queue.push({ dir: path.join(current.dir, entry.name), rel });
        }
      } else if (entry.isFile()) {
        scanned += 1;
        files.push({ name: entry.name, path: rel, type: 'file' });
      }
    }
  }

  const needle = String(query || '').toLowerCase();
  const ranked = files
    .map((file) => {
      const lowerName = file.name.toLowerCase();
      const lowerPath = file.path.toLowerCase();
      const rank = !needle ? 2 : lowerName.startsWith(needle) ? 0 : lowerName.includes(needle) ? 1 : lowerPath.includes(needle) ? 2 : -1;
      return { ...file, rank };
    })
    .filter((file) => file.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
  return { files: ranked.slice(0, 40) };
}

/** 列出目录内容（右侧文件树用）。 */
function listDirectory(cwd, requested) {
  const root = resolveInWorkspace(cwd, requested || '.');
  const canonicalCwd = fs.realpathSync(cwd);
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => !['node_modules', '.git', '.next', 'dist'].includes(entry.name))
    .map((entry) => {
      const target = path.join(root, entry.name);
      return {
        name: entry.name,
        path: path.relative(canonicalCwd, target),
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? fs.statSync(target).size : 0,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { path: path.relative(canonicalCwd, root), entries };
}

/**
 * 读取文本文件。
 * 超过 1MB 或检测到 NUL 字节时按二进制处理，只返回元信息。
 */
function readFilePath(displayPath, target) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > 1_000_000) return { path: displayPath, size: stat.size, binary: true, text: '' };
  const buffer = fs.readFileSync(target);
  const binary = buffer.includes(0);
  return { path: displayPath, size: stat.size, binary, text: binary ? '' : buffer.toString('utf8') };
}

function readFileText(cwd, requested) {
  return readFilePath(requested, resolveInWorkspace(cwd, requested));
}

/**
 * 只读打开工作区之外的绝对路径。
 * 用于文件变更卡片：bash / 脚本写到其它目录的文件也能在右栏预览。
 */
function readAbsoluteFile(requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('需要绝对路径');
  const target = fs.realpathSync(requested);
  return readFilePath(requested, target);
}

/**
 * 生成目录引用文本：`@某个目录` 时把目录结构（最多 240 项）塞给模型。
 */
function directoryReferenceText(cwd, target) {
  const root = path.relative(cwd, target).split(path.sep).join('/');
  const lines = [];
  const queue = [{ dir: target, rel: root }];
  let count = 0;
  while (queue.length > 0 && count < 240) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= 240) break;
      if (entry.isDirectory() && SEARCH_IGNORED_DIRS.has(entry.name)) continue;
      const rel = `${current.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`${rel}/`);
        queue.push({ dir: path.join(current.dir, entry.name), rel });
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(path.join(current.dir, entry.name)).size;
        } catch {
          /* 文件可能刚好被删除 */
        }
        lines.push(`${rel} (${size} bytes)`);
        count += 1;
      }
    }
  }
  return `<directory path="${root}">\n${lines.join('\n')}\n</directory>\nThis is a directory listing. Use read/ls/grep tools to inspect files as needed.`;
}

/**
 * 把 `@` 引用的文件 / 目录转成模型上下文块。
 * 图片走 image 块，文本走 text 块，总预算 240k 字符。
 */
async function fileReferenceContext(cwd, mentions) {
  const blocks = [];
  let budget = 240_000;
  const imageMimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

  for (const requested of [...new Set(Array.isArray(mentions) ? mentions : [])].slice(0, 12)) {
    if (typeof requested !== 'string' || !requested.trim()) continue;
    try {
      const target = resolveInWorkspace(cwd, requested);
      const stat = fs.statSync(target);

      if (stat.isDirectory()) {
        const listing = directoryReferenceText(cwd, target);
        if (listing.length > budget) continue;
        blocks.push({ type: 'text', text: listing });
        budget -= listing.length;
        continue;
      }
      if (!stat.isFile()) continue;

      const relative = path.relative(cwd, target).split(path.sep).join('/');
      const mime = imageMimes[path.extname(target).toLowerCase()];
      if (mime) {
        if (stat.size > 8_000_000) continue;
        blocks.push({ type: 'image', mimeType: mime, data: fs.readFileSync(target).toString('base64') });
        continue;
      }

      if (stat.size > budget) continue;
      const buffer = fs.readFileSync(target);
      if (buffer.includes(0)) continue;
      const content = buffer.toString('utf8');
      const clipped = content.length > budget ? content.slice(0, budget) : content;
      budget -= clipped.length;
      blocks.push({ type: 'text', text: `<file path="${relative}">\n${clipped}\n</file>` });
      if (budget <= 0) break;
    } catch {
      /* 忽略不存在或越界的路径 */
    }
  }
  return blocks;
}

module.exports = {
  SEARCH_IGNORED_DIRS,
  resolveInWorkspace,
  workspaceFile,
  searchWorkspaceFiles,
  listDirectory,
  readFilePath,
  readFileText,
  readAbsoluteFile,
  directoryReferenceText,
  fileReferenceContext,
};
