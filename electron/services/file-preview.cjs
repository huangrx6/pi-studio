/**
 * Unified, bounded file previews for renderer surfaces.
 *
 * Text is returned only after the shared workspace path guard accepts it.
 * Media is inlined only for an explicit allowlist and a small byte budget;
 * documents that Chromium cannot render safely remain metadata-only.
 */

const fs = require('node:fs');
const path = require('node:path');
const { workspaceFile } = require('./workspace.cjs');

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

/**
 * Read a bounded preview payload for an already-resolved absolute path.
 * Callers own the authorization check; this only bounds what crosses IPC.
 */
function readFilePreviewAt(target, requested) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('不是文件');

  const mimeType = mimeTypeForPath(target);
  const kind = previewKindForMime(mimeType);
  const base = {
    path: normalizedDisplayPath(target, requested),
    name: path.basename(target),
    size: stat.size,
    mimeType,
  };

  if (kind === 'pdf') {
    if (stat.size > MAX_INLINE_DOCUMENT_BYTES) {
      return {
        ...base,
        kind: 'binary',
        unavailableReason: `文件超过 ${Math.round(MAX_INLINE_DOCUMENT_BYTES / 1_000_000)} MB 内嵌预览上限`,
      };
    }
    return {
      ...base,
      kind,
      dataUrl: `data:${mimeType};base64,${fs.readFileSync(target).toString('base64')}`,
    };
  }

  if (kind !== 'text') {
    if (stat.size > MAX_INLINE_MEDIA_BYTES) {
      return {
        ...base,
        kind: 'binary',
        unavailableReason: `文件超过 ${Math.round(MAX_INLINE_MEDIA_BYTES / 1_000_000)} MB 内嵌预览上限`,
      };
    }
    return {
      ...base,
      kind,
      dataUrl: `data:${mimeType};base64,${fs.readFileSync(target).toString('base64')}`,
    };
  }

  const extension = path.extname(target).toLocaleLowerCase();
  const knownText = TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/')
    || ['application/json', 'application/x-ndjson', 'application/yaml', 'application/toml', 'application/sql', 'application/xml', 'application/graphql']
      .includes(mimeType);
  const knownBinary = MIME_BY_EXTENSION.has(extension) && !knownText;
  const truncated = stat.size > MAX_TEXT_BYTES;
  const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES));
  const descriptor = fs.openSync(target, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const binary = knownBinary || !looksLikeUtf8Text(buffer);

  if (binary) {
    // The shared preview title already states that the format is unavailable.
    // Only size limits or decoding failures need a separate explanatory line.
    return {
      ...base,
      kind: 'binary',
    };
  }

  return {
    ...base,
    kind: 'text',
    text: buffer.toString('utf8'),
    truncated,
  };
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
  readFilePreview,
  readFilePreviewAt,
};
