/**
 * Serial per-tab action queue with user takeover pause and live activity broadcast.
 */
/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();
/** @type {Set<string>} */
const pausedTabs = new Set();
let globalPaused = false;
/** @type {Set<(state: object) => void>} */
const listeners = new Set();
/** @type {Map<number, { tabId: string, action: string, label: string, startedAt: number }>} */
const activeOps = new Map();
let opSequence = 0;
let idleTimer = null;
let lastActivity = {
  active: false,
  tabId: '',
  action: '',
  label: '',
  startedAt: 0,
};

function notify(payload) {
  for (const listener of listeners) {
    try { listener(payload); } catch { /* ignore */ }
  }
}

function emit() {
  notify({
    type: 'control',
    paused: globalPaused,
    pausedTabs: [...pausedTabs],
    activity: getBrowserActivityState(),
  });
}

function emitActivity() {
  notify({
    type: 'activity',
    ...getBrowserActivityState(),
  });
}

function getBrowserActivityState() {
  const current = [...activeOps.values()].at(-1);
  if (current) {
    return {
      active: true,
      tabId: current.tabId,
      action: current.action,
      label: current.label,
      startedAt: current.startedAt,
    };
  }
  return { ...lastActivity, active: false };
}

function beginBrowserActivity({ tabId = '', action = 'act', label = '' } = {}) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  opSequence += 1;
  const token = opSequence;
  const entry = {
    tabId: String(tabId || ''),
    action: String(action || 'act'),
    label: String(label || '').slice(0, 140),
    startedAt: Date.now(),
  };
  activeOps.set(token, entry);
  lastActivity = { ...entry, active: true };
  emitActivity();
  return token;
}

function endBrowserActivity(token) {
  if (!activeOps.has(token)) return;
  activeOps.delete(token);
  if (activeOps.size > 0) {
    emitActivity();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  // Keep the Stop pill steady across rapid consecutive tool calls without flickering.
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeOps.size === 0) {
      lastActivity = { ...lastActivity, active: false };
      emitActivity();
    }
  }, 650);
  idleTimer.unref?.();
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
  if (paused && activeOps.size === 0) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    lastActivity = { ...lastActivity, active: false };
  }
  emit();
  return getBrowserControlState();
}

function getBrowserControlState() {
  return {
    paused: globalPaused,
    pausedTabs: [...pausedTabs],
    activity: getBrowserActivityState(),
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
  beginBrowserActivity,
  endBrowserActivity,
  enqueueBrowserAction,
  getBrowserActivityState,
  getBrowserControlState,
  isBrowserControlPaused,
  setBrowserControlPaused,
  subscribeBrowserControl,
};
