/**
 * IPC：应用级状态。
 * 主题切换、启动时一次性拉取（工作区列表 + 当前模型）。
 */

const { app, clipboard, ipcMain, shell } = require('electron');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const { databasePath, getStudioDatabase } = require('../core/studio-db.cjs');
const { externalWorktreeStorageRoots } = require('../capabilities/subagents/index.cjs');
const { createDeviceStorageService, updateCacheDirectory } = require('../services/device-storage.cjs');
const { listWorkspaces, refreshRuntimeState } = require('../runtime/conversations.cjs');
const { DEFAULT_CWD, modelInfo } = require('../services/models.cjs');
const { applyAppearance, windowState } = require('../window.cjs');
const { chooseBackgroundMedia, removeBackgroundMedia } = require('../services/background.cjs');

async function deviceStorageSources() {
  const sources = {
    studio: studioDataDirectory(), database: databasePath(), client: app.getPath('userData'),
    session: app.getPath('sessionData'), home: app.getPath('home'), appData: app.getPath('appData'),
    projects: [], worktrees: [],
  };
  try {
    const db = getStudioDatabase();
    sources.projects = db.listWorkspaces().map(workspace => workspace.cwd);
    sources.worktrees = externalWorktreeStorageRoots(db);
  } catch { sources.locationsIncomplete = true; }
  if (app.isPackaged && !process.env.PI_STUDIO_USER_DATA) {
    try {
      sources.updates = await updateCacheDirectory(process.resourcesPath);
    } catch { sources.locationsIncomplete = true; }
  }
  return sources;
}

function registerSystemIpc(waitForStartup) {
  const storage = createDeviceStorageService({
    shell,
    clipboard,
    getSources: deviceStorageSources,
    getDatabaseStats: () => getStudioDatabase().databaseStorageStats(),
    compactDatabase: () => getStudioDatabase().compactDatabase(),
  });
  ipcMain.handle('pi:device-storage', async () => {
    try { return await storage.snapshot(); }
    catch { throw new Error('无法读取存储用量，请刷新重试。'); }
  });
  ipcMain.handle('pi:device-storage-location', (_event, id, action) => storage.useLocation(id, action));
  ipcMain.handle('pi:device-storage-cleanup', async () => {
    try { return await storage.cleanup(); }
    catch { throw new Error('存储整理未能完成，请稍后重试。'); }
  });
  ipcMain.handle('pi:startup-ready', () => waitForStartup());
  // 渲染进程切换外观（设置页），持久化并同步原生窗口与菜单栏。
  ipcMain.handle(
    'pi:set-appearance',
    (_event, theme, palette, radiusStyle) => applyAppearance(theme, palette, radiusStyle),
  );
  ipcMain.handle('pi:window-state', () => windowState());
  ipcMain.handle('pi:background-media-choose', (_event, payload) => chooseBackgroundMedia(payload));
  ipcMain.handle('pi:background-media-remove', (_event, url) => removeBackgroundMedia(url));

  // 首屏状态：侧边栏工作区 + 当前模型 + 默认工作区
  ipcMain.handle('pi:state', async (_event, cwd) => {
    await waitForStartup();
    await refreshRuntimeState();
    return {
      workspaces: await listWorkspaces(),
      model: await modelInfo(cwd || DEFAULT_CWD),
      cwd: DEFAULT_CWD,
    };
  });
}

module.exports = { registerSystemIpc };
