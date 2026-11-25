/**
 * In-app browser preferences and L4 gates (evaluate / CDP / external Chrome).
 *
 * Defaults stay conservative: Agent control is on for the workbench browser,
 * while script evaluation, full CDP, and external Chrome attach stay off.
 */
const path = require('node:path');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { downloadsDirectory } = require('../../core/studio-paths.cjs');
const { assertSiteActionAllowed, resolveSiteAction } = require('./site-policy.cjs');

const EVALUATE_SETTING_KEY = 'studio.browser.evaluateEnabled';
const PREFERENCES_SETTING_KEY = 'studio.browser.preferences';

/** @type {Set<(preferences: object) => void>} */
const preferenceListeners = new Set();

const OPEN_TARGETS = new Set(['workbench', 'system']);
const ANNOTATED_MODES = new Set(['always', 'never']);
const HISTORY_ACCESS = new Set(['allow', 'ask', 'deny']);

const DEFAULT_PREFERENCES = Object.freeze({
  /** Master switch: Agent may use workbench browser tools when permissions allow. */
  agentControlEnabled: true,
  /** Show path + query + hash in the address bar (display only). */
  showFullUrl: false,
  /** Where http(s) links open by default. */
  webLinkOpenTarget: 'workbench',
  /** Where all local links open by default (localhost / file / paths). */
  localLinkOpenTarget: 'workbench',
  /**
   * Tell the Agent (session instructions + browser section) to follow
   * web/local open targets. Off = soft preference only in the UI.
   */
  linkOpenInstructAgent: true,
  /**
   * Hard-block bash open / Playwright / system browser when the matching
   * open target is workbench. Off = Agent may still launch system apps.
   */
  linkOpenBlockExternal: true,
  /** Whether Agent actions draw on-page highlights. */
  annotatedScreenshots: 'always',
  /** Ask where to save each download. */
  askDownloadPath: false,
  /** Optional custom download directory (empty = Studio default). */
  downloadDirectory: '',
  /** Whether Agent tools may read in-app browsing history. */
  historyAccess: 'ask',
  /** L4: page script evaluation (also needs site evaluate=allow). */
  evaluateEnabled: false,
  /** L4: full Chrome DevTools Protocol on guest tabs. */
  cdpEnabled: false,
  /** L4: attach to a user-launched Chrome with remote debugging. */
  externalChromeEnabled: false,
  /** Remote debugging HTTP endpoint, e.g. http://127.0.0.1:9222 */
  externalChromeEndpoint: 'http://127.0.0.1:9222',
});

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function normalizeOpenTarget(value, fallback = 'workbench') {
  const next = String(value || '').trim().toLowerCase();
  return OPEN_TARGETS.has(next) ? next : fallback;
}

function normalizeAnnotated(value, fallback = 'always') {
  const next = String(value || '').trim().toLowerCase();
  return ANNOTATED_MODES.has(next) ? next : fallback;
}

function normalizeHistoryAccess(value, fallback = 'ask') {
  const next = String(value || '').trim().toLowerCase();
  return HISTORY_ACCESS.has(next) ? next : fallback;
}

function normalizeEndpoint(value, fallback = DEFAULT_PREFERENCES.externalChromeEndpoint) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
  } catch {
    return fallback;
  }
}

function normalizeDownloadDirectory(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return '';
  return path.normalize(raw);
}

