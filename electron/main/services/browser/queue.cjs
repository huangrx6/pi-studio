/**
 * Serial per-tab action queue with user takeover pause, continuous session
 * lifecycle tracking, and live activity broadcast.
 *
 * A browser session spans from the first browser_* tool call in a conversation
 * run until the run completes (`afterRun`), is aborted, or the user clicks Stop.
 * That keeps the live frame, Stop button, and virtual cursor steady across LLM
 * thinking gaps instead of flickering disconnect/reconnect between tool calls.
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
/** @type {Map<string, { tabId: string, startedAt: number, timer: NodeJS.Timeout | null }>} */
const activeSessions = new Map();
const SESSION_SAFETY_TTL_MS = 120_000;
let opSequence = 0;
let idleTimer = null;
let lastActivity = {
  active: false,
  thinking: false,
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
      thinking: false,
      tabId: current.tabId,
      action: current.action,
      label: current.label,
      startedAt: current.startedAt,
    };
  }
  if (!globalPaused && activeSessions.size > 0) {
    const session = [...activeSessions.values()].at(-1);
    return {
      active: true,
      thinking: true,
      tabId: lastActivity.tabId || session?.tabId || '',
      action: 'thinking',
      label: 'AI 思考下一步…',
      startedAt: session?.startedAt || lastActivity.startedAt || Date.now(),
    };
  }
  return { ...lastActivity, active: false, thinking: false };
}

function hasActiveBrowserSession() {
  return !globalPaused && (activeOps.size > 0 || activeSessions.size > 0);
}

function beginBrowserSession(sessionId, { tabId = '' } = {}) {
  const key = String(sessionId || '__default__');
  const existing = activeSessions.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    endBrowserSession(key);
  }, SESSION_SAFETY_TTL_MS);
  timer.unref?.();
  const entry = {
    tabId: String(tabId || existing?.tabId || lastActivity.tabId || ''),
    startedAt: existing?.startedAt || Date.now(),
    timer,
  };
  activeSessions.set(key, entry);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  emitActivity();
  return key;
}

function endBrowserSession(sessionId) {
  if (sessionId === undefined || sessionId === null) {
    for (const entry of activeSessions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    activeSessions.clear();
  } else {
    const key = String(sessionId);
    const existing = activeSessions.get(key);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    activeSessions.delete(key);
  }
  if (activeOps.size === 0 && activeSessions.size === 0) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    lastActivity = { ...lastActivity, active: false, thinking: false };
  }
  emitActivity();
}

function beginBrowserActivity({ tabId = '', action = 'act', label = '' } = {}) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  // Refresh active session safety timers while browser actions keep arriving.
  for (const [key, session] of activeSessions.entries()) {
    if (tabId) session.tabId = String(tabId);
    if (session.timer) clearTimeout(session.timer);
    const timer = setTimeout(() => endBrowserSession(key), SESSION_SAFETY_TTL_MS);
    timer.unref?.();
    session.timer = timer;
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
  lastActivity = { ...entry, active: true, thinking: false };
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
  if (activeSessions.size > 0 && !globalPaused) {
    // Stay active in "thinking" state until the conversation run finishes.
    emitActivity();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  // Keep the Stop pill steady across rapid consecutive tool calls without flickering.
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeOps.size === 0 && activeSessions.size === 0) {
      lastActivity = { ...lastActivity, active: false, thinking: false };
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
    lastActivity = { ...lastActivity, active: false, thinking: false };
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
  beginBrowserSession,
  endBrowserActivity,
  endBrowserSession,
  enqueueBrowserAction,
  getBrowserActivityState,
  getBrowserControlState,
  hasActiveBrowserSession,
  isBrowserControlPaused,
  setBrowserControlPaused,
  subscribeBrowserControl,
};
