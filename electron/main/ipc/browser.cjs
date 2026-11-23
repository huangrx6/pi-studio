/**
 * IPC surface for the in-app browser shell.
 */
const { BrowserWindow, dialog, ipcMain } = require('electron');
const {
  acknowledgeBrowserCommand,
  cancelBrowserDownload,
  clearBrowserData,
  clearBrowserDownload,
  clearBrowserDownloads,
  downloadsDirectory,
  getBrowserControlState,
  listBrowserContacts,
  listBrowserDownloads,
  listBrowserExtensions,
  listBrowserPasswords,
  listBrowserTabs,
  listExternalChromeTargets,
  attachExternalChromeTarget,
  detachExternalChrome,
  listExternalChromeSessions,
  loadBrowserExtension,
  openBrowserDownload,
  openBrowserDownloadsFolder,
  getBrowserAdvancedSettings,
  readSitePolicies,
  registerBrowserTab,
  removeBrowserContact,
  removeBrowserExtension,
  removeBrowserPassword,
  removeSitePolicy,
  resolveSiteAction,
  revealBrowserDownload,
  revealBrowserPassword,
  setBrowserControlPaused,
  setBrowserEvaluateEnabled,
  setBrowserPreferences,
  subscribeBrowserControl,
  subscribeBrowserDownloads,
  subscribeBrowserPreferences,
  subscribeBrowserTabs,
  subscribeExternalChromeSessions,
  unregisterBrowserTab,
  updateBrowserTab,
  upsertBrowserContact,
  upsertBrowserPassword,
  upsertSitePolicy,
  setActiveBrowserTab,
} = require('../services/browser/index.cjs');

function assertMainWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error('窗口不可用');
  return win;
}

