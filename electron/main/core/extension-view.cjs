'use strict';

/**
 * Pure, dependency-free contract and path containment for sandboxed plugin UI
 * views served over the `pi-ext://` custom protocol.
 *
 * Host code never knows what a plugin's view renders: every plugin view lives
 * under its own `<extensionRoot>/ui/` directory and communicates exclusively
 * through JSON-safe snapshots and RPC calls.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_VIEW_SCHEME = 'pi-ext';
const EXTENSION_VIEW_HOST = 'view';
const MAX_VIEW_PAYLOAD_BYTES = 16 * 1024 * 1024;
const EXTENSION_ID_RE = /^(builtin|user|project):([a-z0-9][a-z0-9._-]{1,63})$/;
const VIEW_METHOD_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const VIEW_SCOPES = Object.freeze(['session', 'global']);

const VIEW_MIME_TYPES = Object.freeze({
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
});

function normalizeViewEntry(value) {
  if (typeof value !== 'string') throw new Error('view.entry 必须是相对路径字符串');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('view.entry 必须是包内相对路径');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error('view.entry 包含非法路径段');
  }
  if (segments[0] !== 'ui' || segments.length < 2) {
    throw new Error('view.entry 必须位于插件的 ui/ 目录内（例如 ui/index.html）');
  }
  const lower = normalized.toLowerCase();
  if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
    throw new Error('view.entry 必须指向 HTML 文件');
  }
  if (normalized.length > 200) throw new Error('view.entry 路径过长');
  return segments.join('/');
}

function normalizeViewScope(value) {
  if (value === undefined) return 'session';
  if (value !== 'session' && value !== 'global') {
    throw new Error('view.scope 必须是 session 或 global');
  }
  return value;
}

function extensionViewUrl(extensionId, entry) {
  const match = EXTENSION_ID_RE.exec(String(extensionId || ''));
  if (!match) throw new Error('扩展 ID 无效');
  const normalizedEntry = normalizeViewEntry(entry);
  const relativeInsideUi = normalizedEntry.slice(3); // strip leading "ui/"
  const encodedPath = relativeInsideUi.split('/').map(encodeURIComponent).join('/');
  return `${EXTENSION_VIEW_SCHEME}://${EXTENSION_VIEW_HOST}/${match[1]}/${encodeURIComponent(match[2])}/${encodedPath}`;
}

function parseExtensionViewUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('插件视图地址无效');
  }
  if (parsed.protocol !== `${EXTENSION_VIEW_SCHEME}:` || parsed.hostname !== EXTENSION_VIEW_HOST) {
    throw new Error('插件视图协议不受支持');
  }
  const segments = parsed.pathname
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new Error('插件视图路径编码无效');
      }
    });
  if (segments.length < 3) throw new Error('插件视图路径不完整');
  const [scope, manifestId, ...rest] = segments;
  const extensionId = `${scope}:${manifestId}`;
  if (!EXTENSION_ID_RE.test(extensionId)) throw new Error('插件视图扩展标识无效');
  if (rest.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) {
    throw new Error('插件视图路径包含非法段');
  }
  return {
    extensionId,
    scope,
    manifestId,
    relativePath: rest.join('/'),
  };
}

function mimeTypeForViewAsset(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return VIEW_MIME_TYPES[ext] || null;
}

function resolveExtensionViewAsset(uiRoot, relativePath) {
  if (typeof uiRoot !== 'string' || !uiRoot) throw new Error('插件 UI 目录不可用');
  const rootReal = fs.realpathSync(uiRoot);
  const candidate = path.resolve(rootReal, relativePath);
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('插件视图路径越界');
  }
  const fileReal = fs.realpathSync(candidate);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('插件视图符号链接越界');
  }
  const stat = fs.statSync(fileReal);
  if (!stat.isFile()) throw new Error('插件视图资源不是文件');
  const mimeType = mimeTypeForViewAsset(fileReal);
  if (!mimeType) throw new Error('插件视图资源类型不受支持');
  return { filePath: fileReal, mimeType, size: stat.size };
}

function extensionViewContentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

function normalizeViewMethod(method) {
  if (typeof method !== 'string' || !VIEW_METHOD_RE.test(method)) {
    throw new Error('插件视图调用方法名无效');
  }
  return method;
}

function sanitizeJsonPayload(value, label = '插件数据', maxBytes = MAX_VIEW_PAYLOAD_BYTES) {
  if (value === undefined) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label}无法序列化为 JSON`);
  }
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label}超出大小限制`);
  }
  return JSON.parse(serialized);
}

module.exports = {
  EXTENSION_VIEW_HOST,
  EXTENSION_VIEW_SCHEME,
  MAX_VIEW_PAYLOAD_BYTES,
  VIEW_SCOPES,
  extensionViewContentSecurityPolicy,
  extensionViewUrl,
  mimeTypeForViewAsset,
  normalizeViewEntry,
  normalizeViewMethod,
  normalizeViewScope,
  parseExtensionViewUrl,
  resolveExtensionViewAsset,
  sanitizeJsonPayload,
};
