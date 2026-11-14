/**
 * Safe local HTML targets for the in-app browser.
 *
 * The browser may render an explicitly selected HTML document, but it must not
 * become a general file viewer. The document is resolved through the same
 * protected-path checks used by file previews; subresources are then limited
 * to that document's directory.
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { resolveUserTarget } = require('./file-target.cjs');

function filePathFromUrl(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== 'file:') throw new Error('不是本地文件 URL');
  return fileURLToPath(parsed);
}

function resolveLocalFile(url) {
  const filePath = filePathFromUrl(url);
  return resolveUserTarget(filePath);
}

function resolveLocalHtmlDocument(url) {
  let target;
  try {
    target = resolveLocalFile(url);
  } catch {
    return null;
  }
  const extension = path.extname(target).toLowerCase();
  return extension === '.html' || extension === '.htm' ? target : null;
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveLocalHtmlAsset(url, root) {
  if (!root) return null;
  let target;
  try {
    target = resolveLocalFile(url);
  } catch {
    return null;
  }
  return isPathInside(root, target) ? target : null;
}

function isAllowedLocalHtmlUrl(url) {
  return Boolean(resolveLocalHtmlDocument(url));
}

module.exports = {
  isAllowedLocalHtmlUrl,
  resolveLocalHtmlAsset,
  resolveLocalHtmlDocument,
};
