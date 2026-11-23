/**
 * Ask renderer browser shells to open or focus tabs, then wait for registry.
 */
const { BrowserWindow } = require('electron');
const {
  getBrowserTab,
  listBrowserTabs,
  registerBrowserTab,
  setActiveBrowserTab,
} = require('./tabs.cjs');

/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();

function broadcast(command) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pi:browser-command', command);
  }
}

function settleCommand(requestId, result, error) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(String(requestId));
  if (error) entry.reject(error instanceof Error ? error : new Error(String(error)));
  else entry.resolve(result);
  return true;
}

function waitForCommand(requestId, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('浏览器未响应打开请求。请先打开右侧浏览器面板。'));
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
  });
}

function requestId() {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function requestOpenBrowserTab(url, options = {}) {
  const target = String(url || '').trim();
  if (target) {
    const existing = listBrowserTabs().find((tab) => tab.url === target);
    if (existing && options.newTab !== true) {
      setActiveBrowserTab(existing.id);
      broadcast({ type: 'focus', tabId: existing.id });
      return existing;
    }
  }
  const id = requestId();
  const wait = waitForCommand(id, options.timeoutMs);
  broadcast({
    type: 'open',
    requestId: id,
    url: target,
    newTab: options.newTab !== false,
  });
  // Also nudge any window that has no browser panel yet: shell listens and opens workbench.
  return wait;
}

async function requestFocusBrowserTab(tabId) {
  const tab = getBrowserTab(tabId);
  if (!tab) throw new Error(`找不到浏览器标签：${tabId}`);
  setActiveBrowserTab(tab.id);
  broadcast({ type: 'focus', tabId: tab.id });
  return tab;
}

function acknowledgeBrowserCommand(payload = {}) {
  const id = String(payload.requestId || '');
  if (!id) return { ok: false };
  if (payload.error) {
    settleCommand(id, null, payload.error);
    return { ok: true };
  }
  let tab = null;
  if (payload.tab && payload.tab.webContentsId) {
    tab = registerBrowserTab({
      ...payload.tab,
      active: true,
    });
  } else if (payload.tabId) {
    tab = setActiveBrowserTab(payload.tabId);
  }
  settleCommand(id, tab || { ok: true });
  return { ok: true, tab };
}

module.exports = {
  acknowledgeBrowserCommand,
  requestFocusBrowserTab,
  requestOpenBrowserTab,
  settleCommand,
};
