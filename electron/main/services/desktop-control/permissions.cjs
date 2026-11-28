/**
 * macOS system permission checks for desktop observation and constrained actions.
 *
 * On macOS, permissions belong to the standalone "Pi Studio Computer Use.app" helper
 * (`dev.pi.studio.computer-use`) rather than the entire Pi Studio Electron app.
 */
const { shell } = require('electron');
const {
  HELPER_DISPLAY_NAME,
  HELPER_BUNDLE_ID,
  defaultHelperClient,
} = require('./helper-client.cjs');
const win32Adapter = require('./platform/win32.cjs');

const SCREEN_PREF_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PREF_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const WIN32_PRIVACY_URL = 'ms-settings:privacy';
const KEYBOARD_DENIED_MESSAGE = `macOS 拒绝了「${HELPER_DISPLAY_NAME}」通过 osascript 向 System Events 发送按键（1002）。请在系统设置的「隐私与安全性 → 辅助功能」中检查该辅助应用的授权，然后在 Pi Studio 的「电脑操控」设置中刷新权限。`;

// AXIsProcessTrusted() checks the helper. The osascript/System Events keyboard
// path is verified only when it actually dispatches a user's requested action.
function createKeyboardPermissionMonitor() {
  let status = 'unverified';
  function denied(cause) {
    const error = new Error(KEYBOARD_DENIED_MESSAGE, { cause });
    error.code = 'desktop_keyboard_permission';
    return error;
  }
  function assertAllowed() {
    if (status === 'denied') throw denied();
  }
  return {
    get status() { return status; },
    assertAllowed,
    async run(action, maySetAccessibleValue = false) {
      if (!maySetAccessibleValue) assertAllowed();
      try {
        const result = await action();
        if (result?.method !== 'AXValue' && status !== 'denied') status = 'available';
        return result;
      } catch (cause) {
        const diagnostic = cause?.cause?.stderr || cause?.stderr || cause?.message || '';
        if (!/\(1002\)\s*(?:\(-?\d+\))?\s*$/u.test(diagnostic)) throw cause;
        status = 'denied';
        throw denied(cause);
      }
    },
  };
}

function normalizeScreenStatus(value) {
  const status = String(value || 'unknown').trim().toLowerCase();
  if (status === 'granted' || status === 'denied' || status === 'restricted' || status === 'not-determined' || status === 'unknown') {
    return status;
  }
  return 'unknown';
}

function buildPermissionMessage(screenOk, accessibilityOk) {
  if (!screenOk && !accessibilityOk) {
    return `需要为「${HELPER_DISPLAY_NAME}」授予屏幕录制和辅助功能权限，才能观察窗口并执行点击/输入等操作。`;
  }
  if (!screenOk) {
    return `需要为「${HELPER_DISPLAY_NAME}」授予屏幕录制权限，才能截取已允许应用的窗口。`;
  }
  if (!accessibilityOk) {
    return `需要为「${HELPER_DISPLAY_NAME}」授予辅助功能权限，才能读取窗口结构并执行点击、输入、滚动、拖拽与快捷键。`;
  }
  return '';
}

function macPermissionState(screenRecording, accessibility, monitor) {
  const screenOk = screenRecording === 'granted';
  const keyboardInput = monitor?.status || 'unverified';
  const messages = [buildPermissionMessage(screenOk, accessibility)];
  if (keyboardInput === 'denied') messages.push(KEYBOARD_DENIED_MESSAGE);
  return {
    screenRecording,
    accessibility,
    keyboardInput,
    ready: screenOk && accessibility && keyboardInput !== 'denied',
    message: messages.filter(Boolean).join(' '),
  };
}

/**
 * @param {{
 *   helperClient?: typeof defaultHelperClient,
 *   restartHelper?: boolean,
 *   refresh?: boolean,
 *   platform?: string,
 * }} [deps]
 */