function normalizePreferences(input, legacyEvaluate) {
  const source = input && typeof input === 'object' ? input : {};
  const evaluateFallback = legacyEvaluate !== undefined
    ? normalizeBoolean(legacyEvaluate, false)
    : DEFAULT_PREFERENCES.evaluateEnabled;
  return {
    agentControlEnabled: normalizeBoolean(source.agentControlEnabled, DEFAULT_PREFERENCES.agentControlEnabled),
    showFullUrl: normalizeBoolean(source.showFullUrl, DEFAULT_PREFERENCES.showFullUrl),
    webLinkOpenTarget: normalizeOpenTarget(source.webLinkOpenTarget, DEFAULT_PREFERENCES.webLinkOpenTarget),
    localLinkOpenTarget: normalizeOpenTarget(source.localLinkOpenTarget, DEFAULT_PREFERENCES.localLinkOpenTarget),
    linkOpenInstructAgent: normalizeBoolean(source.linkOpenInstructAgent, DEFAULT_PREFERENCES.linkOpenInstructAgent),
    linkOpenBlockExternal: normalizeBoolean(source.linkOpenBlockExternal, DEFAULT_PREFERENCES.linkOpenBlockExternal),
    annotatedScreenshots: normalizeAnnotated(source.annotatedScreenshots, DEFAULT_PREFERENCES.annotatedScreenshots),
    askDownloadPath: normalizeBoolean(source.askDownloadPath, DEFAULT_PREFERENCES.askDownloadPath),
    downloadDirectory: normalizeDownloadDirectory(source.downloadDirectory),
    historyAccess: normalizeHistoryAccess(source.historyAccess, DEFAULT_PREFERENCES.historyAccess),
    evaluateEnabled: normalizeBoolean(
      source.evaluateEnabled !== undefined ? source.evaluateEnabled : evaluateFallback,
      evaluateFallback,
    ),
    cdpEnabled: normalizeBoolean(source.cdpEnabled, DEFAULT_PREFERENCES.cdpEnabled),
    externalChromeEnabled: normalizeBoolean(source.externalChromeEnabled, DEFAULT_PREFERENCES.externalChromeEnabled),
    externalChromeEndpoint: normalizeEndpoint(source.externalChromeEndpoint, DEFAULT_PREFERENCES.externalChromeEndpoint),
  };
}

function readLegacyEvaluate(db) {
  try {
    return db.getSettingWithRecovery(EVALUATE_SETTING_KEY, false, (value) => normalizeBoolean(value, false));
  } catch {
    return false;
  }
}

function getBrowserPreferences(db = getStudioDatabase()) {
  const legacy = readLegacyEvaluate(db);
  return db.getSettingWithRecovery(PREFERENCES_SETTING_KEY, null, (value) => normalizePreferences(value, legacy));
}

function setBrowserPreferences(patch, db = getStudioDatabase()) {
  const current = getBrowserPreferences(db);
  const next = normalizePreferences({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) }, current.evaluateEnabled);
  db.setSetting(PREFERENCES_SETTING_KEY, next);
  db.setSetting(EVALUATE_SETTING_KEY, next.evaluateEnabled);
  for (const listener of preferenceListeners) {
    try { listener(next); } catch { /* ignore bad subscribers */ }
  }
  return next;
}