function registerBrowserIpc() {
  ipcMain.handle('pi:browser-downloads', (event) => {
    assertMainWindow(event);
    return {
      downloads: listBrowserDownloads(),
      directory: downloadsDirectory(),
    };
  });

  ipcMain.handle('pi:browser-download-cancel', (event, id) => {
    assertMainWindow(event);
    return cancelBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-download-clear', (event, id) => {
    assertMainWindow(event);
    if (id) return clearBrowserDownload(id);
    return clearBrowserDownloads({ onlyFinished: true });
  });

  ipcMain.handle('pi:browser-download-reveal', async (event, id) => {
    assertMainWindow(event);
    return revealBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-download-open', async (event, id) => {
    assertMainWindow(event);
    return openBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-downloads-folder', async (event) => {
    assertMainWindow(event);
    return openBrowserDownloadsFolder();
  });

  ipcMain.handle('pi:browser-pick-download-directory', async (event) => {
    const win = assertMainWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择下载保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true };
    const preferences = setBrowserPreferences({ downloadDirectory: result.filePaths[0] });
    return { ok: true, path: preferences.downloadDirectory, preferences: getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-clear-data', async (event) => {
    assertMainWindow(event);
    return clearBrowserData();
  });

  ipcMain.handle('pi:browser-tabs', (event) => {
    assertMainWindow(event);
    return { tabs: listBrowserTabs() };
  });

  ipcMain.handle('pi:browser-tab-register', (event, payload) => {
    const win = assertMainWindow(event);
    const tab = registerBrowserTab({
      ...(payload && typeof payload === 'object' ? payload : {}),
      windowId: win.id,
    });
    return { ok: true, tab };
  });

  ipcMain.handle('pi:browser-tab-update', (event, payload) => {
    assertMainWindow(event);
    const id = payload?.id;
    if (!id) return { ok: false, error: '缺少标签 id' };
    const tab = updateBrowserTab(id, payload || {});
    return { ok: Boolean(tab), tab };
  });

  ipcMain.handle('pi:browser-tab-unregister', (event, id) => {
    assertMainWindow(event);
    return { ok: unregisterBrowserTab(id) };
  });

  ipcMain.handle('pi:browser-tab-activate', (event, id) => {
    assertMainWindow(event);
    return { ok: true, tab: setActiveBrowserTab(id) };
  });

  ipcMain.handle('pi:browser-command-ack', (event, payload) => {
    assertMainWindow(event);
    return acknowledgeBrowserCommand(payload || {});
  });

  ipcMain.handle('pi:browser-control-state', (event) => {
    assertMainWindow(event);
    return getBrowserControlState();
  });

  ipcMain.handle('pi:browser-control-pause', (event, payload) => {
    assertMainWindow(event);
    const paused = payload?.paused !== false;
    return setBrowserControlPaused(paused, payload?.tabId);
  });

  ipcMain.handle('pi:browser-site-policies', (event) => {
    assertMainWindow(event);
    return { policies: readSitePolicies() };
  });

  ipcMain.handle('pi:browser-site-policy-upsert', (event, payload) => {
    assertMainWindow(event);
    return { policies: upsertSitePolicy(payload || {}) };
  });

  ipcMain.handle('pi:browser-site-policy-remove', (event, payload) => {
    assertMainWindow(event);
    return {
      policies: removeSitePolicy(payload?.id || payload?.originPattern, payload?.actionClass),
    };
  });

  ipcMain.handle('pi:browser-site-policy-resolve', (event, payload) => {
    assertMainWindow(event);
    return resolveSiteAction(payload?.url, payload?.actionClass);
  });

  ipcMain.handle('pi:browser-advanced-settings', (event) => {
    assertMainWindow(event);
    return getBrowserAdvancedSettings();
  });

  ipcMain.handle('pi:browser-set-evaluate-enabled', (event, payload = {}) => {
    assertMainWindow(event);
    const enabled = setBrowserEvaluateEnabled(Boolean(payload.enabled));
    return { evaluateEnabled: enabled, ...getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-set-preferences', (event, payload = {}) => {
    assertMainWindow(event);
    const preferences = setBrowserPreferences(payload && typeof payload === 'object' ? payload : {});
    return { ok: true, preferences, ...getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-passwords', async (event) => {
    assertMainWindow(event);
    return listBrowserPasswords();
  });
  ipcMain.handle('pi:browser-password-upsert', async (event, payload = {}) => {
    assertMainWindow(event);
    return upsertBrowserPassword(payload);
  });
  ipcMain.handle('pi:browser-password-remove', async (event, payload = {}) => {
    assertMainWindow(event);
    return removeBrowserPassword(payload.id);
  });
  ipcMain.handle('pi:browser-password-reveal', async (event, payload = {}) => {
    assertMainWindow(event);
    return revealBrowserPassword(payload.id);
  });
  ipcMain.handle('pi:browser-contacts', (event) => {
    assertMainWindow(event);
    return listBrowserContacts();
  });
  ipcMain.handle('pi:browser-contact-upsert', (event, payload = {}) => {
    assertMainWindow(event);
    return upsertBrowserContact(payload);
  });
  ipcMain.handle('pi:browser-contact-remove', (event, payload = {}) => {
    assertMainWindow(event);
    return removeBrowserContact(payload.id);
  });
  ipcMain.handle('pi:browser-extensions', (event) => {
    assertMainWindow(event);
    return listBrowserExtensions();
  });
  ipcMain.handle('pi:browser-extension-load', async (event, payload = {}) => {
    const win = assertMainWindow(event);
    let target = typeof payload.path === 'string' ? payload.path : '';
    if (!target) {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择解压后的扩展目录',
        properties: ['openDirectory'],
      });
      if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, cancelled: true };
      target = picked.filePaths[0];
    }
    return loadBrowserExtension(target);
  });
  ipcMain.handle('pi:browser-extension-remove', (event, payload = {}) => {
    assertMainWindow(event);
    return removeBrowserExtension(payload.id || payload.path);
  });


  ipcMain.handle('pi:browser-external-targets', async (event) => {
    assertMainWindow(event);
    return listExternalChromeTargets();
  });

  ipcMain.handle('pi:browser-external-attach', async (event, payload = {}) => {
    assertMainWindow(event);
    return attachExternalChromeTarget(payload.targetId);
  });

  ipcMain.handle('pi:browser-external-detach', (event, payload = {}) => {
    assertMainWindow(event);
    return detachExternalChrome(payload.sessionId);
  });

  ipcMain.handle('pi:browser-external-sessions', (event) => {
    assertMainWindow(event);
    return { sessions: listExternalChromeSessions() };
  });

  subscribeBrowserDownloads((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pi:browser-event', payload);
    }
  });

  subscribeBrowserTabs((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pi:browser-event', { ...payload, type: payload.type || 'tab' });
    }
  });

  subscribeBrowserControl((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pi:browser-event', payload);
    }
  });

  subscribeBrowserPreferences((preferences) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pi:browser-event', { type: 'preferences', preferences });
    }
  });

  subscribeExternalChromeSessions((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pi:browser-event', payload);
    }
  });
}

module.exports = { registerBrowserIpc };
