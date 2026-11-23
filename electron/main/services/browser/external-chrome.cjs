/**
 * Optional attach to a user-launched Chrome with remote debugging (L4).
 *
 * Never the default path. Requires externalChromeEnabled + cdpEnabled.
 * Discovers targets via HTTP /json/list and drives pages over WebSocket CDP.
 * Does not import system cookies into Studio's persist:pi-browser profile.
 */
const { assertBrowserExternalChromeAllowed, getBrowserPreferences } = require('./settings.cjs');

/** @type {Map<string, object>} */
const sessions = new Map();
let sequence = 0;
/** @type {Set<(payload: object) => void>} */
const sessionListeners = new Set();

function nextId() {
  sequence += 1;
  return `ext_${Date.now().toString(36)}_${sequence}`;
}

function endpointBase(preferences = getBrowserPreferences()) {
  return String(preferences.externalChromeEndpoint || 'http://127.0.0.1:9222').replace(/\/$/, '');
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function projectExternalTarget(target) {
  return {
    id: target.id || target.targetId || '',
    type: target.type || 'unknown',
    title: target.title || '',
    url: target.url || '',
    description: target.description || '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl || '',
    devtoolsFrontendUrl: target.devtoolsFrontendUrl || '',
  };
}

async function listExternalChromeTargets() {
  const preferences = assertBrowserExternalChromeAllowed();
  const base = endpointBase(preferences);
  let version = null;
  let targets = [];
  try {
    version = await fetchJson(`${base}/json/version`);
  } catch (cause) {
    const error = new Error(
      `无法连接 Chrome 调试端口 ${base}。请用 --remote-debugging-port=9222 启动 Chrome，并确认设置中的地址。${cause && cause.message ? `（${cause.message}）` : ''}`,
    );
    error.code = 'external_chrome_unreachable';
    throw error;
  }
  try {
    const listed = await fetchJson(`${base}/json/list`);
    targets = Array.isArray(listed) ? listed.map(projectExternalTarget) : [];
  } catch (cause) {
    const error = new Error(`读取 Chrome 目标列表失败：${cause && cause.message ? cause.message : cause}`);
    error.code = 'external_chrome_list_failed';
    throw error;
  }
  const pages = targets.filter((row) => row.type === 'page' || row.type === 'iframe' || !row.type);
  return {
    ok: true,
    endpoint: base,
    browser: version?.Browser || version?.webSocketDebuggerUrl || '',
    userAgent: version?.['User-Agent'] || version?.UserAgent || '',
    targets: pages.slice(0, 50),
    attached: listExternalChromeSessions(),
    warning: '外接 Chrome 可触及本机已登录会话。请仅连接你明确信任的调试实例，并在不用时断开。',
  };
}

function truncateResult(value, limit = 40_000) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded === 'string' && encoded.length > limit) {
      return { truncated: true, size: encoded.length, note: '结果过大，已省略正文' };
    }
    return value;
  } catch {
    return { note: '结果不可 JSON 序列化' };
  }
}

/**
 * Minimal CDP client over WebSocket (Node 22+ global WebSocket).
 */
function createCdpSocket(webSocketDebuggerUrl) {
  if (!webSocketDebuggerUrl) throw new Error('目标缺少 webSocketDebuggerUrl');
  const socket = new WebSocket(webSocketDebuggerUrl);
  let next = 1;
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  let openPromise;

  openPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Chrome WebSocket 超时')), 8000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Chrome WebSocket 连接失败'));
    });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data || ''));
    } catch {
      return;
    }
    if (message && typeof message.id === 'number' && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  socket.addEventListener('close', () => {
    for (const [, entry] of pending) {
      entry.reject(new Error('Chrome WebSocket 已关闭'));
    }
    pending.clear();
  });

  async function send(method, params = {}) {
    await openPromise;
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Chrome WebSocket 未连接');
    const id = next;
    next += 1;
    const payload = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        socket.send(payload);
      } catch (cause) {
        pending.delete(id);
        reject(cause);
      }
    });
  }

  function close() {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  return { send, close, openPromise };
}

function listExternalChromeSessions() {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.id,
    targetId: entry.targetId,
    title: entry.title,
    url: entry.url,
    attachedAt: entry.attachedAt,
  }));
}


function emitExternalSessions(reason = 'change') {
  const payload = {
    type: 'external',
    reason,
    sessions: listExternalChromeSessions(),
  };
  for (const listener of sessionListeners) {
    try {
      listener(payload);
    } catch {
      // ignore bad subscribers
    }
  }
}

function subscribeExternalChromeSessions(listener) {
  if (typeof listener !== 'function') return () => {};
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}


