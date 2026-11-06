/**
 * 附件服务：把用户选择的文件保存到本地附件目录，并生成可回读的上下文。
 *
 * 设计：
 *  - 图片直接以 base64 内联进消息（Pi 的多模态输入要求）
 *  - 其它文件先落盘到 Pi Studio userData/attachments/<sessionId>/，消息里只放标记
 *  - 发消息时 attachmentContext() 再把落盘文件的文本内容读回来
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, app, dialog } = require('electron');
const { makeAttachmentMarker } = require('../core/attachment-markers.cjs');
const { readFilePath } = require('./workspace.cjs');

/** 常见扩展名 → MIME。 */
const ATTACHMENT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 单个附件的大小上限（20MB），超过直接跳过。 */
const MAX_ATTACHMENT_BYTES = 20_000_000;

function attachmentMime(name, fallback) {
  return ATTACHMENT_MIME[path.extname(name).toLowerCase()] || fallback || 'application/octet-stream';
}

/** 清理文件名，去掉路径分隔符与非法字符。 */
function safeAttachmentName(name) {
  return (
    path.basename(String(name || 'attachment'))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 120) || 'attachment'
  );
}

/** 附件根目录：Pi Studio 自己的 userData，不读取或改写 ~/.pi。 */
function attachmentRoot() {
  return path.join(app.getPath('userData'), 'attachments');
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertManagedDirectory(target, label) {
  const stat = lstatIfPresent(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}不是受管理的普通目录`);
  }
  return fs.realpathSync(target);
}

function managedAttachmentRoot({ create = false } = {}) {
  const root = attachmentRoot();
  let stat = lstatIfPresent(root);
  if (!stat) {
    if (!create) return undefined;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    stat = lstatIfPresent(root);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Studio 附件根目录不是受管理的普通目录');
  }
  return assertManagedDirectory(root, 'Studio 附件根目录');
}

function managedSessionDirectory(sessionId, { create = false } = {}) {
  const root = managedAttachmentRoot({ create });
  if (!root) return undefined;
  const target = path.join(root, safeSessionDirectoryName(sessionId));
  let stat = lstatIfPresent(target);
  if (!stat) {
    if (!create) return undefined;
    fs.mkdirSync(target, { mode: 0o700 });
    stat = lstatIfPresent(target);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Studio 会话附件目录不是受管理的普通目录');
  }
  const canonical = assertManagedDirectory(target, 'Studio 会话附件目录');
  if (path.dirname(canonical) !== root) {
    throw new Error('Studio 会话附件目录超出附件根目录');
  }
  return canonical;
}

/**
 * Resolve a file under the Studio attachment root.
 *
 * Both sides are canonicalized before the containment check so `..` segments
 * and symlinks that escape the managed directory are rejected.
 */
function resolveAttachmentPath(root, requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
    throw new Error('需要附件绝对路径');
  }
  const canonicalRoot = assertManagedDirectory(root, 'Studio 附件根目录');
  if (path.resolve(root) !== canonicalRoot && fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('Studio 附件根目录不能是符号链接');
  }
  const target = fs.realpathSync(requested);
  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + path.sep)) {
    throw new Error('文件不在 Studio 附件目录中');
  }
  if (!fs.statSync(target).isFile()) throw new Error('不是附件文件');
  return target;
}

function resolveAttachmentFile(requested) {
  return resolveAttachmentPath(attachmentRoot(), requested);
}

function readAttachmentFile({ path: requested } = {}) {
  const target = resolveAttachmentFile(requested);
  return readFilePath(target, target);
}

function safeSessionDirectoryName(sessionId) {
  return String(sessionId || 'draft').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80) || 'draft';
}

/**
 * 把文件写入附件目录，返回落盘路径。
 * 随机 UUID 与独占创建共同保证同名附件绝不会互相覆盖。
 */
function writeAttachment(sessionId, name, buffer) {
  const dir = managedSessionDirectory(sessionId, { create: true });
  const target = path.join(dir, `${randomUUID()}-${safeAttachmentName(name)}`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* retain the write error */ }
      descriptor = undefined;
    }
    if (created) {
      try { fs.unlinkSync(target); } catch { /* retain the write error */ }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* prefer the write error */ }
    }
  }
  try {
    const canonical = fs.realpathSync(target);
    const stat = fs.lstatSync(canonical);
    if (path.dirname(canonical) !== dir || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Studio 附件写入后超出受管理目录');
    }
    return canonical;
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(target); } catch { /* retain the boundary error */ }
    }
    throw error;
  }
}

/** 组装附件元信息（行数只对文本文件有意义）。 */
function attachmentInfo(name, target, buffer, kind, mime) {
  const textLike = !buffer.includes(0);
  return {
    name,
    path: target,
    bytes: buffer.length,
    lines: textLike ? buffer.toString('utf8').split('\n').length : 0,
    kind,
    mime: attachmentMime(name, mime),
  };
}

/**
 * 打开系统文件选择框，返回可发送的附件列表。
 * 图片走 base64，其它文件落盘并附带标记。
 */
async function pickAttachments({ sessionId }) {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return { attachments: [] };

  const attachments = [];
  for (const selected of result.filePaths.slice(0, 8)) {
    try {
      const stat = fs.statSync(selected);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) continue;
      const name = path.basename(selected);
      const mime = attachmentMime(name, '');
      if (mime.startsWith('image/')) {
        attachments.push({ id: randomUUID(), kind: 'image', name, mime, bytes: stat.size, data: fs.readFileSync(selected).toString('base64') });
      } else {
        const buffer = fs.readFileSync(selected);
        const target = writeAttachment(sessionId, name, buffer);
        const info = attachmentInfo(name, target, buffer, 'file', mime);
        attachments.push({ id: randomUUID(), ...info, marker: makeAttachmentMarker(info) });
      }
    } catch {
      /* 跳过读不了的文件 */
    }
  }
  return { attachments };
}

/** 保存渲染进程拖拽上传的文件（base64）。 */
async function saveUpload({ sessionId, name, mime, data }) {
  if (typeof data !== 'string' || !data) throw new Error('没有可保存的文件');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('文件大小无效');
  const safeName = safeAttachmentName(name);
  const target = writeAttachment(sessionId, safeName, buffer);
  const info = attachmentInfo(safeName, target, buffer, 'file', mime);
  return { ...info, marker: makeAttachmentMarker(info) };
}

/**
 * 把超长消息保存成附件。
 * 前端会把「预览 + 原始内容附件」一起发出去，避免单条消息过长。
 */
async function saveAttachment({ sessionId, text }) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('没有可保存的内容');
  const name = `long-message-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  const buffer = Buffer.from(text, 'utf8');
  const target = writeAttachment(sessionId, name, buffer);
  const info = { name, path: target, bytes: buffer.length, lines: text.split('\n').length, kind: 'text', mime: 'text/plain' };
  const marker = makeAttachmentMarker(info);
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  const notice = `${preview}${text.length > 140 ? '…' : ''}\n\n原始内容已保存为附件。`;
  return { ...info, marker, promptText: `${notice}\n\n${marker}`, notice };
}

/**
 * 读取落盘附件的内容，拼成模型上下文块。
 * 只允许读取附件目录内的文件（防止越权读取任意路径），并限制总预算。
 */
async function attachmentContext(paths) {
  const blocks = [];
  let budget = 240_000;
  for (const target of [...new Set(Array.isArray(paths) ? paths : [])].slice(0, 6)) {
    if (typeof target !== 'string') continue;
    try {
      const canonical = resolveAttachmentFile(target);
      const stat = fs.statSync(canonical);
      if (!stat.isFile() || stat.size > budget) continue;
      const content = fs.readFileSync(canonical, 'utf8');
      if (content.includes('\0')) continue;
      const clipped = content.length > budget ? content.slice(0, budget) : content;
      budget -= clipped.length;
      blocks.push({ type: 'text', text: `<attachment path="${canonical}">\n${clipped}\n</attachment>` });
      if (budget <= 0) break;
    } catch {
      /* 附件可能已被删除 */
    }
  }
  return blocks;
}

/** Remove only the session-owned attachment directory below Studio userData. */
function removeAttachmentDirectory(sessionId) {
  const rawSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!rawSession || !/^[A-Za-z0-9-]{1,80}$/.test(rawSession)) return false;
  const safeSession = safeSessionDirectoryName(sessionId);
  let root;
  let target;
  try {
    root = managedAttachmentRoot();
    if (!root) return false;
    target = path.join(root, safeSession);
    const stat = lstatIfPresent(target);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const canonical = fs.realpathSync(target);
    if (path.dirname(canonical) !== root) return false;
    target = canonical;
  } catch {
    return false;
  }
  fs.rmSync(target, { recursive: true });
  return true;
}

