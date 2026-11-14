/**
 * IPC：当前工作区的 Git 状态。
 *
 * Git 只读查询在主进程执行，渲染层只收到 JSON-safe 的状态投影。
 */

const { ipcMain } = require('electron');
const { getWindow } = require('../core/state.cjs');
const { getGitWorkspaceStatus } = require('../services/git-workspace.cjs');

function assertMainWindow(event) {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('拒绝来自非主窗口的 Git 状态请求');
  }
}

function registerGitWorkspaceIpc() {
  ipcMain.handle('pi:git-workspace-status', async (event, cwd) => {
    assertMainWindow(event);
    return getGitWorkspaceStatus(typeof cwd === 'string' ? cwd : '');
  });
}

module.exports = { registerGitWorkspaceIpc };
