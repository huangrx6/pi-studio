/**
 * IPC：应用级状态。
 * 主题切换、启动时一次性拉取（工作区列表 + 当前模型）。
 */

const { ipcMain } = require('electron');
const { DEFAULT_CWD } = require('../core/state.cjs');
const { listWorkspaces } = require('../services/sessions.cjs');
const { modelInfo } = require('../services/models.cjs');
const { applyTheme } = require('../window.cjs');
const { chooseBackgroundMedia, removeBackgroundMedia } = require('../services/background.cjs');

function registerSystemIpc() {
  // 渲染进程切换主题（设置页），持久化并同步窗口底色
  ipcMain.handle('pi:set-theme', (_event, theme) => applyTheme(theme));
  ipcMain.handle('pi:background-media-choose', (_event, payload) => chooseBackgroundMedia(payload));
  ipcMain.handle('pi:background-media-remove', (_event, url) => removeBackgroundMedia(url));

  // 首屏状态：侧边栏工作区 + 当前模型 + 默认工作区
  ipcMain.handle('pi:state', async (_event, cwd) => ({
    workspaces: await listWorkspaces(),
    model: await modelInfo(cwd || DEFAULT_CWD),
    cwd: DEFAULT_CWD,
  }));
}

module.exports = { registerSystemIpc };
