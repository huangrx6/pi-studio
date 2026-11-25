/**
 * macOS system permission checks for desktop observation and constrained actions.
 * Inject systemPreferences / shell / desktopCapturer in tests.
 *
 * Screen Recording is double-checked with a tiny desktopCapturer probe because
 * Electron getMediaAccessStatus("screen") can report granted even when the app
 * is not actually authorized in System Settings.
 */
const { desktopCapturer, shell, systemPreferences } = require('electron');

const SCREEN_PREF_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PREF_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

function normalizeScreenStatus(value) {
  const status = String(value || 'unknown').trim().toLowerCase();
  if (status === 'granted' || status === 'denied' || status === 'restricted' || status === 'not-determined' || status === 'unknown') {
    return status;
  }
  return 'unknown';
}

/**
 * Lightweight capture probe. Empty / black thumbnails usually mean no TCC grant.
 * @param {{ desktopCapturer?: typeof desktopCapturer }} [deps]
 * @returns {Promise<'granted' | 'missing'>}
 */
async function probeScreenRecordingAccess(deps = {}) {
  try {
    const capturer = deps.desktopCapturer || desktopCapturer;
    if (!capturer || typeof capturer.getSources !== 'function') return 'missing';
    const sources = await capturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
      fetchWindowIcons: false,
    });
    if (!Array.isArray(sources) || sources.length === 0) return 'missing';
    for (const source of sources) {
      try {
        const image = source && source.thumbnail;
        if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) continue;
        const size = typeof image.getSize === 'function' ? image.getSize() : null;
        if (!size || !(size.width > 0) || !(size.height > 0)) continue;
        if (typeof image.toBitmap === 'function') {
          const bitmap = image.toBitmap();
          if (!bitmap || !bitmap.length) continue;
          let lit = 0;
          // Pure black frames are common when capture is blocked.
          for (let i = 0; i < bitmap.length; i += 4) {
            if (bitmap[i] > 2 || bitmap[i + 1] > 2 || bitmap[i + 2] > 2) {
              lit += 1;
              if (lit >= 1) return 'granted';
            }
          }
          continue;
        }
        return 'granted';
      } catch {
        /* try next source */
      }
    }
    return 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * @param {{
 *   systemPreferences?: typeof systemPreferences,
 *   platform?: string,
 *   desktopCapturer?: typeof desktopCapturer,
 *   skipScreenProbe?: boolean,
 * }} [deps]
 */
async function getDesktopPermissionStatus(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') {
    return {
      platform,
      supported: false,
      screenRecording: 'unknown',
      accessibility: false,
      ready: false,
      message: '电脑操控目前仅支持 macOS。',
    };
  }

  const prefs = deps.systemPreferences || systemPreferences;
  let screenRecording = 'unknown';
  let accessibility = false;
  try {
    screenRecording = normalizeScreenStatus(prefs.getMediaAccessStatus('screen'));
  } catch {
    screenRecording = 'unknown';
  }
  try {
    accessibility = prefs.isTrustedAccessibilityClient(false) === true;
  } catch {
    accessibility = false;
  }

  // Always verify "granted" and ambiguous states. False positives confuse the settings UI.
  if (!deps.skipScreenProbe && screenRecording !== 'denied' && screenRecording !== 'restricted') {
    const probe = await probeScreenRecordingAccess(deps);
    if (probe === 'granted') {
      screenRecording = 'granted';
    } else if (screenRecording === 'granted') {
      // API claimed access but capture produced no usable frame.
      screenRecording = 'denied';
    } else if (screenRecording === 'unknown') {
      screenRecording = 'not-determined';
    }
  }

  const screenOk = screenRecording === 'granted';
  const ready = screenOk && accessibility;
  let message = '';
  if (!screenOk && !accessibility) {
    message = '需要屏幕录制和辅助功能权限，才能观察窗口并执行点击/输入等操作。';
  } else if (!screenOk) {
    message = '需要屏幕录制权限，才能截取已允许应用的窗口。';
  } else if (!accessibility) {
    message = '需要辅助功能权限，才能读取窗口结构并执行点击、输入、滚动、拖拽与快捷键。';
  }

  return {
    platform,
    supported: true,
    screenRecording,
    accessibility,
    ready,
    message,
  };
}

async function assertDesktopPermissions(kind = 'read', deps = {}) {
  const status = await getDesktopPermissionStatus(deps);
  if (!status.supported) {
    const error = new Error(status.message);
    error.code = 'desktop_unsupported_platform';
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
    const error = new Error('屏幕录制权限未授予。请在系统设置中允许 Pi Studio 录制屏幕后重试。授权后可能需要重启应用。');
    error.code = 'desktop_screen_permission';
    error.status = status;
    throw error;
  }

  if (needsAccessibility && !status.accessibility) {
    const error = new Error('辅助功能权限未授予。请在系统设置中允许 Pi Studio 控制电脑后重试（用于读取窗口并执行点击/输入等）。授权后可能需要重启应用。');
    error.code = 'desktop_accessibility_permission';
    error.status = status;
    throw error;
  }

  return status;
}

/**
 * @param {'screen' | 'accessibility' | string} kind
 * @param {{ shell?: typeof shell }} [deps]
 */
async function openDesktopPermissionSettings(kind, deps = {}) {
  const target = String(kind || '').trim().toLowerCase();
  const url = target === 'accessibility' ? ACCESSIBILITY_PREF_URL : SCREEN_PREF_URL;
  const opener = deps.shell || shell;
  await opener.openExternal(url);
  return { ok: true, kind: target === 'accessibility' ? 'accessibility' : 'screen', url };
}

module.exports = {
  SCREEN_PREF_URL,
  ACCESSIBILITY_PREF_URL,
  probeScreenRecordingAccess,
  getDesktopPermissionStatus,
  assertDesktopPermissions,
  openDesktopPermissionSettings,
};
