/**
 * IPC surface for desktop control settings and permission helpers.
 */
const { BrowserWindow, ipcMain } = require('electron');
const {
  getDesktopControlStatus,
  getDesktopControlPreferences,
  setDesktopControlPreferences,
  addDesktopAlwaysAllowApp,
  removeDesktopAlwaysAllowApp,
  getDesktopPermissionStatus,
  openDesktopPermissionSettings,
  listDesktopInstalledApps,
  listDesktopActivity,
  clearDesktopActivity,
} = require('../services/desktop-control/index.cjs');

function assertMainWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error('窗口不可用');
  return win;
}

function registerDesktopControlIpc() {
  ipcMain.handle('pi:desktop-control-status', async (event) => {
    assertMainWindow(event);
    return getDesktopControlStatus();
  });

  ipcMain.handle('pi:desktop-control-preferences', (event) => {
    assertMainWindow(event);
    return getDesktopControlPreferences();
  });

  ipcMain.handle('pi:desktop-control-set-preferences', async (event, payload = {}) => {
    assertMainWindow(event);
    const preferences = setDesktopControlPreferences(payload && typeof payload === 'object' ? payload : {});
    return { ok: true, preferences, status: await getDesktopControlStatus() };
  });

  ipcMain.handle('pi:desktop-control-permissions', async (event) => {
    assertMainWindow(event);
    return getDesktopPermissionStatus();
  });

  ipcMain.handle('pi:desktop-control-open-permission-settings', async (event, payload = {}) => {
    assertMainWindow(event);
    const kind = payload && typeof payload === 'object' ? payload.kind : payload;
    return openDesktopPermissionSettings(kind);
  });

  ipcMain.handle('pi:desktop-control-installed-apps', async (event) => {
    assertMainWindow(event);
    try {
      return { ok: true, apps: await listDesktopInstalledApps() };
    } catch (cause) {
      return {
        ok: false,
        apps: [],
        error: cause && cause.message ? String(cause.message) : String(cause),
        code: cause && cause.code ? cause.code : 'desktop_list_installed_failed',
      };
    }
  });

  ipcMain.handle('pi:desktop-control-always-allow-add', async (event, payload = {}) => {
    assertMainWindow(event);
    const preferences = addDesktopAlwaysAllowApp(payload);
    return { ok: true, preferences, status: await getDesktopControlStatus() };
  });

  ipcMain.handle('pi:desktop-control-always-allow-remove', async (event, payload = {}) => {
    assertMainWindow(event);
    const id = typeof payload === 'string' ? payload : payload?.id;
    const preferences = removeDesktopAlwaysAllowApp(id || payload);
    return { ok: true, preferences, status: await getDesktopControlStatus() };
  });

  ipcMain.handle('pi:desktop-control-activity', (event, payload = {}) => {
    assertMainWindow(event);
    const limit = payload && typeof payload === 'object' ? payload.limit : payload;
    return { ok: true, activity: listDesktopActivity(limit) };
  });

  ipcMain.handle('pi:desktop-control-activity-clear', async (event) => {
    assertMainWindow(event);
    return { ok: true, activity: clearDesktopActivity(), status: await getDesktopControlStatus() };
  });
}

module.exports = { registerDesktopControlIpc };
