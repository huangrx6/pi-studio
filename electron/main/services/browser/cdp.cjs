/**
 * Guest-tab Chrome DevTools Protocol access (L4).
 *
 * Uses Electron webContents.debugger. Default off; requires cdpEnabled plus
 * an explicit site policy allow for action_class=cdp.
 */
const { getTabWebContents, resolveBrowserTab } = require('./tabs.cjs');
const { assertBrowserCdpAllowed, isBrowserCdpEnabled } = require('./settings.cjs');

/** @type {Map<string, { attached: boolean }>} */
const attachedByTab = new Map();

function isDebuggerAttached(contents) {
  try {
    return Boolean(contents?.debugger?.isAttached?.());
  } catch {
    return false;
  }
}

function detachDebugger(contents, tabId) {
  try {
    if (contents && !contents.isDestroyed() && isDebuggerAttached(contents)) {
      contents.debugger.detach();
    }
  } catch {
    // Best effort.
  }
  if (tabId) attachedByTab.delete(String(tabId));
}

function attachDebugger(contents, tabId) {
  if (!contents || contents.isDestroyed()) throw new Error('标签页面不可用');
  if (!isDebuggerAttached(contents)) {
    contents.debugger.attach('1.3');
  }
  attachedByTab.set(String(tabId), { attached: true });
  return contents;
}

async function sendCdpCommand(contents, method, params = {}) {
  if (!contents || contents.isDestroyed()) throw new Error('标签页面不可用');
  if (!isDebuggerAttached(contents)) {
    contents.debugger.attach('1.3');
  }
  return contents.debugger.sendCommand(method, params || {});
}

/**
 * Send a CDP method to a guest tab after dual gates.
 */
async function sendBrowserCdp(tabId, method, params = {}) {
  const name = String(method || '').trim();
  if (!name) throw new Error('需要 CDP method');
  if (name.length > 200) throw new Error('CDP method 过长');
  const blocked = /^(Browser\.|Target\.close|Target\.createTarget|Target\.attachToBrowserTarget)/i;
  if (blocked.test(name)) {
    const error = new Error(`出于安全考虑，不允许 CDP 方法：${name}`);
    error.code = 'cdp_method_blocked';
    throw error;
  }
  if (!isBrowserCdpEnabled()) {
    const error = new Error('完整 CDP 访问默认关闭。请在设置 → 浏览器 → 开发者模式中开启。');
    error.code = 'cdp_disabled';
    throw error;
  }
  const entry = resolveBrowserTab(tabId);
  assertBrowserCdpAllowed(entry.url);
  const contents = getTabWebContents(entry);
  if (!contents) throw new Error('标签尚未就绪（缺少 webContentsId）');
  attachDebugger(contents, entry.id);
  let result;
  try {
    result = await sendCdpCommand(contents, name, params && typeof params === 'object' ? params : {});
  } catch (cause) {
    const message = cause && cause.message ? String(cause.message) : String(cause || 'CDP 调用失败');
    const error = new Error(message);
    error.code = 'cdp_command_failed';
    throw error;
  }
  let preview = result;
  try {
    const encoded = JSON.stringify(result);
    if (typeof encoded === 'string' && encoded.length > 50_000) {
      preview = { truncated: true, size: encoded.length, note: '结果过大，已省略正文' };
    }
  } catch {
    preview = { ok: true, note: '结果不可 JSON 序列化' };
  }
  return {
    ok: true,
    tabId: entry.id,
    url: entry.url,
    method: name,
    result: preview,
  };
}

function detachBrowserCdp(tabId) {
  const entry = resolveBrowserTab(tabId);
  const contents = getTabWebContents(entry);
  detachDebugger(contents, entry.id);
  return { ok: true, tabId: entry.id };
}

function listBrowserCdpSessions() {
  return [...attachedByTab.entries()].map(([tabId, state]) => ({ tabId, attached: Boolean(state.attached) }));
}

module.exports = {
  detachBrowserCdp,
  listBrowserCdpSessions,
  sendBrowserCdp,
};
