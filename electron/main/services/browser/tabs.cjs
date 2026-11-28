/**
 * Registry of guest tabs that belong to the in-app browser partition.
 *
 * Renderer owns the <webview> elements and reports webContents IDs after
 * dom-ready. Agent tools and IPC then operate on those guests from main.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { webContents } = require('electron');
const { getBrowserSession } = require('./session.cjs');
const { attachWebContentsTelemetry } = require('./telemetry.cjs');

/** @type {Map<string, object>} */
const tabs = new Map();
const browserOwner = new AsyncLocalStorage();

function withBrowserOwner(owner, action) {
  return browserOwner.run(owner, action);
}

function currentBrowserOwner() { return browserOwner.getStore(); }

function ownerMatches(tab) {
  const owner = currentBrowserOwner();
  return tab && (!owner || tab.ownerKey === owner.key);
}
/** @type {Map<number, string>} */
const byWebContentsId = new Map();
/** @type {Set<(payload: object) => void>} */
const listeners = new Set();
let activeId = '';
let sequence = 0;

function nextGuestId() {
  sequence += 1;
  return `guest_${Date.now().toString(36)}_${sequence}`;
}

function projectTab(entry) {
  return {
    id: entry.id,
    url: entry.url || 'about:blank',
    title: entry.title || '',
    active: entry.id === activeId,
    loading: Boolean(entry.loading),
    webContentsId: entry.webContentsId || null,
  };
}

function emit(type, entry) {
  const payload = { type, tab: entry ? projectTab(entry) : null, tabs: listBrowserTabs() };
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // Ignore bad subscribers.
    }
  }
}

function listBrowserTabs() {
  return [...tabs.values()]
    .filter(ownerMatches)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(projectTab);
}

function getBrowserTab(id) {
  const tab = tabs.get(String(id || ''));
  return ownerMatches(tab) ? tab : null;
}

function activeBrowserTab() {
  return getBrowserTab(activeId) || [...tabs.values()].filter(ownerMatches)
    .sort((left, right) => right.lastActivated - left.lastActivated)[0] || null;
}

function resolveBrowserTab(id) {
  if (id) {
    const tab = getBrowserTab(id);
    if (!tab) throw new Error(`找不到浏览器标签：${id}`);
    return tab;
  }
  const active = activeBrowserTab();
  if (!active) throw new Error('当前没有打开的浏览器标签');
  return active;
}

function getTabWebContents(entry) {
  if (!entry?.webContentsId) return null;
  try {
    const contents = webContents.fromId(entry.webContentsId);
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  } catch {
    return null;
  }
}

function registerBrowserTab(input = {}) {
  const webContentsId = Number(input.webContentsId);
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
    throw new Error('浏览器标签需要有效的 webContentsId');
  }
  const existingByContents = byWebContentsId.get(webContentsId);
  const id = String(input.id || existingByContents || nextGuestId());
  const previous = tabs.get(id);
  if (previous && previous.webContentsId && previous.webContentsId !== webContentsId) {
    byWebContentsId.delete(previous.webContentsId);
  }
  if (existingByContents && existingByContents !== id) {
    const stale = tabs.get(existingByContents);
    if (stale) {
      tabs.delete(existingByContents);
      byWebContentsId.delete(webContentsId);
    }
  }
  const entry = {
    id,
    ownerKey: input.ownerKey,
    lastActivated: previous?.lastActivated || 0,
    webContentsId,
    url: typeof input.url === 'string' && input.url ? input.url : previous?.url || 'about:blank',
    title: typeof input.title === 'string' ? input.title : previous?.title || '',
    loading: Boolean(input.loading),
    windowId: Number.isSafeInteger(Number(input.windowId)) ? Number(input.windowId) : previous?.windowId || 0,
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  tabs.set(id, entry);
  byWebContentsId.set(webContentsId, id);
  if (!activeId || input.active === true) activeId = id;
  emit('tab', entry);
  return projectTab(entry);
}

