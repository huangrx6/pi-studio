/**
 * Capture downloads that originate from the in-app browser partition.
 *
 * Files land under ~/.pi-studio/downloads (or a custom directory).
 * When askDownloadPath is on, the user picks a save location first.
 * Renderer code only receives JSON-safe projections, never DownloadItem handles.
 */
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, dialog, shell } = require('electron');
const { downloadsDirectory: defaultDownloadsDirectory } = require('../../core/studio-paths.cjs');
const { getBrowserSession } = require('./session.cjs');
const { getBrowserPreferences } = require('./settings.cjs');

const MAX_DOWNLOADS = 100;
const RISKY_EXTENSIONS = new Set([
  '.exe', '.msi', '.dmg', '.pkg', '.app', '.bat', '.cmd', '.com', '.scr',
  '.ps1', '.vbs', '.js', '.jse', '.wsf', '.sh', '.command', '.apk', '.jar',
]);

/** @type {Map<string, object>} */
const downloads = new Map();
/** @type {Set<(payload: object) => void>} */
const listeners = new Set();
let sequence = 0;
let installed = false;

function downloadsDirectory() {
  let directory = defaultDownloadsDirectory();
  try {
    const custom = getBrowserPreferences().downloadDirectory;
    if (custom && path.isAbsolute(custom)) directory = custom;
  } catch {
    // Preferences may be unavailable during early boot.
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function nextId() {
  sequence += 1;
  return `dl_${Date.now().toString(36)}_${sequence}`;
}

function extensionOf(filename) {
  const base = path.basename(String(filename || ''));
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index).toLowerCase() : '';
}

function isRiskyFilename(filename) {
  return RISKY_EXTENSIONS.has(extensionOf(filename));
}

function uniqueSavePath(directory, filename) {
  const base = path.basename(String(filename || 'download')).replace(/[\u0000-\u001f]/g, '').trim() || 'download';
  const safeName = base.replace(/[\\/]/g, '_') || 'download';
  let candidate = path.join(directory, safeName);
  if (!fs.existsSync(candidate)) return candidate;
  const parsed = path.parse(safeName);
  for (let index = 1; index < 1000; index += 1) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(directory, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function projectDownload(entry) {
  return {
    id: entry.id,
    url: entry.url,
    filename: entry.filename,
    path: entry.path,
    state: entry.state,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    mimeType: entry.mimeType,
    risky: entry.risky,
    error: entry.error,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt || null,
  };
}

function emit(entry) {
  const payload = { type: 'download', download: projectDownload(entry) };
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // A bad subscriber must not break download tracking.
    }
  }
}

function remember(entry) {
  downloads.set(entry.id, entry);
  while (downloads.size > MAX_DOWNLOADS) {
    const oldest = downloads.keys().next().value;
    downloads.delete(oldest);
  }
  emit(entry);
}

function focusedBrowserWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
}

