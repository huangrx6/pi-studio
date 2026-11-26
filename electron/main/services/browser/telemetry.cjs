/**
 * Lightweight, zero-CDP console and network telemetry for in-app browser tabs.
 *
 * Captures bounded per-tab console messages, page load failures, and HTTP
 * request/response metadata directly from Electron's webContents and session
 * webRequest hooks so Agent tools can inspect runtime cleanliness without
 * needing full Chrome DevTools Protocol enabled.
 */

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 300;
const MAX_PENDING_REQUESTS = 400;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_URL_CHARS = 800;

const CONSOLE_LEVELS = Object.freeze(['verbose', 'info', 'warning', 'error']);

/** @type {Map<number, Array<object>>} */
const consoleByContents = new Map();
/** @type {Map<number, Array<object>>} */
const networkByContents = new Map();
/** @type {Map<number, { webContentsId: number, url: string, method: string, resourceType: string, startedAt: number }>} */
const inflightRequests = new Map();
let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

function normalizeConsoleLevel(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return CONSOLE_LEVELS[Math.max(0, Math.min(CONSOLE_LEVELS.length - 1, Math.round(raw)))] || 'info';
  }
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'debug' || text === 'verbose') return 'verbose';
  if (text === 'warn' || text === 'warning') return 'warning';
  if (text === 'err' || text === 'error') return 'error';
  return 'info';
}

function pushBounded(map, webContentsId, entry, limit) {
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
  let list = map.get(webContentsId);
  if (!list) {
    list = [];
    map.set(webContentsId, list);
  }
  list.push(entry);
  while (list.length > limit) list.shift();
}

function recordConsoleEntry(webContentsId, input = {}) {
  const level = normalizeConsoleLevel(input.level);
  const entry = {
    id: nextId('con'),
    level,
    message: String(input.message || '').slice(0, MAX_MESSAGE_CHARS),
    source: String(input.source || '').slice(0, 300),
    line: Number.isSafeInteger(Number(input.line)) ? Number(input.line) : 0,
    kind: String(input.kind || 'console'),
    timestamp: Number(input.timestamp) || Date.now(),
  };
  pushBounded(consoleByContents, webContentsId, entry, MAX_CONSOLE_ENTRIES);
  return entry;
}

function recordNetworkStart(details = {}) {
  const webContentsId = Number(details.webContentsId);
  const requestId = Number(details.id);
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
  if (!Number.isSafeInteger(requestId)) return;
  const url = String(details.url || '');
  if (!/^https?:/i.test(url)) return;
  if (inflightRequests.size >= MAX_PENDING_REQUESTS) {
    const oldest = inflightRequests.keys().next().value;
    if (oldest !== undefined) inflightRequests.delete(oldest);
  }
  inflightRequests.set(requestId, {
    webContentsId,
    url: url.slice(0, MAX_URL_CHARS),
    method: String(details.method || 'GET').toUpperCase(),
    resourceType: String(details.resourceType || 'other'),
    startedAt: Number(details.timestamp) || Date.now(),
  });
}

function recordNetworkComplete(details = {}) {
  const requestId = Number(details.id);
  const pending = Number.isSafeInteger(requestId) ? inflightRequests.get(requestId) : null;
  if (pending) inflightRequests.delete(requestId);
  const webContentsId = Number(details.webContentsId) || pending?.webContentsId || 0;
  const url = String(details.url || pending?.url || '');
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0 || !/^https?:/i.test(url)) return null;
  const completedAt = Number(details.timestamp) || Date.now();
  const startedAt = pending?.startedAt || completedAt;
  const statusCode = Number.isFinite(Number(details.statusCode)) ? Number(details.statusCode) : 0;
  const entry = {
    id: nextId('net'),
    method: String(details.method || pending?.method || 'GET').toUpperCase(),
    url: url.slice(0, MAX_URL_CHARS),
    resourceType: String(details.resourceType || pending?.resourceType || 'other'),
    statusCode,
    ok: statusCode >= 200 && statusCode < 400,
    failed: statusCode >= 400,
    fromCache: Boolean(details.fromCache),
    durationMs: Math.max(0, Math.round(completedAt - startedAt)),
    error: '',
    timestamp: completedAt,
  };
  pushBounded(networkByContents, webContentsId, entry, MAX_NETWORK_ENTRIES);
  return entry;
}

function recordNetworkError(details = {}) {
  const requestId = Number(details.id);
  const pending = Number.isSafeInteger(requestId) ? inflightRequests.get(requestId) : null;
  if (pending) inflightRequests.delete(requestId);
  const webContentsId = Number(details.webContentsId) || pending?.webContentsId || 0;
  const url = String(details.url || pending?.url || '');
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0 || !/^https?:/i.test(url)) return null;
  const errorText = String(details.error || 'ERR_FAILED');
  if (errorText === 'net::ERR_ABORTED') return null;
  const completedAt = Number(details.timestamp) || Date.now();
  const startedAt = pending?.startedAt || completedAt;
  const entry = {
    id: nextId('net'),
    method: String(details.method || pending?.method || 'GET').toUpperCase(),
    url: url.slice(0, MAX_URL_CHARS),
    resourceType: String(details.resourceType || pending?.resourceType || 'other'),
    statusCode: 0,
    ok: false,
    failed: true,
    fromCache: false,
    durationMs: Math.max(0, Math.round(completedAt - startedAt)),
    error: errorText.slice(0, 240),
    timestamp: completedAt,
  };
  pushBounded(networkByContents, webContentsId, entry, MAX_NETWORK_ENTRIES);
  return entry;
}

