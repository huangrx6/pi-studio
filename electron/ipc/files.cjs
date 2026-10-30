/**
 * IPC：工作区文件与外部打开。
 * 文件树、文本预览、`@` 搜索、用其它应用打开、在 Finder 中显示、外链打开。
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { getWindow } = require('../core/state.cjs');
const {
  workspaceFile,
  searchWorkspaceFiles,
  listDirectory,
  readFileText,
} = require('../services/workspace.cjs');
const { normalizeExternalHttpUrl } = require('../core/external-url.cjs');
const { applicationsForFile, applicationIcon, openWithApp } = require('../services/mac-apps.cjs');
const { resolveAttachmentFile } = require('../services/attachments.cjs');
const { resolveTurnDiffAbsoluteFile } = require('../services/turn-diff.cjs');

function assertMainWindow(event) {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('拒绝来自非主窗口的文件读取请求');
  }
}

function resolveFileRequest({ cwd, path: requested, source = 'workspace', sessionId } = {}) {
  if (typeof requested !== 'string' || !requested) throw new Error('缺少文件路径');
  if (source === 'workspace') return workspaceFile(cwd, requested);
  if (source === 'attachment') return resolveAttachmentFile(requested);
  if (source === 'diff') return resolveTurnDiffAbsoluteFile({ sessionId, path: requested });
  throw new Error('文件来源无效');
}

function registerFilesIpc() {
  ipcMain.handle('pi:turn-diff-file', (event, payload) => {
    assertMainWindow(event);
    return require('../services/turn-diff.cjs').readTurnDiffFile(payload);
  });
  // 目录列表（右侧文件树）
  ipcMain.handle('pi:files', async (event, { cwd, path: requested } = {}) => {
    assertMainWindow(event);
    return listDirectory(cwd, requested || '.');
  });

  // 单个文件内容（二进制 / 超大文件只返回元信息）
  ipcMain.handle('pi:file', async (event, { cwd, path: requested } = {}) => {
    assertMainWindow(event);
    return readFileText(cwd, requested);
  });
  // Absolute previews are scoped to paths present in this session's persisted
  // turn-diffs. The renderer cannot turn this into a general file reader.
  ipcMain.handle('pi:turn-diff-absolute-file', async (event, payload) => {
    assertMainWindow(event);
    return require('../services/turn-diff.cjs').readTurnDiffAbsoluteFile(payload);
  });

  // 「打开方式」候选应用 + 图标
  ipcMain.handle('pi:file-actions', async (event, payload) => {
    assertMainWindow(event);
    const target = resolveFileRequest(payload);
    if (!fs.existsSync(target)) throw new Error('文件不存在');
    const apps = await applicationsForFile(target);
    const withIcons = await Promise.all(
      apps.slice(0, 24).map(async (entry) => {
        try {
          const icon = applicationIcon(entry.path);
          if (icon) return { ...entry, icon };
          const image = await app.getFileIcon(entry.path, { size: 'normal' });
          return { ...entry, icon: image.toDataURL() };
        } catch {
          return entry;
        }
      }),
    );
    return { apps: withIcons };
  });

  // 用指定应用打开文件
  ipcMain.handle('pi:open-with', async (event, payload) => {
    assertMainWindow(event);
    const target = resolveFileRequest(payload);
    await openWithApp(target, typeof payload?.appPath === 'string' ? payload.appPath : undefined);
    return { ok: true };
  });

  // 打开链接：mode=window 时用内置子窗口，否则交给系统浏览器
  ipcMain.handle('pi:open-link', async (event, { url, mode } = {}) => {
    assertMainWindow(event);
    const safeUrl = normalizeExternalHttpUrl(url);
    if (mode !== undefined && mode !== 'external' && mode !== 'window') {
      throw new Error('链接打开方式无效');
    }
    if (mode === 'window') {
      const child = new BrowserWindow({
        width: 1080,
        height: 760,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: 'pi-studio-browser',
        },
      });
      child.webContents.setWindowOpenHandler(({ url: next }) => {
        try {
          void shell.openExternal(normalizeExternalHttpUrl(next));
        } catch {
          // Deny malformed and non-HTTP popup targets.
        }
        return { action: 'deny' };
      });
      await child.loadURL(safeUrl);
    } else {
      await shell.openExternal(safeUrl);
    }
    return { ok: true };
  });

  // 系统浏览器打开
  ipcMain.handle('pi:open-external', async (event, url) => {
    assertMainWindow(event);
    await shell.openExternal(normalizeExternalHttpUrl(url));
    return { ok: true };
  });

  // 在 Finder 中显示文件
  ipcMain.handle('pi:reveal-file', async (event, payload) => {
    assertMainWindow(event);
    shell.showItemInFolder(resolveFileRequest(payload));
    return { ok: true };
  });

  // `@` 文件搜索
  ipcMain.handle('pi:search-files', async (event, { cwd, query } = {}) => {
    assertMainWindow(event);
    return searchWorkspaceFiles(cwd, query);
  });

  // 选择工作区：选中后取消隐藏，让它重新出现在侧边栏
  ipcMain.handle('pi:choose-workspace', async (event) => {
    assertMainWindow(event);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const cwd = result.canceled ? undefined : result.filePaths[0];
    if (cwd) {
      getStudioDatabase().upsertWorkspace({ cwd, hidden: false });
    }
    return cwd;
  });
}

module.exports = { registerFilesIpc, resolveFileRequest };