async function attachExternalChromeTarget(targetId) {
  const discovery = await listExternalChromeTargets();
  const match = discovery.targets.find((row) => row.id === String(targetId || ''));
  if (!match) throw new Error(`找不到 Chrome 目标：${targetId}`);
  if (!match.webSocketDebuggerUrl) throw new Error('该目标没有调试 WebSocket（可能不是 page）');

  // Replace existing session for same target.
  for (const [id, entry] of sessions) {
    if (entry.targetId === match.id) {
      try {
        entry.client.close();
      } catch {
        // ignore
      }
      sessions.delete(id);
    }
  }

  const client = createCdpSocket(match.webSocketDebuggerUrl);
  await client.openPromise;
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
  } catch {
    // Some targets may not support all domains; keep connection.
  }

  const id = nextId();
  const entry = {
    id,
    targetId: match.id,
    title: match.title,
    url: match.url,
    attachedAt: Date.now(),
    client,
  };
  sessions.set(id, entry);
  emitExternalSessions('attach');
  return {
    ok: true,
    session: {
      sessionId: id,
      targetId: match.id,
      title: match.title,
      url: match.url,
      attachedAt: entry.attachedAt,
    },
    warning: discovery.warning,
  };
}

function getExternalSession(sessionId) {
  const entry = sessions.get(String(sessionId || ''));
  if (!entry) throw new Error(`找不到外接会话：${sessionId}`);
  return entry;
}

async function sendExternalChromeCdp(sessionId, method, params = {}) {
  assertBrowserExternalChromeAllowed();
  const name = String(method || '').trim();
  if (!name) throw new Error('需要 CDP method');
  if (/^(Browser\.|Target\.closeTarget|Target\.createTarget)/i.test(name)) {
    const error = new Error(`出于安全考虑，不允许 CDP 方法：${name}`);
    error.code = 'cdp_method_blocked';
    throw error;
  }
  const entry = getExternalSession(sessionId);
  const result = await entry.client.send(name, params && typeof params === 'object' ? params : {});
  // Refresh URL/title when possible.
  if (name === 'Page.navigate' || name === 'Page.reload') {
    try {
      const evalResult = await entry.client.send('Runtime.evaluate', {
        expression: '({ href: location.href, title: document.title })',
        returnByValue: true,
      });
      const value = evalResult?.result?.value;
      if (value?.href) entry.url = String(value.href);
      if (value?.title) entry.title = String(value.title);
    } catch {
      // ignore
    }
  }
  return {
    ok: true,
    sessionId: entry.id,
    targetId: entry.targetId,
    url: entry.url,
    method: name,
    result: truncateResult(result),
  };
}

async function navigateExternalChrome(sessionId, url) {
  const target = String(url || '').trim();
  if (!target) throw new Error('需要 url');
  return sendExternalChromeCdp(sessionId, 'Page.navigate', { url: target });
}

async function evaluateExternalChrome(sessionId, expression) {
  const source = String(expression || '').trim();
  if (!source) throw new Error('需要 expression');
  if (source.length > 20_000) throw new Error('脚本过长');
  const result = await sendExternalChromeCdp(sessionId, 'Runtime.evaluate', {
    expression: source,
    returnByValue: true,
    awaitPromise: true,
  });
  const remote = result.result?.result;
  let preview = remote?.value;
  try {
    const encoded = JSON.stringify(preview);
    if (typeof encoded === 'string' && encoded.length > 4000) {
      preview = `${encoded.slice(0, 4000)}…`;
    } else if (encoded !== undefined) {
      preview = encoded;
    } else {
      preview = remote?.description || String(preview);
    }
  } catch {
    preview = remote?.description || String(preview);
  }
  return {
    ok: true,
    sessionId: result.sessionId,
    url: result.url,
    preview: typeof preview === 'string' ? preview : JSON.stringify(preview),
    type: remote?.type,
  };
}

function detachExternalChrome(sessionId) {
  if (!sessionId) {
    for (const [, entry] of sessions) {
      try {
        entry.client.close();
      } catch {
        // ignore
      }
    }
    sessions.clear();
    emitExternalSessions('detach-all');
    return { ok: true, detached: 'all' };
  }
  const entry = sessions.get(String(sessionId));
  if (!entry) return { ok: false, error: '会话不存在' };
  try {
    entry.client.close();
  } catch {
    // ignore
  }
  sessions.delete(String(sessionId));
  emitExternalSessions('detach');
  return { ok: true, sessionId: String(sessionId) };
}

module.exports = {
  attachExternalChromeTarget,
  detachExternalChrome,
  evaluateExternalChrome,
  listExternalChromeSessions,
  listExternalChromeTargets,
  navigateExternalChrome,
  sendExternalChromeCdp,
  subscribeExternalChromeSessions,
};
