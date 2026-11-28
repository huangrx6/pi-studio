/**
 * Desktop control policy: master switch, allow-any, always-allow list, and hard blocks.
 * Application allowlisting is separate from OS system permissions (macOS & Windows).
 */
const { app } = require('electron');
const path = require('node:path');
const { getStudioDatabase } = require('../../core/studio-db.cjs');

const SETTING_KEY = 'desktopControl';

const DEFAULT_PREFERENCES = Object.freeze({
  enabled: false,
  allowAnyApp: false,
  alwaysAllow: Object.freeze([]),
});

/** Names that always refuse observation (case-insensitive, macOS & Windows). */
const BLOCKED_NAMES = new Set([
  'pi studio',
  'pi studio computer use',
  'terminal',
  'iterm',
  'iterm2',
  'warp',
  'alacritty',
  'kitty',
  'wezterm',
  'ghostty',
  'hyper',
  'securityagent',
  'loginwindow',
  'coreservicesuiagent',
  'installer',
  'softwareupdate',
  'usernotificationcenter',
  // Windows terminals, UAC, lock screen, and system elevation surfaces
  'cmd',
  'cmd.exe',
  'command prompt',
  '命令提示符',
  'powershell',
  'powershell.exe',
  'windows powershell',
  'pwsh',
  'pwsh.exe',
  'windows terminal',
  'windowsterminal',
  'windowsterminal.exe',
  'wt',
  'wt.exe',
  'conhost',
  'conhost.exe',
  'consent',
  'consent.exe',
  'credentialuibroker',
  'credentialuibroker.exe',
  'lockapp',
  'lockapp.exe',
  'logonui',
  'logonui.exe',
  'taskmgr',
  'taskmgr.exe',
  'task manager',
  '任务管理器',
  'regedit',
  'regedit.exe',
  'mmc',
  'mmc.exe',
]);

/** Bundle IDs / Windows exe & AUMIDs that always refuse observation. */
const BLOCKED_BUNDLE_IDS = new Set([
  'dev.pi.studio',
  'dev.pi.studio.computer-use',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'dev.warp.Warp',
  'org.alacritty',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'com.mitchellh.ghostty',
  'co.zeit.hyper',
  'com.apple.SecurityAgent',
  'com.apple.loginwindow',
  'com.apple.CoreServicesUIAgent',
  'com.apple.installer',
  'com.apple.SoftwareUpdate',
  'com.apple.UserNotificationCenter',
  // Windows exe names & UWP AUMIDs
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'wt.exe',
  'conhost.exe',
  'consent.exe',
  'credentialuibroker.exe',
  'lockapp.exe',
  'logonui.exe',
  'taskmgr.exe',
  'regedit.exe',
  'mmc.exe',
  'microsoft.windowsterminal_8wekyb3d8bbwe!app',
]);

/** Extra hard-block names for password / system settings surfaces. */
const EXTRA_BLOCKED_NAMES = new Set([
  'passwords',
  'keychain access',
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'system settings',
  'system preferences',
  'windows security',
  'windows 安全中心',
  'systemsettings',
  'systemsettings.exe',
  'control',
  'control.exe',
  'sechealthui',
  'sechealthui.exe',
]);

const EXTRA_BLOCKED_BUNDLE_IDS = new Set([
  'com.apple.Passwords',
  'com.apple.PasswordManager',
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.1password.1password-launcher',
  'com.bitwarden.desktop',
  'com.apple.systempreferences',
  'com.apple.Preferences',
  // Windows settings, security, and password managers
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'systemsettings.exe',
  'control.exe',
  'sechealthui.exe',
  'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel',
  'microsoft.sechealthui_8wekyb3d8bbwe!sechealthui',
]);

const BLOCKED_BUNDLE_IDS_LOWER = new Set(
  [...BLOCKED_BUNDLE_IDS, ...EXTRA_BLOCKED_BUNDLE_IDS].map((id) => String(id).toLowerCase()),
);

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function stableId(entry) {
  const bundleId = normalizeText(entry.bundleId);
  if (bundleId) return `bundle:${bundleId}`;
  const appPath = normalizeText(entry.path);
  if (appPath) return `path:${appPath}`;
  const name = normalizeText(entry.name);
  if (name) return `name:${name.toLowerCase()}`;
  return '';
}

