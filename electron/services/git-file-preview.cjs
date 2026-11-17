const fs = require('node:fs/promises');
const path = require('node:path');
const { previewFromBytes, previewReadSize, readFilePreview } = require('./file-preview.cjs');
const { workspaceFile } = require('./workspace.cjs');

function reference(file, mimeType, text) {
  return { path: file, name: path.basename(file), kind: 'text', mimeType, size: Buffer.byteLength(text), text };
}

async function workingFile(run, root, file) {
  const directory = workspaceFile(root, path.dirname(file));
  const target = path.join(directory, path.basename(file));
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) return reference(file, 'inode/symlink', '符号链接 → ' + await fs.readlink(target));
  if (stat.isDirectory()) {
    const marker = await fs.lstat(path.join(target, '.git')).catch(() => null);
    const head = marker && await run(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowed: [1] });
    return reference(file, 'application/x-gitlink', head ? '子仓库提交 ' + head.trim() : '子仓库尚未检出提交。');
  }
  return readFilePreview(root, file);
}

// ls-tree and ls-files give us both the object type and the exact object ID.
// A symlink is reviewed as its link text, a gitlink as its recorded commit.
async function previewGitVersion(run, root, version) {
  const file = version.path;
  if (version.working) return workingFile(run, root, file);
  let entry;
  if (version.tree) {
    const row = await run(root, ['ls-tree', '-z', version.tree, '--', file]);
    const match = /^(\d+) \w+ ([\da-f]+)\t/.exec(row);
    if (match && row.slice(match[0].length, -1) === file) entry = match;
  } else {
    const rows = await run(root, ['ls-files', '--stage', '-z', '--', file]);
    for (const row of rows.split('\0')) {
      const match = /^(\d+) ([\da-f]+) (\d)\t/.exec(row);
      if (match && match[3] === String(version.stage) && row.slice(match[0].length) === file) { entry = match; break; }
    }
  }
  if (!entry) throw new Error('此版本的文件已变化，请刷新后再试。');
  const [, mode, oid] = entry;
  if (mode === '160000') return reference(file, 'application/x-gitlink', '子仓库提交 ' + oid);
  if (mode === '120000') {
    const target = await run(root, ['cat-file', 'blob', oid], { bytes: 4096 });
    return reference(file, 'inode/symlink', '符号链接 → ' + target.toString('utf8'));
  }
  const size = Number(await run(root, ['cat-file', '-s', oid]));
  const bytes = previewReadSize(file, size);
  const buffer = bytes ? await run(root, ['cat-file', 'blob', oid], { bytes }) : Buffer.alloc(0);
  return previewFromBytes(file, size, buffer);
}

module.exports = { previewGitVersion };