function subscribeBrowserPreferences(listener) {
  if (typeof listener !== 'function') return () => {};
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function resolveLinkOpenTarget(url, db = getStudioDatabase()) {
  const preferences = getBrowserPreferences(db);
  // Same classification + preference rules as Agent intercept / instructions.
  const { resolveOpenDestination } = require('./open-target.cjs');
  return resolveOpenDestination(url, preferences).target;
}

function isBrowserEvaluateEnabled(db = getStudioDatabase()) {
  return getBrowserPreferences(db).evaluateEnabled;
}

function setBrowserEvaluateEnabled(enabled, db = getStudioDatabase()) {
  return setBrowserPreferences({ evaluateEnabled: Boolean(enabled) }, db).evaluateEnabled;
}

function isBrowserCdpEnabled(db = getStudioDatabase()) {
  return getBrowserPreferences(db).cdpEnabled;
}

function isBrowserExternalChromeEnabled(db = getStudioDatabase()) {
  return getBrowserPreferences(db).externalChromeEnabled;
}

function isBrowserAgentControlEnabled(db = getStudioDatabase()) {
  return getBrowserPreferences(db).agentControlEnabled;
}

function getBrowserAdvancedSettings(db = getStudioDatabase()) {
  const preferences = getBrowserPreferences(db);
  return {
    ...preferences,
    evaluateEnabled: preferences.evaluateEnabled,
    cdpEnabled: preferences.cdpEnabled,
    externalChromeEnabled: preferences.externalChromeEnabled,
    defaultDownloadDirectory: downloadsDirectory(),
  };
}

function assertBrowserAgentControlEnabled(db = getStudioDatabase()) {
  if (!isBrowserAgentControlEnabled(db)) {
    const error = new Error('已关闭「让 Agent 控制内置浏览器」。请在设置 → 浏览器中重新开启。');
    error.code = 'browser_agent_disabled';
    throw error;
  }
}

function assertBrowserEvaluateAllowed(url, db = getStudioDatabase()) {
  if (!isBrowserEvaluateEnabled(db)) {
    const error = new Error('页面脚本求值默认关闭。请在设置 → 浏览器 → 开发者模式中开启，并为站点授权 evaluate。');
    error.code = 'evaluate_disabled';
    throw error;
  }
  const resolved = resolveSiteAction(url, 'evaluate', db);
  if (resolved.decision !== 'allow') {
    const error = new Error(
      `站点尚未允许 evaluate：${resolved.origin || url || 'unknown'}（可在浏览器菜单或设置中允许）`,
    );
    error.code = 'site_policy_ask';
    error.details = resolved;
    throw error;
  }
  return assertSiteActionAllowed(url, 'evaluate', { requireAllow: true });
}

function assertBrowserCdpAllowed(url, db = getStudioDatabase()) {
  if (!isBrowserCdpEnabled(db)) {
    const error = new Error('完整 CDP 访问默认关闭。请在设置 → 浏览器 → 开发者模式中开启（风险升高）。');
    error.code = 'cdp_disabled';
    throw error;
  }
  const resolved = resolveSiteAction(url, 'cdp', db);
  if (resolved.decision === 'deny') {
    const error = new Error(`站点策略拒绝 CDP：${resolved.origin || url || 'unknown'}`);
    error.code = 'site_policy_deny';
    error.details = resolved;
    throw error;
  }
  if (resolved.decision !== 'allow') {
    const error = new Error(
      `站点尚未允许 CDP：${resolved.origin || url || 'unknown'}（请在设置中为该站点将 cdp 设为允许）`,
    );
    error.code = 'site_policy_ask';
    error.details = resolved;
    throw error;
  }
  return resolved;
}

function assertBrowserExternalChromeAllowed(db = getStudioDatabase()) {
  const preferences = getBrowserPreferences(db);
  if (!preferences.externalChromeEnabled) {
    const error = new Error('外接 Chrome 默认关闭。请在设置 → 浏览器 → 开发者模式中开启，并确认调试端口。');
    error.code = 'external_chrome_disabled';
    throw error;
  }
  if (!preferences.cdpEnabled) {
    const error = new Error('外接 Chrome 需要先开启完整 CDP 访问权限。');
    error.code = 'cdp_disabled';
    throw error;
  }
  return preferences;
}

function assertBrowserHistoryAccess(db = getStudioDatabase()) {
  const access = getBrowserPreferences(db).historyAccess;
  if (access === 'deny') {
    const error = new Error('已禁止 Agent 读取内嵌浏览器历史记录。');
    error.code = 'history_denied';
    throw error;
  }
  if (access === 'ask') {
    const error = new Error('读取浏览历史需要你在设置 → 浏览器中将「历史记录」改为始终允许。');
    error.code = 'history_ask';
    throw error;
  }
  return access;
}

module.exports = {
  DEFAULT_PREFERENCES,
  EVALUATE_SETTING_KEY,
  PREFERENCES_SETTING_KEY,
  assertBrowserAgentControlEnabled,
  assertBrowserCdpAllowed,
  assertBrowserEvaluateAllowed,
  assertBrowserExternalChromeAllowed,
  assertBrowserHistoryAccess,
  getBrowserAdvancedSettings,
  getBrowserPreferences,
  isBrowserAgentControlEnabled,
  isBrowserCdpEnabled,
  isBrowserEvaluateEnabled,
  isBrowserExternalChromeEnabled,
  resolveLinkOpenTarget,
  setBrowserEvaluateEnabled,
  setBrowserPreferences,
  subscribeBrowserPreferences,
};
