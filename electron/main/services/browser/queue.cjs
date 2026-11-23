/**
 * Serial per-tab action queue with user takeover pause.
 */
/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();
/** @type {Set<string>} */
const pausedTabs = new Set();
let globalPaused = false;
/** @type {Set<(state: object) => void>} */
const listeners = new Set();

function emit() {
  const payload = {
    type: 'control',
    paused: globalPaused,
    pausedTabs: [...pausedTabs],
  };
  for (const listener of listeners) {
    try { listener(payload); } catch { /* ignore */ }
  }
}

function isBrowserControlPaused(tabId) {
  if (globalPaused) return true;
  if (tabId && pausedTabs.has(String(tabId))) return true;
  return false;
}

function setBrowserControlPaused(paused, tabId) {
  if (tabId) {
    if (paused) pausedTabs.add(String(tabId));
    else pausedTabs.delete(String(tabId));
  } else {
    globalPaused = Boolean(paused);
    if (!paused) pausedTabs.clear();
  }
  emit();
  return getBrowserControlState();
}

function getBrowserControlState() {
  return {
    paused: globalPaused,
    pausedTabs: [...pausedTabs],
  };
}

function subscribeBrowserControl(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function assertNotPaused(tabId) {
  if (isBrowserControlPaused(tabId)) {
    const error = new Error('用户已接管浏览器，Agent 操作已暂停');
    error.code = 'paused_by_user';
    throw error;
  }
}

function enqueueBrowserAction(tabId, work) {
  const key = String(tabId || '__none__');
  const previous = tails.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const next = previous
    .catch(() => {})
    .then(async () => {
      assertNotPaused(tabId);
      return work();
    })
    .finally(() => {
      release();
    });
  tails.set(key, gate.then(() => next).catch(() => {}));
  return next;
}

module.exports = {
  enqueueBrowserAction,
  getBrowserControlState,
  isBrowserControlPaused,
  setBrowserControlPaused,
  subscribeBrowserControl,
};
