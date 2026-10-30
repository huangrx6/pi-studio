/**
 * GitHub Release updater for Pi Studio.
 *
 * Checks are intentionally handled by the desktop app rather than GitHub
 * webhooks: a packaged client polls the public release feed in the background,
 * then uses Electron notifications and the in-app update surface for feedback.
 * Downloads require an explicit click. Once downloaded, the installer is kept
 * for either an immediate restart or the next normal application quit.
 */

const { app, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const { getWindow } = require('../core/state.cjs');
const { initialUpdateState, reduceUpdateState } = require('../update-state.cjs');

const STARTUP_CHECK_DELAY_MS = 25_000;
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FOCUS_CHECK_INTERVAL_MS = 20 * 60 * 1000;

let initialized = false;
let updateState = initialUpdateState();
let checkingPromise;
let downloadingPromise;
let installing = false;
let startupTimer;
let intervalTimer;
let lastCheckAt = 0;
let focusListener;
const activeNotifications = new Set();
const notifiedVersions = new Set();

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '更新操作暂时失败，请稍后重试。');
}

function snapshot() {
  return { ...updateState };
}

function apply(type, payload = {}) {
  updateState = reduceUpdateState(updateState, { type, ...payload });
  broadcast();
  return snapshot();
}

function sendWhenReady(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function broadcast() {
  const win = getWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  sendWhenReady(win, 'pi:update-state', snapshot());
}

/** Reveal the existing main window and ask the renderer to open its update card. */
function notifyUpdateUi() {
  // Lazy require avoids a window.cjs ↔ updater.cjs initialization cycle.
  const { showMainWindow } = require('../window.cjs');
  const win = showMainWindow();
  sendWhenReady(win, 'pi:open-update');
}

/** Menu action: reveal the update surface and immediately check the feed. */
function openAndCheckForUpdates() {
  notifyUpdateUi();
  void checkForUpdates({ interactive: true });
}

function showNativeNotification(title, body, version) {
  if (!Notification.isSupported()) return;
  if (version && notifiedVersions.has(version)) return;
  if (version) notifiedVersions.add(version);

  const notification = new Notification({
    title,
    body,
    silent: false,
  });
  activeNotifications.add(notification);
  notification.on('click', () => {
    activeNotifications.delete(notification);
    notifyUpdateUi();
  });
  notification.on('close', () => activeNotifications.delete(notification));
  notification.show();
}

function wireUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => apply('checking'));
  autoUpdater.on('update-available', (info) => {
    apply('available', { info });
    showNativeNotification(
      'Pi Studio 有新版本',
      `v${info?.version || '新版本'} 已可用。点击查看更新内容。`,
      info?.version,
    );
  });
  autoUpdater.on('update-not-available', (info) => apply('up-to-date', { info }));
  autoUpdater.on('download-progress', (progress) => apply('progress', { progress }));
  autoUpdater.on('update-downloaded', (info) => {
    apply('downloaded', { info });
    notifyUpdateUi();
    showNativeNotification(
      'Pi Studio 更新已准备好',
      '重启并安装，或在下次退出 Pi Studio 时自动安装。',
      `downloaded:${info?.version || updateState.latestVersion || 'unknown'}`,
    );
  });
  autoUpdater.on('error', (error) => {
    if (installing) {
      installing = false;
      app.isQuitting = false;
    }
    apply('error', { error: errorText(error) });
  });
}

function scheduleBackgroundChecks() {
  if (!app.isPackaged) return;
  startupTimer = setTimeout(() => {
    void checkForUpdates({ interactive: false, source: 'startup' });
  }, STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();
  intervalTimer = setInterval(() => {
    void checkForUpdates({ interactive: false, source: 'interval' });
  }, BACKGROUND_CHECK_INTERVAL_MS);
  intervalTimer.unref?.();

  focusListener = () => {
    if (Date.now() - lastCheckAt < FOCUS_CHECK_INTERVAL_MS) return;
    void checkForUpdates({ interactive: false, source: 'focus' });
  };
  app.on('browser-window-focus', focusListener);
}

function initializeUpdater() {
  if (initialized) return snapshot();
  initialized = true;
  updateState = initialUpdateState(app.getVersion());

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = true;
  autoUpdater.logger = {
    info: (message) => console.info('[updater]', message),
    warn: (message) => console.warn('[updater]', message),
    error: (message) => console.error('[updater]', message),
  };

  wireUpdaterEvents();
  lastCheckAt = Date.now();
  scheduleBackgroundChecks();
  return snapshot();
}

function getUpdateState() {
  return snapshot();
}

/**
 * Check the latest public GitHub Release. In development this returns an
 * explicit "unsupported" state instead of attempting a build metadata lookup.
 */
async function checkForUpdates({ interactive = false } = {}) {
  if (!initialized) initializeUpdater();
  if (checkingPromise) return checkingPromise;

  if (!app.isPackaged) {
    return apply('unsupported', {
      error: '开发模式不会连接 Release 服务。请使用打包后的 Pi Studio 检查更新。',
    });
  }

  lastCheckAt = Date.now();
  apply('checking');
  checkingPromise = autoUpdater.checkForUpdates()
    .then(() => snapshot())
    .catch((error) => {
      // electron-updater also emits an error event. Applying the same failure
      // again is harmless and keeps direct check failures consistent.
      if (updateState.state !== 'error') apply('error', { error: errorText(error) });
      return snapshot();
    })
    .finally(() => {
      checkingPromise = undefined;
      if (interactive && updateState.state === 'checking') {
        apply('idle');
      }
    });
  return checkingPromise;
}

async function downloadUpdate() {
  if (!initialized) initializeUpdater();
  if (downloadingPromise) return downloadingPromise;
  if (updateState.state === 'downloaded') return snapshot();

  if (updateState.state !== 'available') {
    await checkForUpdates({ interactive: true });
  }
  if (updateState.state !== 'available') return snapshot();

  apply('downloading');
  downloadingPromise = autoUpdater.downloadUpdate()
    .then(() => snapshot())
    .catch((error) => {
      if (updateState.state !== 'error') apply('error', { error: errorText(error) });
      return snapshot();
    })
    .finally(() => {
      downloadingPromise = undefined;
    });
  return downloadingPromise;
}

function installUpdate() {
  if (updateState.state !== 'downloaded') {
    throw new Error('更新尚未下载完成。');
  }
  // quitAndInstall closes windows before Electron emits before-quit. The close
  // interceptor in window.cjs must therefore be released before this call.
  installing = true;
  app.isQuitting = true;
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      installing = false;
      app.isQuitting = false;
      apply('error', { error: errorText(error) });
    }
  });
  return { started: true };
}

function updaterOwnsApplicationQuit() {
  return installing || updateState.state === 'downloaded';
}

function shutdownUpdater() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = undefined;
  intervalTimer = undefined;
  if (focusListener) app.removeListener('browser-window-focus', focusListener);
  focusListener = undefined;
  installing = false;
  for (const notification of activeNotifications) notification.close();
  activeNotifications.clear();
}

module.exports = {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  initializeUpdater,
  installUpdate,
  updaterOwnsApplicationQuit,
  notifyUpdateUi,
  openAndCheckForUpdates,
  shutdownUpdater,
};
