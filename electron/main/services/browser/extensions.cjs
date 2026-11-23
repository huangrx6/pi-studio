/**
 * Optional unpacked Chromium extensions for the in-app browser partition.
 * Paths are remembered in settings and reloaded on startup when possible.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { getBrowserSession } = require('./session.cjs');

const SETTING_KEY = 'studio.browser.extensions';

function normalizeEntries(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: String(row.id || '').slice(0, 120),
      name: String(row.name || '').slice(0, 120),
      path: String(row.path || ''),
      version: String(row.version || '').slice(0, 40),
      enabled: row.enabled !== false,
      updatedAt: Number(row.updatedAt) || Date.now(),
    }))
    .filter((row) => row.path && path.isAbsolute(row.path))
    .slice(0, 30);
}

function readExtensionEntries(db = getStudioDatabase()) {
  return db.getSettingWithRecovery(SETTING_KEY, [], normalizeEntries);
}

function writeExtensionEntries(entries, db = getStudioDatabase()) {
  const next = normalizeEntries(entries);
  db.setSetting(SETTING_KEY, next);
  return next;
}

function projectExtension(ext, entry = {}) {
  return {
    id: ext?.id || entry.id || '',
    name: ext?.name || entry.name || path.basename(entry.path || '') || '扩展',
    version: ext?.version || entry.version || '',
    path: ext?.path || entry.path || '',
    enabled: entry.enabled !== false,
  };
}

function listLoadedExtensions() {
  try {
    const session = getBrowserSession();
    const loaded = typeof session.getAllExtensions === 'function' ? session.getAllExtensions() : [];
    return Array.isArray(loaded) ? loaded : Object.values(loaded || {});
  } catch {
    return [];
  }
}

function listBrowserExtensions() {
  const entries = readExtensionEntries();
  const loaded = listLoadedExtensions();
  const byPath = new Map(loaded.map((ext) => [ext.path, ext]));
  const byId = new Map(loaded.map((ext) => [ext.id, ext]));
  const rows = entries.map((entry) => {
    const match = byPath.get(entry.path) || byId.get(entry.id);
    return {
      ...projectExtension(match, entry),
      loaded: Boolean(match),
      path: entry.path,
      enabled: entry.enabled !== false,
    };
  });
  // Include any session-loaded extensions not yet tracked.
  for (const ext of loaded) {
    if (rows.some((row) => row.id === ext.id || row.path === ext.path)) continue;
    rows.push({ ...projectExtension(ext), loaded: true, enabled: true });
  }
  let supported = false;
  try {
    supported = typeof getBrowserSession().loadExtension === 'function';
  } catch {
    supported = false;
  }
  return { ok: true, extensions: rows, supported };
}

async function loadBrowserExtension(extensionPath) {
  const target = path.resolve(String(extensionPath || ''));
  if (!target || !path.isAbsolute(target)) throw new Error('需要扩展目录的绝对路径');
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error('扩展目录不存在');
  }
  const manifestPath = path.join(target, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('目录中没有 manifest.json');
  const session = getBrowserSession();
  if (typeof session.loadExtension !== 'function') {
    throw new Error('当前运行环境不支持加载浏览器扩展');
  }
  const ext = await session.loadExtension(target, { allowFileAccess: false });
  const entries = readExtensionEntries().filter((row) => row.path !== target && row.id !== ext.id);
  entries.unshift({
    id: ext.id,
    name: ext.name || path.basename(target),
    path: target,
    version: ext.version || '',
    enabled: true,
    updatedAt: Date.now(),
  });
  writeExtensionEntries(entries);
  return { ok: true, extension: projectExtension(ext, entries[0]), ...listBrowserExtensions() };
}

function removeBrowserExtension(idOrPath) {
  const key = String(idOrPath || '');
  const session = getBrowserSession();
  const entries = readExtensionEntries();
  const match = entries.find((row) => row.id === key || row.path === key);
  const loaded = listLoadedExtensions().find((ext) => ext.id === key || ext.path === key || (match && (ext.id === match.id || ext.path === match.path)));
  if (loaded && typeof session.removeExtension === 'function') {
    try {
      session.removeExtension(loaded.id);
    } catch {
      // Best effort.
    }
  }
  const next = entries.filter((row) => row.id !== key && row.path !== key && (!match || (row.id !== match.id && row.path !== match.path)));
  writeExtensionEntries(next);
  return { ok: true, ...listBrowserExtensions() };
}

async function restoreBrowserExtensions() {
  const entries = readExtensionEntries().filter((row) => row.enabled !== false);
  const session = getBrowserSession();
  if (typeof session.loadExtension !== 'function') return { ok: true, restored: 0 };
  let restored = 0;
  for (const entry of entries) {
    if (!entry.path || !fs.existsSync(entry.path)) continue;
    try {
      const already = listLoadedExtensions().some((ext) => ext.path === entry.path || ext.id === entry.id);
      if (already) continue;
      const ext = await session.loadExtension(entry.path, { allowFileAccess: false });
      entry.id = ext.id || entry.id;
      entry.name = ext.name || entry.name;
      entry.version = ext.version || entry.version;
      restored += 1;
    } catch {
      // Skip broken paths; keep entry for the user to remove.
    }
  }
  writeExtensionEntries(entries);
  return { ok: true, restored };
}

module.exports = {
  listBrowserExtensions,
  loadBrowserExtension,
  removeBrowserExtension,
  restoreBrowserExtensions,
};
