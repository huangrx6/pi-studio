const fs = require('node:fs/promises');
const { lstatSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { studioDataDirectory } = require('../../core/studio-paths.cjs');
const { sourcePath: exampleOrImportedPath } = require('./example.cjs');

const prefix = 'generated:';
const reference = /^generated:([\da-f-]{36})\/([\da-f-]{36}\.(?:png|jpg|webp|wav|mp3|ogg|m4a|aac|flac))$/i;

function sourcePath(stored, create = false) {
  if (!stored.startsWith(prefix)) return exampleOrImportedPath(stored);
  const parts = reference.exec(stored);
  if (!parts) throw new Error('生成素材标识无效');
  let directory = studioDataDirectory();
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const part of ['attachments', 'storyboards', parts[1]]) {
    directory = path.join(directory, part);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('生成素材位置不是普通目录');
  }
  const filename = path.join(directory, parts[2]);
  const stat = lstatSync(filename, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error('生成素材位置不是普通文件');
  return filename;
}

async function writeGeneratedFile(workId, assetId, ext, bytes) {
  const stored = `${prefix}${workId}/${assetId}.${ext}`;
  const filename = sourcePath(stored, true);
  const handle = await fs.open(filename, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  } catch (error) { await fs.rm(filename, { force: true }); throw error; }
  return stored;
}

module.exports = { sourcePath, writeGeneratedFile, isGeneratedFile: stored => reference.test(stored) };
