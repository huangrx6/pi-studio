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
  listDesktopAppMappings,
  listDesktopInstalledApps,
  listDesktopActivity,
  clearDesktopActivity,
  captureDesktopPreviewFrame,
  focusAllowedDesktopWindow,
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

  ipcMain.handle('pi:desktop-control-permissions', async (event, payload = {}) => {
    assertMainWindow(event);
    const refresh = payload && typeof payload === 'object' ? payload.refresh === true : payload === true;
    return getDesktopPermissionStatus({ refresh });
  });

  ipcMain.handle('pi:desktop-control-open-permission-settings', async (event, payload = {}) => {
    assertMainWindow(event);
    const kind = payload && typeof payload === 'object' ? payload.kind : payload;
    return openDesktopPermissionSettings(kind);
  });

  ipcMain.handle('pi:desktop-control-app-mappings', async (event, payload = {}) => {
    assertMainWindow(event);
    try {
      const refresh = payload && typeof payload === 'object' ? payload.refresh === true : payload === true;
      return { ok: true, mappings: await listDesktopAppMappings({ refresh }) };
    } catch (cause) {
      return {
        ok: false,
        mappings: [],
        error: cause && cause.message ? String(cause.message) : String(cause),
        code: cause && cause.code ? cause.code : 'desktop_app_mappings_failed',
      };
    }
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

  ipcMain.handle('pi:desktop-control-preview-capture', async (event, payload = {}) => {
    assertMainWindow(event);
    try {
      return await captureDesktopPreviewFrame(payload && typeof payload === 'object' ? payload : {});
    } catch (cause) {
      return {
        ok: false,
        error: cause && cause.message ? String(cause.message) : String(cause),
        code: cause && cause.code ? cause.code : 'desktop_preview_failed',
      };
    }
  });

  ipcMain.handle('pi:desktop-control-focus-window', async (event, payload = {}) => {
    assertMainWindow(event);
    try {
      return await focusAllowedDesktopWindow(payload && typeof payload === 'object' ? payload : {});
    } catch (cause) {
      return {
        ok: false,
        error: cause && cause.message ? String(cause.message) : String(cause),
        code: cause && cause.code ? cause.code : 'desktop_focus_failed',
      };
    }
  });
}

module.exports = { registerDesktopControlIpc };
