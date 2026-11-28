/**
 * IPC surface for the in-app browser shell.
 */
const { assertToolTab, toolContents } = require('../services/tool-window.cjs');
const { getWindow } = require('../core/state.cjs');
const { dialog, ipcMain, webContents } = require('electron');
const {
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
} = require('../services/browser/index.cjs');

function assertBrowserHost(event) {
  const win = getWindow();
  if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame ||
      (event.sender !== win.webContents && event.sender !== toolContents())) throw new Error('浏览器请求来源无效');
  return win;
}

function registerBrowserIpc() {
  ipcMain.handle('pi:browser-downloads', (event) => {
    assertBrowserHost(event);
    return {
      downloads: listBrowserDownloads(),
      directory: downloadsDirectory(),
    };
  });

  ipcMain.handle('pi:browser-download-cancel', (event, id) => {
    assertBrowserHost(event);
    return cancelBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-download-clear', (event, id) => {
    assertBrowserHost(event);
    if (id) return clearBrowserDownload(id);
    return clearBrowserDownloads({ onlyFinished: true });
  });

  ipcMain.handle('pi:browser-download-reveal', async (event, id) => {
    assertBrowserHost(event);
    return revealBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-download-open', async (event, id) => {
    assertBrowserHost(event);
    return openBrowserDownload(id);
  });

  ipcMain.handle('pi:browser-downloads-folder', async (event) => {
    assertBrowserHost(event);
    return openBrowserDownloadsFolder();
  });

  ipcMain.handle('pi:browser-pick-download-directory', async (event) => {
    const win = assertBrowserHost(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择下载保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true };
    const preferences = setBrowserPreferences({ downloadDirectory: result.filePaths[0] });
    return { ok: true, path: preferences.downloadDirectory, preferences: getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-clear-data', async (event) => {
    assertBrowserHost(event);
    return clearBrowserData();
  });

  ipcMain.handle('pi:browser-tabs', (event) => {
    assertBrowserHost(event);
    return { tabs: listBrowserTabs() };
  });

  ipcMain.handle('pi:browser-tab-register', (event, payload) => {
    const win = assertBrowserHost(event);
    const owner = assertToolTab(event, payload?.id, 'browser');
    const guest = webContents.fromId(Number(payload.webContentsId));
    if (guest?.getType() !== 'webview' || guest.hostWebContents !== event.sender) throw new Error('浏览器页签来源无效');
    const tab = registerBrowserTab({
      ...(payload && typeof payload === 'object' ? payload : {}),
      windowId: win.id, ownerKey: owner.key,
    });
    return { ok: true, tab };
  });

  ipcMain.handle('pi:browser-tab-update', (event, payload) => {
    assertBrowserHost(event);
    const id = payload?.id;
    if (!id) return { ok: false, error: '缺少标签 id' };
    const tab = updateBrowserTab(id, payload || {});
    return { ok: Boolean(tab), tab };
  });

  ipcMain.handle('pi:browser-tab-unregister', (event, id) => {
    assertBrowserHost(event);
    return { ok: unregisterBrowserTab(id) };
  });

  ipcMain.handle('pi:browser-control-state', (event) => {
    assertBrowserHost(event);
    return getBrowserControlState();
  });

  ipcMain.handle('pi:browser-control-pause', (event, payload) => {
    assertBrowserHost(event);
    const paused = payload?.paused !== false;
    return setBrowserControlPaused(paused, payload?.tabId);
  });

  ipcMain.handle('pi:browser-site-policies', (event) => {
    assertBrowserHost(event);
    return { policies: readSitePolicies() };
  });

  ipcMain.handle('pi:browser-site-policy-upsert', (event, payload) => {
    assertBrowserHost(event);
    return { policies: upsertSitePolicy(payload || {}) };
  });

  ipcMain.handle('pi:browser-site-policy-remove', (event, payload) => {
    assertBrowserHost(event);
    return {
      policies: removeSitePolicy(payload?.id || payload?.originPattern, payload?.actionClass),
    };
  });

  ipcMain.handle('pi:browser-site-policy-resolve', (event, payload) => {
    assertBrowserHost(event);
    return resolveSiteAction(payload?.url, payload?.actionClass);
  });

  ipcMain.handle('pi:browser-advanced-settings', (event) => {
    assertBrowserHost(event);
    return getBrowserAdvancedSettings();
  });

  ipcMain.handle('pi:browser-set-evaluate-enabled', (event, payload = {}) => {
    assertBrowserHost(event);
    const enabled = setBrowserEvaluateEnabled(Boolean(payload.enabled));
    return { evaluateEnabled: enabled, ...getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-set-preferences', (event, payload = {}) => {
    assertBrowserHost(event);
    const preferences = setBrowserPreferences(payload && typeof payload === 'object' ? payload : {});
    return { ok: true, preferences, ...getBrowserAdvancedSettings() };
  });

  ipcMain.handle('pi:browser-passwords', async (event) => {
    assertBrowserHost(event);
    return listBrowserPasswords();
  });
  ipcMain.handle('pi:browser-password-upsert', async (event, payload = {}) => {
    assertBrowserHost(event);
    return upsertBrowserPassword(payload);
  });
  ipcMain.handle('pi:browser-password-remove', async (event, payload = {}) => {
    assertBrowserHost(event);
    return removeBrowserPassword(payload.id);
  });
  ipcMain.handle('pi:browser-password-reveal', async (event, payload = {}) => {
    assertBrowserHost(event);
    return revealBrowserPassword(payload.id);
  });
  ipcMain.handle('pi:browser-contacts', (event) => {
    assertBrowserHost(event);
    return listBrowserContacts();
  });
  ipcMain.handle('pi:browser-contact-upsert', (event, payload = {}) => {
    assertBrowserHost(event);
    return upsertBrowserContact(payload);
  });
  ipcMain.handle('pi:browser-contact-remove', (event, payload = {}) => {
    assertBrowserHost(event);
    return removeBrowserContact(payload.id);
  });
  ipcMain.handle('pi:browser-extensions', (event) => {
    assertBrowserHost(event);
    return listBrowserExtensions();
  });
  ipcMain.handle('pi:browser-extension-load', async (event, payload = {}) => {
    const win = assertBrowserHost(event);
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
    assertBrowserHost(event);
    return removeBrowserExtension(payload.id || payload.path);
  });


  ipcMain.handle('pi:browser-external-targets', async (event) => {
    assertBrowserHost(event);
    return listExternalChromeTargets();
  });

  ipcMain.handle('pi:browser-external-attach', async (event, payload = {}) => {
    assertBrowserHost(event);
    return attachExternalChromeTarget(payload.targetId);
  });

  ipcMain.handle('pi:browser-external-detach', (event, payload = {}) => {
    assertBrowserHost(event);
    return detachExternalChrome(payload.sessionId);
  });

  ipcMain.handle('pi:browser-external-sessions', (event) => {
    assertBrowserHost(event);
    return { sessions: listExternalChromeSessions() };
  });

  function broadcast(payload) {
    const main = getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('pi:browser-event', payload);
    toolContents()?.send('pi:browser-event', payload);
  }
  subscribeBrowserDownloads(broadcast);
  subscribeBrowserTabs(payload => broadcast({ ...payload, type: payload.type || 'tab' }));
  subscribeBrowserControl(broadcast);
  subscribeBrowserPreferences(preferences => broadcast({ type: 'preferences', preferences }));
  subscribeExternalChromeSessions(broadcast);
}

module.exports = { registerBrowserIpc };
