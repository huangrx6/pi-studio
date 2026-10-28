/**
 * IPC：工作区文件与外部打开。
 * 文件树、文本预览、`@` 搜索、用其它应用打开、在 Finder 中显示、外链打开。
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const { configPath, readConfig, writeConfig } = require('../core/state.cjs');
const { updateSidebar } = require('../sidebar-state.cjs');
const {
  workspaceFile,
  searchWorkspaceFiles,
  listDirectory,
  readFileText,
  readAbsoluteFile,
} = require('../services/workspace.cjs');
const { applicationsForFile, applicationIcon, openWithApp } = require('../services/mac-apps.cjs');

function registerFilesIpc() {
  // 目录列表（右侧文件树）
  ipcMain.handle('pi:files', async (_event, { cwd, path: requested }) => listDirectory(cwd, requested || '.'));

  // 单个文件内容（二进制 / 超大文件只返回元信息）
  ipcMain.handle('pi:file', async (_event, { cwd, path: requested }) => readFileText(cwd, requested));
  // 文件变更卡片可能指向工作区之外（bash / 脚本输出），只读预览走绝对路径。
  ipcMain.handle('pi:file-absolute', async (_event, requested) => readAbsoluteFile(requested));

  // 「打开方式」候选应用 + 图标
  ipcMain.handle('pi:file-actions', async (_event, { cwd, path: requested }) => {
    const target = workspaceFile(cwd, requested);
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
  ipcMain.handle('pi:open-with', async (_event, { cwd, path: requested, appPath }) => {
    const target = workspaceFile(cwd, requested);
    await openWithApp(target, typeof appPath === 'string' ? appPath : undefined);
    return { ok: true };
  });

  // 打开链接：mode=window 时用内置子窗口，否则交给系统浏览器
  ipcMain.handle('pi:open-link', async (_event, { url, mode }) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('链接无效');
    if (mode === 'window') {
      const child = new BrowserWindow({
        width: 1080,
        height: 760,
        titleBarStyle: 'hiddenInset',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      child.webContents.setWindowOpenHandler(({ url: next }) => {
        if (/^https?:\/\//i.test(next)) void shell.openExternal(next);
        return { action: 'deny' };
      });
      await child.loadURL(url);
    } else {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  // 系统浏览器打开
  ipcMain.handle('pi:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
    return { ok: true };
  });

  // 在 Finder 中显示文件
  ipcMain.handle('pi:reveal-file', async (_event, { cwd, path: requested }) => {
    shell.showItemInFolder(workspaceFile(cwd, requested));
    return { ok: true };
  });

  // `@` 文件搜索
  ipcMain.handle('pi:search-files', async (_event, { cwd, query }) => searchWorkspaceFiles(cwd, query));

  // 选择工作区：选中后取消隐藏，让它重新出现在侧边栏
  ipcMain.handle('pi:choose-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const cwd = result.canceled ? undefined : result.filePaths[0];
    if (cwd) {
      writeConfig(configPath(), updateSidebar(readConfig(configPath(), {}), { kind: 'workspace', id: cwd, action: 'restore' }));
    }
    return cwd;
  });
}

module.exports = { registerFilesIpc };
