/** IPC bridge for the updater state machine. */

const { ipcMain } = require('electron');
const {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} = require('../services/updater.cjs');

function registerUpdatesIpc() {
  ipcMain.handle('pi:update-state', () => getUpdateState());
  ipcMain.handle('pi:check-for-updates', (_event, options) => checkForUpdates({
    interactive: options?.interactive !== false,
  }));
  ipcMain.handle('pi:download-update', () => downloadUpdate());
  ipcMain.handle('pi:install-update', () => installUpdate());
}

module.exports = { registerUpdatesIpc };
