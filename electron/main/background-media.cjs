/**
 * Background media storage and validation.
 *
 * This module deliberately has no Electron imports. The main process copies the
 * selected file into an app-owned directory, and only the generated pi-media URL
 * reaches the renderer. Keeping the helpers dependency-free makes path traversal
 * and extension handling directly testable with Node.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKGROUND_SCHEME = 'pi-media';
const BACKGROUND_HOST = 'background';
const BACKGROUND_DIRECTORY = 'background-media';
const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024 * 1024;

const MIME_TYPES = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  png: 'image/png',
  webm: 'video/webm',
  webp: 'image/webp',
});

const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'webm']);
const SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

function extensionOf(filePath) {
  return path.extname(String(filePath || '')).slice(1).toLowerCase();
}

function mediaKindForPath(filePath) {
  const extension = extensionOf(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function mimeTypeForPath(filePath) {
  return MIME_TYPES[extensionOf(filePath)] || null;
}

function backgroundDirectory(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new Error('应用数据目录无效');
  return path.join(userDataPath, BACKGROUND_DIRECTORY);
}

function fileNameFromUrl(value) {
  if (typeof value !== 'string') throw new Error('背景媒体地址无效');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('背景媒体地址无效');
  }
  if (parsed.protocol !== `${BACKGROUND_SCHEME}:` || parsed.hostname !== BACKGROUND_HOST) {
    throw new Error('背景媒体地址不受支持');
  }
  const rawName = parsed.pathname.replace(/^\/+/, '');
  if (!rawName || rawName.includes('/')) throw new Error('背景媒体地址无效');
  let fileName;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    throw new Error('背景媒体地址无效');
  }
  if (fileName !== path.basename(fileName) || !mediaKindForPath(fileName)) {
    throw new Error('背景媒体类型不受支持');
  }
  return fileName;
}

function urlForFileName(fileName) {
  if (fileName !== path.basename(fileName) || !mediaKindForPath(fileName)) {
    throw new Error('背景媒体类型不受支持');
  }
  return `${BACKGROUND_SCHEME}://${BACKGROUND_HOST}/${encodeURIComponent(fileName)}`;
}

function resolveBackgroundMediaPath(userDataPath, value) {
  const root = path.resolve(backgroundDirectory(userDataPath));
  const fileName = fileNameFromUrl(value);
  const resolved = path.resolve(root, fileName);
  if (path.dirname(resolved) !== root) throw new Error('背景媒体路径越界');
  return resolved;
}

function parseByteRange(value, size) {
  if (value == null || String(value).trim() === '') return null;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('媒体文件大小无效');
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('媒体 Range 无效');

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error('媒体 Range 无效');
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      throw new Error('媒体 Range 无效');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function importBackgroundMedia(userDataPath, sourcePath, id = crypto.randomUUID()) {
  const kind = mediaKindForPath(sourcePath);
  const mime = mimeTypeForPath(sourcePath);
  if (!kind || !mime) throw new Error('请选择 PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V 或 WebM 文件');

  const source = path.resolve(sourcePath);
  const stat = await fs.promises.stat(source);
  if (!stat.isFile()) throw new Error('选择的背景不是文件');
  if (stat.size > MAX_BACKGROUND_BYTES) throw new Error('背景文件不能超过 2 GB');

  const extension = extensionOf(source);
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) throw new Error('无法生成背景媒体标识');
  const fileName = `${safeId}.${extension}`;
  const directory = backgroundDirectory(userDataPath);
  const destination = path.join(directory, fileName);

  await fs.promises.mkdir(directory, { recursive: true });
  try {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }

  return {
    kind,
    url: urlForFileName(fileName),
    name: path.basename(source),
    mime,
    bytes: stat.size,
  };
}

async function discardBackgroundMedia(userDataPath, value) {
  let mediaPath;
  try {
    mediaPath = resolveBackgroundMediaPath(userDataPath, value);
  } catch {
    return false;
  }
  try {
    await fs.promises.unlink(mediaPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  BACKGROUND_SCHEME,
  BACKGROUND_HOST,
  BACKGROUND_DIRECTORY,
  MAX_BACKGROUND_BYTES,
  SUPPORTED_EXTENSIONS,
  backgroundDirectory,
  discardBackgroundMedia,
  extensionOf,
  fileNameFromUrl,
  importBackgroundMedia,
  mediaKindForPath,
  mimeTypeForPath,
  parseByteRange,
  resolveBackgroundMediaPath,
  urlForFileName,
};
