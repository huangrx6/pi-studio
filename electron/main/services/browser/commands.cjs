/**
 * Ask renderer browser shells to open or focus tabs, then wait for registry.
 */
const {
  getBrowserTab,
  projectTab,
  subscribeBrowserTabs,
  currentBrowserOwner,
  setActiveBrowserTab,
} = require('./tabs.cjs');

function dispatch(command) {
  return require('../tool-window.cjs').dispatchBrowserCommand(command);
}

async function requestOpenBrowserTab(url, options = {}) {
  const id = await dispatch({
    type: 'open', url, newTab: options.newTab === true, owner: currentBrowserOwner(),
  });
  const tab = getBrowserTab(id);
  if (tab) return projectTab(tab);
  return new Promise((resolve, reject) => {
    const off = subscribeBrowserTabs(event => {
      if (event.tab?.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(event.tab);
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error('浏览器标签未能完成加载'));
    }, options.timeoutMs || 12000);
    timer.unref?.();
  });
}

async function requestFocusBrowserTab(tabId) {
  const tab = getBrowserTab(tabId);
  if (!tab) throw new Error(`找不到浏览器标签：${tabId}`);
  setActiveBrowserTab(tab.id);
  await dispatch({ type: 'focus', tabId: tab.id });
  return tab;
}

function requestRevealBrowserTab(tabId) {
  const tab = tabId ? getBrowserTab(tabId) : null;
  void dispatch({ type: 'reveal', tabId: tab?.id || String(tabId || '') }).catch(() => {});
}

function requestCloseBrowserTab(tabId) {
  const tab = getBrowserTab(tabId);
  if (!tab) throw new Error(`找不到浏览器标签：${tabId}`);
  void dispatch({ type: 'close-tab', tabId: tab.id }).catch(() => {});
  return tab;
}

function requestSetBrowserViewport(tabId, viewport) {
  void dispatch({
    type: 'viewport',
    tabId: String(tabId || ''),
    viewport: viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
      ? {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        label: String(viewport.label || `${Math.round(viewport.width)}×${Math.round(viewport.height)}`),
      }
      : null,
  }).catch(() => {});
}

module.exports = {
  requestCloseBrowserTab,
  requestFocusBrowserTab,
  requestOpenBrowserTab,
  requestRevealBrowserTab,
  requestSetBrowserViewport,
};
