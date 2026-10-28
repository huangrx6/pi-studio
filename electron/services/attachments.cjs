/**
 * 附件服务：把用户选择的文件保存到本地附件目录，并生成可回读的上下文。
 *
 * 设计：
 *  - 图片直接以 base64 内联进消息（Pi 的多模态输入要求）
 *  - 其它文件先落盘到 ~/.pi/agent/attachments/<sessionId>/，消息里只放标记
 *  - 发消息时 attachmentContext() 再把落盘文件的文本内容读回来
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog } = require('electron');
const { agentDir, getWindow } = require('../core/state.cjs');
const { makeAttachmentMarker } = require('../core/attachment-markers.cjs');

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

/** 附件根目录：~/.pi/agent/attachments */
function attachmentRoot() {
  return path.join(agentDir(), 'attachments');
}

/**
 * 把文件写入附件目录，返回落盘路径。
 * 文件名带时间戳前缀，避免同名覆盖。
 */
function writeAttachment(sessionId, name, buffer) {
  const safeSession = String(sessionId || 'draft').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80) || 'draft';
  const dir = path.join(attachmentRoot(), safeSession);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${stamp}-${safeAttachmentName(name)}`);
  fs.writeFileSync(target, buffer);
  return target;
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
  const result = await dialog.showOpenDialog(getWindow(), { properties: ['openFile', 'multiSelections'] });
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
  return { ...info, promptText: `${notice}\n\n${marker}`, notice };
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
      const canonical = fs.realpathSync(target);
      const root = attachmentRoot();
      if (canonical !== root && !canonical.startsWith(root + path.sep)) continue;
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

module.exports = {
  pickAttachments,
  saveUpload,
  saveAttachment,
  attachmentContext,
  ATTACHMENT_MIME,
};