function clearTabTelemetry(webContentsId, scope = 'all') {
  const id = Number(webContentsId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (scope === 'all' || scope === 'console') consoleByContents.delete(id);
  if (scope === 'all' || scope === 'network') {
    networkByContents.delete(id);
    for (const [reqId, item] of inflightRequests.entries()) {
      if (item.webContentsId === id) inflightRequests.delete(reqId);
    }
  }
}

function attachWebContentsTelemetry(contents) {
  if (!contents || contents.isDestroyed?.()) return;
  const id = contents.id;
  contents.on('console-message', (event, level, message, line, sourceId) => {
    // Electron 35+ passes a single event object; earlier versions pass positional args.
    if (event && typeof event === 'object' && typeof event.message === 'string') {
      recordConsoleEntry(id, {
        level: event.level,
        message: event.message,
        line: event.lineNumber,
        source: event.sourceId,
        kind: 'console',
      });
      return;
    }
    recordConsoleEntry(id, {
      level,
      message,
      line,
      source: sourceId,
      kind: 'console',
    });
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ERR_ABORTED
    recordConsoleEntry(id, {
      level: 'error',
      message: `${isMainFrame ? '页面加载失败' : '子资源加载失败'} (${errorCode}): ${errorDescription || 'unknown'}`,
      source: validatedURL || '',
      kind: 'load-error',
    });
  });
  contents.on('render-process-gone', (_event, details = {}) => {
    recordConsoleEntry(id, {
      level: 'error',
      message: `页面渲染进程异常退出: ${details.reason || 'unknown'}`,
      kind: 'crash',
    });
  });
  contents.on('destroyed', () => {
    clearTabTelemetry(id, 'all');
  });
}

function installBrowserNetworkTelemetry(browserSession) {
  if (!browserSession?.webRequest) return;
  browserSession.webRequest.onCompleted((details) => {
    recordNetworkComplete(details);
  });
  browserSession.webRequest.onErrorOccurred((details) => {
    recordNetworkError(details);
  });
}

function readConsoleEntries(webContentsId, options = {}) {
  const all = consoleByContents.get(Number(webContentsId)) || [];
  const levelFilter = options.level ? normalizeConsoleLevel(options.level) : '';
  const search = String(options.search || '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 60));
  const filtered = all.filter((item) => {
    if (levelFilter) {
      if (levelFilter === 'warning' && item.level !== 'warning' && item.level !== 'error') return false;
      if (levelFilter !== 'warning' && item.level !== levelFilter) return false;
    }
    if (search && !`${item.message} ${item.source}`.toLowerCase().includes(search)) return false;
    return true;
  });
  const entries = filtered.slice(-limit);
  const summary = {
    total: all.length,
    errors: all.filter((item) => item.level === 'error').length,
    warnings: all.filter((item) => item.level === 'warning').length,
  };
  if (options.clear === true) clearTabTelemetry(webContentsId, 'console');
  return { entries, summary };
}

function readNetworkEntries(webContentsId, options = {}) {
  const all = networkByContents.get(Number(webContentsId)) || [];
  const failedOnly = options.failedOnly === true;
  const statusMin = Number.isFinite(Number(options.statusMin)) ? Number(options.statusMin) : 0;
  const resourceType = String(options.resourceType || '').trim().toLowerCase();
  const urlIncludes = String(options.urlIncludes || '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 60));
  const filtered = all.filter((item) => {
    if (failedOnly && !item.failed) return false;
    if (statusMin > 0 && item.statusCode < statusMin && !item.error) return false;
    if (resourceType && item.resourceType.toLowerCase() !== resourceType) return false;
    if (urlIncludes && !item.url.toLowerCase().includes(urlIncludes)) return false;
    return true;
  });
  const entries = filtered.slice(-limit);
  const summary = {
    total: all.length,
    failed: all.filter((item) => item.failed).length,
  };
  if (options.clear === true) clearTabTelemetry(webContentsId, 'network');
  return { entries, summary };
}

function listBrowserConsole(tabId, options = {}) {
  const { resolveBrowserTab } = require('./tabs.cjs');
  const entry = resolveBrowserTab(tabId);
  const data = readConsoleEntries(entry.webContentsId, options);
  return { tabId: entry.id, url: entry.url, ...data };
}

function listBrowserNetwork(tabId, options = {}) {
  const { resolveBrowserTab } = require('./tabs.cjs');
  const entry = resolveBrowserTab(tabId);
  const data = readNetworkEntries(entry.webContentsId, options);
  return { tabId: entry.id, url: entry.url, ...data };
}

module.exports = {
  MAX_CONSOLE_ENTRIES,
  MAX_NETWORK_ENTRIES,
  attachWebContentsTelemetry,
  clearTabTelemetry,
  installBrowserNetworkTelemetry,
  listBrowserConsole,
  listBrowserNetwork,
  normalizeConsoleLevel,
  readConsoleEntries,
  readNetworkEntries,
  recordConsoleEntry,
  recordNetworkComplete,
  recordNetworkError,
  recordNetworkStart,
};