function fallbackNameFromPath(appPath) {
  if (!appPath) return '';
  const base = appPath.includes('\\')
    ? path.win32.basename(appPath)
    : path.basename(appPath);
  return base.replace(/\.(app|exe)$/i, '');
}

function normalizeAllowEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const name = normalizeText(input.name);
  const bundleId = normalizeText(input.bundleId);
  const appPath = normalizeText(input.path);
  if (!name && !bundleId && !appPath) return null;
  const id = normalizeText(input.id) || stableId({ name, bundleId, path: appPath });
  if (!id) return null;
  return {
    id,
    name: name || fallbackNameFromPath(appPath) || bundleId || id,
    bundleId,
    path: appPath,
  };
}

function normalizePreferences(input) {
  const source = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const alwaysAllow = [];
  const rawList = Array.isArray(source.alwaysAllow) ? source.alwaysAllow : [];
  for (const item of rawList) {
    const entry = normalizeAllowEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    alwaysAllow.push(entry);
  }
  return {
    enabled: normalizeBoolean(source.enabled, DEFAULT_PREFERENCES.enabled),
    allowAnyApp: normalizeBoolean(source.allowAnyApp, DEFAULT_PREFERENCES.allowAnyApp),
    alwaysAllow,
  };
}

function getDesktopControlPreferences(db = getStudioDatabase()) {
  return db.getSettingWithRecovery(SETTING_KEY, DEFAULT_PREFERENCES, normalizePreferences);
}