/**
 * Remove session directories that no longer belong to a Studio conversation.
 *
 * Cleanup runs before the first renderer is created. Only direct, ordinary
 * service-named directories are eligible; `draft`, active conversation IDs and
 * every non-directory entry stay untouched.
 */
function cleanupOrphanedAttachmentDirectories(activeSessionIds = []) {
  const root = managedAttachmentRoot();
  if (!root) return { removed: 0, failed: 0 };
  const protectedNames = new Set(['draft']);
  for (const value of activeSessionIds) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const raw = String(value).trim();
    if (raw) protectedNames.add(safeSessionDirectoryName(raw));
  }

  let removed = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (protectedNames.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (safeSessionDirectoryName(entry.name) !== entry.name) continue;
    const target = path.join(root, entry.name);
    try {
      const stat = lstatIfPresent(target);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const canonical = fs.realpathSync(target);
      if (path.dirname(canonical) !== root) continue;
      fs.rmSync(canonical, { recursive: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

module.exports = {
  pickAttachments,
  saveUpload,
  saveAttachment,
  readAttachmentFile,
  resolveAttachmentPath,
  resolveAttachmentFile,
  attachmentContext,
  removeAttachmentDirectory,
  cleanupOrphanedAttachmentDirectories,
  ATTACHMENT_MIME,
};