async function chooseSavePath(filename) {
  const win = focusedBrowserWindow();
  const defaultPath = path.join(downloadsDirectory(), path.basename(filename || 'download'));
  const options = {
    title: '保存下载文件',
    defaultPath,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

function wireDownloadItem(item, entry) {
  item.on('updated', (_updatedEvent, state) => {
    entry.receivedBytes = item.getReceivedBytes();
    entry.totalBytes = item.getTotalBytes() || entry.totalBytes;
    entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
    emit(entry);
  });
  item.once('done', (_doneEvent, state) => {
    entry.receivedBytes = item.getReceivedBytes();
    entry.totalBytes = item.getTotalBytes() || entry.totalBytes;
    entry.endedAt = Date.now();
    entry.item = null;
    if (state === 'completed') {
      entry.state = 'completed';
      entry.error = '';
    } else if (state === 'cancelled') {
      entry.state = 'cancelled';
    } else {
      entry.state = 'failed';
      entry.error = state || '下载失败';
    }
    emit(entry);
  });
}

function installBrowserDownloads() {
  if (installed) return getBrowserSession();
  installed = true;
  const browserSession = getBrowserSession();
  browserSession.on('will-download', (event, item) => {
    const id = nextId();
    const filename = item.getFilename() || 'download';
    const preferences = (() => {
      try {
        return getBrowserPreferences();
      } catch {
        return { askDownloadPath: false };
      }
    })();

    const entry = {
      id,
      url: item.getURL(),
      filename: path.basename(filename),
      path: '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes() || 0,
      mimeType: item.getMimeType() || '',
      risky: isRiskyFilename(filename),
      error: '',
      startedAt: Date.now(),
      endedAt: 0,
      item,
    };

    if (preferences.askDownloadPath) {
      const defaultPath = path.join(downloadsDirectory(), path.basename(filename));
      try {
        item.setSaveDialogOptions({
          title: '保存下载文件',
          defaultPath,
        });
      } catch {
        // Fall through to explicit dialog if API is unavailable.
        void (async () => {
          const chosen = await chooseSavePath(filename);
          if (!chosen) {
            try { item.cancel(); } catch { /* ignore */ }
            entry.state = 'cancelled';
            entry.endedAt = Date.now();
            entry.item = null;
            remember(entry);
            return;
          }
          entry.path = chosen;
          entry.filename = path.basename(chosen);
          try { item.setSavePath(chosen); } catch { /* ignore */ }
          remember(entry);
        })();
        wireDownloadItem(item, entry);
        return;
      }
      wireDownloadItem(item, entry);
      // Path fills in after the user confirms the dialog.
      item.once('updated', () => {
        const savePath = item.getSavePath?.() || '';
        if (savePath) {
          entry.path = savePath;
          entry.filename = path.basename(savePath) || entry.filename;
          emit(entry);
        }
      });
      remember(entry);
      return;
    }

    const savePath = uniqueSavePath(downloadsDirectory(), filename);
    entry.path = savePath;
    entry.filename = path.basename(savePath);
    item.setSavePath(savePath);
    remember(entry);
    wireDownloadItem(item, entry);
  });
  return browserSession;
}

function listBrowserDownloads() {
  return [...downloads.values()]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map(projectDownload);
}

function getDownload(id) {
  return downloads.get(String(id || ''));
}

function cancelBrowserDownload(id) {
  const entry = getDownload(id);
  if (!entry) return { ok: false, error: '找不到该下载' };
  if (entry.item && entry.state === 'progressing') {
    try {
      entry.item.cancel();
    } catch (error) {
      return { ok: false, error: error?.message || '无法取消下载' };
    }
  } else if (entry.state === 'progressing') {
    entry.state = 'cancelled';
    entry.endedAt = Date.now();
    emit(entry);
  }
  return { ok: true, download: projectDownload(entry) };
}

function clearBrowserDownload(id) {
  const entry = getDownload(id);
  if (!entry) return { ok: false, error: '找不到该下载' };
  if (entry.item && entry.state === 'progressing') {
    try {
      entry.item.cancel();
    } catch {
      // Still drop the projection if cancel fails.
    }
  }
  downloads.delete(entry.id);
  return { ok: true };
}

function clearBrowserDownloads({ onlyFinished = true } = {}) {
  for (const [id, entry] of [...downloads.entries()]) {
    if (onlyFinished && entry.state === 'progressing') continue;
    if (entry.item && entry.state === 'progressing') {
      try {
        entry.item.cancel();
      } catch {
        // Ignore cancel failures while clearing the list.
      }
    }
    downloads.delete(id);
  }
  return { ok: true, downloads: listBrowserDownloads() };
}

async function revealBrowserDownload(id) {
  const entry = getDownload(id);
  if (!entry?.path) throw new Error('找不到该下载');
  if (!fs.existsSync(entry.path)) throw new Error('文件尚未就绪或不存在');
  shell.showItemInFolder(entry.path);
  return { ok: true };
}

async function openBrowserDownload(id) {
  const entry = getDownload(id);
  if (!entry?.path) throw new Error('找不到该下载');
  if (!fs.existsSync(entry.path)) throw new Error('文件尚未就绪或不存在');
  const error = await shell.openPath(entry.path);
  if (error) throw new Error(error);
  return { ok: true };
}

async function openBrowserDownloadsFolder() {
  const directory = downloadsDirectory();
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return { ok: true, path: directory };
}

function subscribeBrowserDownloads(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  cancelBrowserDownload,
  clearBrowserDownload,
  clearBrowserDownloads,
  downloadsDirectory,
  installBrowserDownloads,
  isRiskyFilename,
  listBrowserDownloads,
  openBrowserDownload,
  openBrowserDownloadsFolder,
  revealBrowserDownload,
  subscribeBrowserDownloads,
  uniqueSavePath,
};