async function getDesktopPermissionStatus(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    return win32Adapter.getPermissionStatus(deps);
  }
  if (platform !== 'darwin') {
    return {
      platform,
      supported: false,
      screenRecording: 'unknown',
      accessibility: false,
      ready: false,
      message: '电脑操控目前支持 macOS 与 Windows。',
    };
  }

  const helperClient = deps.helperClient || defaultHelperClient;
  const restart = deps.restartHelper === true || deps.refresh === true;
  try {
    const response = await helperClient.getPermissions({ restart });
    const screenRecording = normalizeScreenStatus(response?.screenRecording);
    const accessibility = response?.accessibility === true;
    return {
      platform,
      supported: true,
      ...macPermissionState(screenRecording, accessibility, deps.keyboardMonitor),
      helper: {
        name: String(response?.helperName || HELPER_DISPLAY_NAME),
        bundleId: String(response?.bundleId || HELPER_BUNDLE_ID),
        path: String(response?.bundlePath || (typeof helperClient.resolveAppPath === 'function' ? helperClient.resolveAppPath() : '')),
        available: true,
      },
    };
  } catch (cause) {
    const detail = cause && cause.message ? String(cause.message) : String(cause);
    return {
      platform,
      supported: true,
      screenRecording: 'unknown',
      accessibility: false,
      ready: false,
      message: detail || `无法连接到「${HELPER_DISPLAY_NAME}」辅助应用。`,
      helper: {
        name: HELPER_DISPLAY_NAME,
        bundleId: HELPER_BUNDLE_ID,
        path: typeof helperClient.resolveAppPath === 'function' ? helperClient.resolveAppPath() : '',
        available: false,
        code: cause && cause.code ? String(cause.code) : 'desktop_helper_unavailable',
        error: detail,
      },
    };
  }
}

async function assertDesktopPermissions(kind = 'read', deps = {}) {
  if (kind === 'type' || kind === 'hotkey') deps.keyboardMonitor?.assertAllowed();
  const status = await getDesktopPermissionStatus(deps);
  if (!status.supported) {
    const error = new Error(status.message);
    error.code = 'desktop_unsupported_platform';
    error.status = status;
    throw error;
  }

  if (status.helper && status.helper.available === false) {
    const error = new Error(status.message || `未连接到 ${HELPER_DISPLAY_NAME} 辅助应用。`);
    error.code = status.helper.code || 'desktop_helper_unavailable';
    error.status = status;
    throw error;
  }

  const needsScreen = kind === 'screenshot' || kind === 'read';
  // `apps` intentionally does not require Accessibility: NSWorkspace can list running apps
  // so the agent/settings can suggest what to allow before full observation is ready.
  const needsAccessibility = kind === 'windows'
    || kind === 'snapshot'
    || kind === 'click'
    || kind === 'type'
    || kind === 'scroll'
    || kind === 'drag'
    || kind === 'hotkey'
    || kind === 'read'
    || kind === 'list';

  if (needsScreen && status.screenRecording !== 'granted') {
    const error = new Error(
      `屏幕录制权限未授予。请在系统设置中允许「${HELPER_DISPLAY_NAME}」录制屏幕后刷新状态并重试（无需重启 Pi Studio）。`,
    );
    error.code = 'desktop_screen_permission';
    error.status = status;
    throw error;
  }

  if (needsAccessibility && !status.accessibility) {
    const error = new Error(
      `辅助功能权限未授予。请在系统设置中允许「${HELPER_DISPLAY_NAME}」控制电脑后刷新状态并重试（无需重启 Pi Studio）。`,
    );
    error.code = 'desktop_accessibility_permission';
    error.status = status;
    throw error;
  }

  return status;
}

/**
 * Trigger macOS permission registration on the dedicated helper (so it appears in System Settings),
 * then open the corresponding System Settings Privacy pane.
 * @param {'screen' | 'accessibility' | string} kind
 * @param {{ shell?: typeof shell, helperClient?: typeof defaultHelperClient, platform?: string }} [deps]
 */
async function openDesktopPermissionSettings(kind, deps = {}) {
  const target = String(kind || '').trim().toLowerCase();
  const normalizedKind = target === 'accessibility' ? 'accessibility' : 'screen';
  const platform = deps.platform || process.platform;
  const url = platform === 'win32'
    ? WIN32_PRIVACY_URL
    : (normalizedKind === 'accessibility' ? ACCESSIBILITY_PREF_URL : SCREEN_PREF_URL);

  let prompted = false;
  if (platform === 'darwin') {
    const helperClient = deps.helperClient || defaultHelperClient;
    if (helperClient && typeof helperClient.requestPermission === 'function') {
      try {
        await helperClient.requestPermission(normalizedKind);
        prompted = true;
      } catch {
        /* still open System Settings even if helper registration failed */
      }
    }
  }

  const opener = deps.shell || shell;
  await opener.openExternal(url);
  return { ok: true, kind: normalizedKind, url, prompted };
}

module.exports = {
  createKeyboardPermissionMonitor,
  SCREEN_PREF_URL,
  ACCESSIBILITY_PREF_URL,
  getDesktopPermissionStatus,
  assertDesktopPermissions,
  openDesktopPermissionSettings,
};