function updateBrowserTab(id, patch = {}) {
  const entry = getBrowserTab(id);
  if (!entry) return null;
  if (typeof patch.url === 'string' && patch.url) entry.url = patch.url;
  if (typeof patch.title === 'string') entry.title = patch.title;
  if (patch.loading !== undefined) entry.loading = Boolean(patch.loading);
  if (patch.active === true) { activeId = entry.id; entry.lastActivated = Date.now(); }
  entry.updatedAt = Date.now();
  emit('tab', entry);
  return projectTab(entry);
}

function adoptBrowserTabs(oldKey, newKey) {
  for (const tab of tabs.values()) {
    if (tab.ownerKey === oldKey) tab.ownerKey = newKey;
  }
}

function unregisterBrowserTab(id) {
  const entry = getBrowserTab(id);
  if (!entry) return false;
  tabs.delete(entry.id);
  if (entry.webContentsId) byWebContentsId.delete(entry.webContentsId);
  if (activeId === entry.id) {
    activeId = tabs.keys().next().value || '';
  }
  emit('closed', entry);
  return true;
}

function unregisterByWebContentsId(webContentsId) {
  const id = byWebContentsId.get(Number(webContentsId));
  if (!id) return false;
  return unregisterBrowserTab(id);
}

function setActiveBrowserTab(id) {
  const entry = resolveBrowserTab(id);
  activeId = entry.id;
  entry.lastActivated = Date.now();
  emit('tab', entry);
  return projectTab(entry);
}

async function navigateBrowserTab(id, url) {
  const entry = resolveBrowserTab(id);
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target) && target !== 'about:blank' && !/^file:\/\//i.test(target)) {
    throw new Error('只支持 http(s)、本地 HTML 或 about:blank');
  }
  const contents = getTabWebContents(entry);
  if (!contents) throw new Error('浏览器标签尚未就绪');
  entry.loading = true;
  entry.url = target;
  emit('tab', entry);
  await contents.loadURL(target);
  try {
    entry.url = contents.getURL() || target;
    entry.title = contents.getTitle() || entry.title;
  } catch {
    // Navigation may have replaced the guest.
  }
  entry.loading = false;
  entry.updatedAt = Date.now();
  emit('tab', entry);
  return projectTab(entry);
}


async function controlBrowserTab(id, action) {
  const entry = resolveBrowserTab(id);
  const contents = getTabWebContents(entry);
  if (!contents) throw new Error('浏览器标签尚未就绪');
  const kind = String(action || '').toLowerCase();
  entry.loading = true;
  emit('tab', entry);
  try {
    if (kind === 'back') {
      if (!contents.canGoBack()) throw new Error('无法后退');
      contents.goBack();
    } else if (kind === 'forward') {
      if (!contents.canGoForward()) throw new Error('无法前进');
      contents.goForward();
    } else if (kind === 'reload') {
      contents.reload();
    } else {
      throw new Error(`不支持的导航动作：${action}`);
    }
  } catch (error) {
    entry.loading = false;
    emit('tab', entry);
    throw error;
  }
  // Give navigation a beat so URL/title settle for the tool result.
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    entry.url = contents.getURL() || entry.url;
    entry.title = contents.getTitle() || entry.title;
  } catch {
    // Guest may already be gone.
  }
  entry.loading = false;
  entry.updatedAt = Date.now();
  emit('tab', entry);
  return projectTab(entry);
}

function subscribeBrowserTabs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function installBrowserTabWatchers(app) {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview' || contents.session !== getBrowserSession()) return;
    const id = contents.id;
    attachWebContentsTelemetry(contents);
    contents.on('destroyed', () => {
      unregisterByWebContentsId(id);
    });
  });
}

module.exports = {
  currentBrowserOwner,
  withBrowserOwner,
  activeBrowserTab,
  adoptBrowserTabs,
  controlBrowserTab,
  getBrowserTab,
  getTabWebContents,
  installBrowserTabWatchers,
  listBrowserTabs,
  navigateBrowserTab,
  nextGuestId,
  projectTab,
  registerBrowserTab,
  resolveBrowserTab,
  setActiveBrowserTab,
  subscribeBrowserTabs,
  unregisterBrowserTab,
  unregisterByWebContentsId,
  updateBrowserTab,
};