function setDesktopControlPreferences(patch, db = getStudioDatabase()) {
  const current = getDesktopControlPreferences(db);
  const next = normalizePreferences({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  db.setSetting(SETTING_KEY, next);
  return next;
}

function selfIdentity() {
  let name = '';
  let bundleId = '';
  let appPath = '';
  try {
    name = normalizeText(app.getName());
  } catch {
    name = '';
  }
  try {
    bundleId = normalizeText(typeof app.getBundleId === 'function' ? app.getBundleId() : '');
  } catch {
    bundleId = '';
  }
  try {
    appPath = normalizeText(app.getAppPath());
  } catch {
    appPath = '';
  }
  // Dev Electron uses com.github.Electron on macOS or electron.exe on Windows; treat as self.
  if (!bundleId && process.platform === 'darwin') {
    try {
      const exe = normalizeText(process.execPath).toLowerCase();
      if (exe.includes('electron')) bundleId = 'com.github.Electron';
    } catch {
      /* ignore */
    }
  } else if (!bundleId && process.platform === 'win32') {
    try {
      const exeBase = path.win32.basename(normalizeText(process.execPath)).toLowerCase();
      if (exeBase) bundleId = exeBase;
    } catch {
      /* ignore */
    }
  }
  if (!name) name = 'Pi Studio';
  return { name, bundleId, path: appPath };
}

function matchesEntry(target, entry) {
  if (!target || !entry) return false;
  const targetBundle = normalizeKey(target.bundleId);
  const entryBundle = normalizeKey(entry.bundleId);
  // Bundle identity wins: same id matches; different ids never fall through to name/path.
  if (targetBundle && entryBundle) {
    return targetBundle === entryBundle;
  }

  const targetPath = normalizeKey(target.path);
  const entryPath = normalizeKey(entry.path);
  if (targetPath && entryPath) {
    if (targetPath === entryPath) return true;
    if (targetPath.endsWith('.app') && entryPath.startsWith(targetPath)) return true;
    if (entryPath.endsWith('.app') && targetPath.startsWith(entryPath)) return true;
    // If both sides carry a path and they disagree, do not match by display name.
    if (targetPath !== entryPath
      && !(targetPath.endsWith('.app') && entryPath.startsWith(targetPath))
      && !(entryPath.endsWith('.app') && targetPath.startsWith(entryPath))) {
      return false;
    }
  }

  const targetName = normalizeKey(target.name);
  const entryName = normalizeKey(entry.name);
  if (targetName && entryName && targetName === entryName) return true;
  return false;
}

function isBlockedApp(target, self = selfIdentity()) {
  if (!target) return true;
  if (matchesEntry(target, self)) return true;

  const name = normalizeKey(target.name);
  if (name && BLOCKED_NAMES.has(name)) return true;
  if (name && EXTRA_BLOCKED_NAMES.has(name)) return true;
  if (name) {
    const nameBlocks = new Set([...BLOCKED_NAMES, ...EXTRA_BLOCKED_NAMES]);
    for (const blocked of nameBlocks) {
      if (blocked.length < 4) continue;
      if (
        blocked === 'pi studio'
        || blocked === 'installer'
        || blocked === 'softwareupdate'
        || blocked === 'system settings'
        || blocked === 'system preferences'
        || blocked === 'passwords'
        || blocked === 'keychain access'
      ) {
        if (name === blocked) return true;
        continue;
      }
      if (name === blocked || name.startsWith(`${blocked} `) || name.endsWith(` ${blocked}`)) return true;
    }
  }

  const bundleId = normalizeText(target.bundleId);
  const bundleLower = bundleId.toLowerCase();
  if (bundleId && (BLOCKED_BUNDLE_IDS.has(bundleId) || EXTRA_BLOCKED_BUNDLE_IDS.has(bundleId) || BLOCKED_BUNDLE_IDS_LOWER.has(bundleLower))) {
    return true;
  }
  if (bundleId === 'com.github.Electron' && normalizeKey(self.bundleId) === 'com.github.electron') return true;
  const targetPath = normalizeText(target.path);
  if (targetPath) {
    const exeBase = (targetPath.includes('\\') ? path.win32.basename(targetPath) : path.basename(targetPath)).toLowerCase();
    if (exeBase.endsWith('.exe') && BLOCKED_BUNDLE_IDS_LOWER.has(exeBase)) return true;
  }
  return false;
}

/**
 * Session-scoped temporary app allowlist (in-memory only, cleared on session/app exit).
 * Powers Codex-style "允许此对话" in-chat approval without polluting permanent settings.
 * @type {Map<string, Array<{ id: string, name: string, bundleId: string, path: string }>>}
 */
const sessionAllowMap = new Map();

function isSessionAllowed(target, sessionId) {
  const key = normalizeText(sessionId);
  if (!key || !target) return false;
  const list = sessionAllowMap.get(key);
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((entry) => matchesEntry(target, entry));
}

function addSessionAllowApp(sessionId, input) {
  const key = normalizeText(sessionId);
  if (!key) return [];
  const entry = normalizeAllowEntry(input);
  if (!entry) {
    const error = new Error('请选择一个有效的应用程序。');
    error.code = 'desktop_invalid_app';
    throw error;
  }
  if (isBlockedApp(entry)) {
    const error = new Error('不能把自身、终端或系统授权界面加入允许列表。');
    error.code = 'desktop_blocked';
    throw error;
  }
  const current = sessionAllowMap.get(key) || [];
  if (!current.some((item) => item.id === entry.id || matchesEntry(entry, item))) {
    sessionAllowMap.set(key, [...current, entry]);
  }
  return sessionAllowMap.get(key) || [];
}

function clearSessionAllowApps(sessionId) {
  if (sessionId == null) {
    sessionAllowMap.clear();
    return;
  }
  const key = normalizeText(sessionId);
  if (key) sessionAllowMap.delete(key);
}

function isAlwaysAllowed(target, preferences = getDesktopControlPreferences()) {
  const list = Array.isArray(preferences.alwaysAllow) ? preferences.alwaysAllow : [];
  return list.some((entry) => matchesEntry(target, entry));
}

/**
 * Decide whether a desktop target may be observed.
 * @returns {{ decision: 'allow' | 'deny' | 'needs_approval', reason: string, code: string }}
 */
function decideDesktopAccess(target, options = {}) {
  const preferences = options.preferences || getDesktopControlPreferences(options.db);
  const self = options.self || selfIdentity();

  if (!preferences.enabled) {
    return {
      decision: 'deny',
      reason: '电脑操控已关闭。请在设置 → 电脑操控中打开总开关。',
      code: 'desktop_disabled',
    };
  }

  if (isBlockedApp(target, self)) {
    return {
      decision: 'deny',
      reason: '该应用属于自身、终端或系统授权界面，电脑操控不会观察它。',
      code: 'desktop_blocked',
    };
  }

  if (preferences.allowAnyApp || isAlwaysAllowed(target, preferences) || isSessionAllowed(target, options.sessionId)) {
    return {
      decision: 'allow',
      reason: preferences.allowAnyApp
        ? '已开启任意应用（仍排除阻断列表）。'
        : isAlwaysAllowed(target, preferences)
          ? '已在始终允许列表中。'
          : '已在当前对话中临时允许。',
      code: 'desktop_allowed',
    };
  }

  return {
    decision: 'needs_approval',
    reason: '该应用尚未授权。请在弹窗中选择「允许此对话」或「始终允许」，或前往设置 → 电脑操控的始终允许列表添加。',
    code: 'desktop_needs_approval',
  };
}

function assertDesktopEnabled(options = {}) {
  const preferences = options.preferences || getDesktopControlPreferences(options.db);
  if (preferences.enabled) return preferences;
  const error = new Error('电脑操控已关闭。请在设置 → 电脑操控中打开总开关。');
  error.code = 'desktop_disabled';
  throw error;
}

function assertDesktopAppAllowed(target, options = {}) {
  const verdict = decideDesktopAccess(target, options);
  if (verdict.decision === 'allow') return verdict;
  const error = new Error(verdict.reason);
  error.code = verdict.code;
  error.decision = verdict.decision;
  throw error;
}

function addAlwaysAllowApp(input, db = getStudioDatabase()) {
  const entry = normalizeAllowEntry(input);
  if (!entry) {
    const error = new Error('请选择一个有效的应用程序。');
    error.code = 'desktop_invalid_app';
    throw error;
  }
  if (isBlockedApp(entry)) {
    const error = new Error('不能把自身、终端或系统授权界面加入始终允许列表。');
    error.code = 'desktop_blocked';
    throw error;
  }
  const current = getDesktopControlPreferences(db);
  if (current.alwaysAllow.some((item) => item.id === entry.id || matchesEntry(entry, item))) {
    return current;
  }
  return setDesktopControlPreferences({
    alwaysAllow: [...current.alwaysAllow, entry],
  }, db);
}

function removeAlwaysAllowApp(idOrEntry, db = getStudioDatabase()) {
  const current = getDesktopControlPreferences(db);
  const needle = typeof idOrEntry === 'string'
    ? { id: idOrEntry }
    : normalizeAllowEntry(idOrEntry) || { id: normalizeText(idOrEntry?.id) };
  const nextList = current.alwaysAllow.filter((item) => {
    if (needle.id && item.id === needle.id) return false;
    if (needle.name || needle.bundleId || needle.path) return !matchesEntry(needle, item);
    return true;
  });
  return setDesktopControlPreferences({ alwaysAllow: nextList }, db);
}

module.exports = {
  SETTING_KEY,
  DEFAULT_PREFERENCES,
  BLOCKED_NAMES,
  BLOCKED_BUNDLE_IDS,
  normalizePreferences,
  normalizeAllowEntry,
  getDesktopControlPreferences,
  setDesktopControlPreferences,
  selfIdentity,
  isBlockedApp,
  isAlwaysAllowed,
  isSessionAllowed,
  addSessionAllowApp,
  clearSessionAllowApps,
  decideDesktopAccess,
  assertDesktopEnabled,
  assertDesktopAppAllowed,
  addAlwaysAllowApp,
  removeAlwaysAllowApp,
  matchesEntry,
};
