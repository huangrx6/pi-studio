/**
 * Unified, bounded file previews for renderer surfaces.
 *
 * Text is returned only after the shared workspace path guard accepts it.
 * Media and document previews have separate read and display budgets.
 */

const fs = require('node:fs');
const path = require('node:path');
const { workspaceFile } = require('./workspace.cjs');
const { fileChangeKey } = require('./file-change-events.cjs');
const { MAX_ARCHIVE_BYTES, archiveFormats, archivePreview } = require('./archive-preview.cjs');

const MAX_TEXT_BYTES = 1_500_000;
const MAX_INLINE_MEDIA_BYTES = 12_000_000;
// PDF 交给 Chromium 内置阅读器渲染，和内联媒体分开限额（文档通常更大）。
const MAX_INLINE_DOCUMENT_BYTES = 32_000_000;

const MIME_BY_EXTENSION = new Map([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.ndjson', 'application/x-ndjson'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.ini', 'text/plain'],
  ['.conf', 'text/plain'],
  ['.env', 'text/plain'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.scss', 'text/x-scss'],
  ['.sass', 'text/x-sass'],
  ['.less', 'text/x-less'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.py', 'text/x-python'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.java', 'text/x-java-source'],
  ['.rb', 'text/x-ruby'],
  ['.php', 'text/x-php'],
  ['.sh', 'text/x-shellscript'],
  ['.bash', 'text/x-shellscript'],
  ['.zsh', 'text/x-shellscript'],
  ['.sql', 'application/sql'],
  ['.xml', 'application/xml'],
  ['.graphql', 'application/graphql'],
  ['.gql', 'application/graphql'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'],
  ['.ogv', 'video/ogg'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.sh', '.bash', '.zsh', '.sql',
  '.xml', '.graphql', '.gql', '.vue', '.svelte', '.gitignore',
]);

function mimeTypeForPath(target) {
  const name = path.basename(target).toLocaleLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return 'text/plain';
  if (name === '.gitignore' || name === '.npmrc' || name === '.editorconfig') return 'text/plain';
  return MIME_BY_EXTENSION.get(path.extname(name)) || 'application/octet-stream';
}

function previewKindForMime(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'text';
}

function normalizedDisplayPath(target, requested) {
  return String(requested || path.basename(target)).replace(/\\/g, '/');
}

function looksLikeUtf8Text(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  return sample.length === 0 || controlBytes / sample.length < 0.02;
}

const BYTE_SAMPLE = 128;

function previewReadSize(name, size) {
  if (archiveFormats.has(path.extname(name).toLowerCase())) return size > MAX_ARCHIVE_BYTES ? BYTE_SAMPLE : size;
  const kind = previewKindForMime(mimeTypeForPath(name));
  if (kind === 'text') return Math.min(size, MAX_TEXT_BYTES);
  const limit = kind === 'pdf' ? MAX_INLINE_DOCUMENT_BYTES : MAX_INLINE_MEDIA_BYTES;
  return size > limit ? BYTE_SAMPLE : size;
}

// The same classification applies to working files and immutable Git blobs.
function previewFromBytes(requested, size, buffer) {
  const name = path.basename(requested);
  const mimeType = mimeTypeForPath(name);
  const kind = previewKindForMime(mimeType);
  const base = { path: normalizedDisplayPath(name, requested), name, size, mimeType };
  const binary = () => ({ ...base, kind: 'binary', byteSample: buffer.subarray(0, BYTE_SAMPLE).toString('hex') });
  if (kind !== 'text') {
    const limit = kind === 'pdf' ? MAX_INLINE_DOCUMENT_BYTES : MAX_INLINE_MEDIA_BYTES;
    if (size > limit) return { ...binary(), unavailableReason: `文件超过 ${Math.round(limit / 1_000_000)} MB 内嵌预览上限` };
    if (size < 1024 && buffer.toString('ascii', 0, 43).startsWith('version https://git-lfs.github.com/spec/v1')) {
      return { ...base, kind: 'binary', unavailableReason: '此版本保存的是 Git LFS 指针，文件内容尚未包含在此版本中。' };
    }
    return { ...base, kind, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
  }
  const extension = path.extname(name).toLowerCase();
  if (archiveFormats.has(extension)) {
    if (size > MAX_ARCHIVE_BYTES) return { ...binary(), unavailableReason: '此文件超过 8 MB 文档预览上限。' };
    try { return { ...base, kind: 'archive', archive: archivePreview(extension, buffer) }; }
    catch { return { ...binary(), unavailableReason: '无法读取文件目录或文档内容。加密文件和超出解压大小限制的文件可在系统应用中查看。' }; }
  }
  if ((MIME_BY_EXTENSION.has(extension) && !TEXT_EXTENSIONS.has(extension)) || !looksLikeUtf8Text(buffer)) return binary();
  return { ...base, kind: 'text', text: buffer.toString('utf8'), truncated: buffer.length < size };
}

function readFilePreviewAt(target, requested) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('不是文件');
    const display = requested || path.basename(target);
    const buffer = Buffer.alloc(previewReadSize(display, stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return { ...previewFromBytes(display, stat.size, buffer.subarray(0, offset)), changeKey: fileChangeKey(target) };
  } finally {
    fs.closeSync(fd);
  }
}

/** 工作区内预览：路径先经过工作区越界检查。 */
function readFilePreview(root, requested) {
  return readFilePreviewAt(workspaceFile(root, requested), requested);
}

module.exports = {
  MAX_INLINE_DOCUMENT_BYTES,
  MAX_INLINE_MEDIA_BYTES,
  MAX_TEXT_BYTES,
  mimeTypeForPath,
  previewReadSize,
  previewFromBytes,
  readFilePreview,
  readFilePreviewAt,
};
