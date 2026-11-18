/**
 * IPC：工具权限确认。
 * 只注册一次渲染进程的响应监听；请求由 extensions 服务主动发出。
 */

const { ipcMain } = require('electron');
const { registerConfirmationIpc } = require('../services/confirmations.cjs');

function registerConfirmIpc() {
  registerConfirmationIpc(ipcMain);
}

module.exports = { registerConfirmIpc };
