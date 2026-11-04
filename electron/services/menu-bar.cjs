/**
 * macOS 菜单栏入口。
 *
 * 主窗口隐藏后，Tray 仍展示运行中的会话数量和完成状态。点击后打开一个
 * 独立的小型 BrowserWindow，避免把整个主界面塞进菜单栏。
 */

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} = require('electron');
const { getWindow } = require('../core/state.cjs');
const {
  getMenuBarEnabled,
  getPalette,
  getRadiusPreset,
  getTheme,
} = require('../core/app-settings.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  createMenuBarState,
  menuBarPopoverHeight,
  shouldPresentBackgroundNotification,
} = require('../menu-bar-state.cjs');
const { subscribeMenuBarEvent } = require('../menu-bar-events.cjs');
const { playCompletionSound } = require('../completion-sound.cjs');
const { themeBackground } = require('../theme.cjs');
const { showMainWindow } = require('../window.cjs');
const { openAndCheckForUpdates } = require('./updater.cjs');
const { interruptConversation } = require('../ipc/sessions.cjs');

const POPOVER_WIDTH = 360;
const COMPLETION_CHIME_GAP = 800;
const TRAY_CLICK_GUARD_DURATION = 180;
const state = createMenuBarState();

let initialized = false;
let tray;
let popover;
let popoverReady;
let ipcRegistered = false;
let unsubscribeSessionEvents;
let lastCompletionChimeAt = 0;
let trayClickGuardUntil = 0;

function storedTheme() {
  return getTheme();
}

function storedPalette() {
  return getPalette();
}

function menuBarEnabled() {
  return getMenuBarEnabled();
}

function trayImage(running) {
  const filename = running ? 'trayRunningTemplate.png' : 'trayTemplate.png';
  const image = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', filename));
  if (!image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function snapshot() {
  return state.snapshot({
    theme: storedTheme(),
    palette: storedPalette(),
    radii: getRadiusPreset(),
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    enabled: menuBarEnabled(),
  });
}

function broadcast() {
  if (!popover || popover.isDestroyed() || popover.webContents.isLoading()) return;
  positionPopover();
  popover.webContents.send('pi:menu-bar-updated', snapshot());
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const current = snapshot();
  const runningCount = current.running.length;
  const attentionCount = current.attention.length;
  const unreadErrorCount = current.recent.filter(item => item.unread && item.status === 'error').length;
  const title = attentionCount > 0 || unreadErrorCount > 0
    ? '!'
    : runningCount > 0
      ? String(runningCount)
      : current.unreadCount > 0
        ? '•'
        : '';
  if (process.platform === 'darwin') tray.setTitle(title, { fontType: 'monospacedDigit' });
  if (attentionCount > 0) {
    tray.setToolTip(`${attentionCount} 个 Pi 会话需要处理`);
  } else if (unreadErrorCount > 0) {
    tray.setToolTip(`${unreadErrorCount} 个 Pi 会话异常待查看`);
  } else if (runningCount > 0) {
    const names = current.running.slice(0, 2).map(item => item.title).join(' · ');
    tray.setToolTip(`${runningCount} 个 Pi 会话正在运行${names ? `\n${names}` : ''}`);
  } else if (current.recent.some(item => item.unread)) {
    tray.setToolTip('Pi Studio 有新的完成结果');
  } else {
    tray.setToolTip('Pi Studio');
  }
  tray.setImage(trayImage(runningCount > 0));
  broadcast();
}

/** 主题或配色变化时刷新弹层数据与原生窗口底色。 */
function refreshMenuBarAppearance() {
  refreshTray();
  if (popover && !popover.isDestroyed()) {
    popover.setBackgroundColor(themeBackground(storedTheme(), nativeTheme.shouldUseDarkColors));
  }
}

function positionPopover() {
  if (!tray || !popover || tray.isDestroyed() || popover.isDestroyed()) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const { workArea } = display;
  const width = Math.min(POPOVER_WIDTH, workArea.width - 16);
  const height = Math.min(menuBarPopoverHeight(snapshot()), workArea.height - 16);
  const x = Math.max(
    workArea.x + 8,
    Math.min(
      Math.round(trayBounds.x + trayBounds.width / 2 - width / 2),
      workArea.x + workArea.width - width - 8,
    ),
  );
  const below = trayBounds.y < workArea.y + workArea.height / 2;
  const preferredY = below ? trayBounds.y + trayBounds.height + 6 : trayBounds.y - height - 6;
  const y = Math.max(workArea.y + 8, Math.min(preferredY, workArea.y + workArea.height - height - 8));
  popover.setBounds({ x, y, width, height }, false);
}

function ensurePopover() {
  if (popover && !popover.isDestroyed()) return popover;
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: menuBarPopoverHeight(snapshot()),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: true,
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '..', 'menu-bar-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popover.setAlwaysOnTop(true, 'pop-up-menu');
  if (process.platform === 'darwin') {
    popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  popover.on('blur', () => {
    if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
    trayClickGuardUntil = Date.now() + TRAY_CLICK_GUARD_DURATION;
    popover.hide();
  });
  popover.on('closed', () => {
    popover = undefined;
    popoverReady = undefined;
  });
  popoverReady = popover.loadFile(path.join(__dirname, '..', 'menu-bar.html'))
    .then(() => broadcast())
    .catch(() => undefined);
  return popover;
}

async function showMenuBarPopover() {
  if (!menuBarEnabled() || app.isQuitting) return;
  const win = ensurePopover();
  await popoverReady;
  if (win.isDestroyed() || app.isQuitting) return;
  positionPopover();
  win.setBackgroundColor(themeBackground(storedTheme(), nativeTheme.shouldUseDarkColors));
  win.show();
  broadcast();
}

function hideMenuBarPopover() {
  if (popover && !popover.isDestroyed()) popover.hide();
}

/** Windows、macOS 和 Linux 都使用系统提示音，音量与静音策略交给系统设置。 */
function playCompletionChime(now = Date.now()) {
  if (now - lastCompletionChimeAt < COMPLETION_CHIME_GAP) return false;
  lastCompletionChimeAt = now;
  try {
    return playCompletionSound({ beep: () => shell.beep() });
  } catch {
    return false;
  }
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(trayImage(false));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => {
    // 聚焦中的弹窗会先因点托盘而 blur；忽略紧随其后的 tray click，避免重新打开。
    if (Date.now() < trayClickGuardUntil) {
      trayClickGuardUntil = 0;
      return;
    }
    if (popover?.isVisible()) hideMenuBarPopover();
    else void showMenuBarPopover();
  });
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: '打开 Pi Studio', click: () => openMenuBarMain() },
      { label: '设置…', click: () => openMenuBarSettings() },
      { label: '检查更新…', click: () => checkMenuBarUpdates() },
      { type: 'separator' },
      { label: '退出 Pi Studio', click: () => { void requestMenuBarQuit(); } },
    ]);
    tray.popUpContextMenu(menu);
  });
  refreshTray();
  return tray;
}

function sendToMain(channel, payload) {
  const win = showMainWindow();
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function openMenuBarMain() {
  hideMenuBarPopover();
  sendToMain('pi:open-main');
}

function openMenuBarSettings() {
  hideMenuBarPopover();
  sendToMain('pi:open-settings');
}

function openMenuBarSession(input = {}) {
  if (typeof input.id !== 'string' || !input.id) return;
  state.markSeen(input.id);
  hideMenuBarPopover();
  sendToMain('pi:open-session', {
    id: input.id,
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    title: typeof input.title === 'string' ? input.title : '会话',
  });
  refreshTray();
}

function checkMenuBarUpdates() {
  hideMenuBarPopover();
  openAndCheckForUpdates();
}

async function stopMenuBarSession(input = {}) {
  if (typeof input.id !== 'string' || !input.id) throw new Error('会话参数无效');
  const running = state.snapshot().running.find(item => item.id === input.id);
  if (!running) return { ok: false, reason: 'not-running' };
  if (input.requestId && running.requestId && input.requestId !== running.requestId) {
    return { ok: false, reason: 'stale-run' };
  }
  const result = await interruptConversation(input.id);
  refreshTray();
  return { ok: Boolean(result?.wasRunning), reason: result?.wasRunning ? undefined : 'not-running' };
}

async function requestMenuBarQuit() {
  const running = state.snapshot().running;
  if (running.length > 0) {
    hideMenuBarPopover();
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '退出 Pi Studio？',
      message: `${running.length} 个会话仍在运行`,
      detail: '退出应用会停止这些运行。',
      buttons: ['继续运行', '退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return { quit: false };
  }
  app.quit();
  return { quit: true };
}

function showCompletionNotification(completed) {
  if (!Notification.isSupported()) return false;
  const failed = completed.status === 'error';
  const notification = new Notification({
    title: failed ? 'Pi Studio 任务需要查看' : 'Pi Studio 任务已完成',
    body: completed.title,
    silent: true,
  });
  notification.on('click', () => openMenuBarSession(completed));
  notification.show();
  return true;
}

function menuBarSettings() {
  return {
    available: process.platform === 'darwin',
    enabled: menuBarEnabled(),
    platform: process.platform,
  };
}

function setMenuBarVisible(visible) {
  const enabled = Boolean(visible);
  getStudioDatabase().setSetting('studio.app.menuBarEnabled', enabled);
  if (enabled) createTray();
  else {
    hideMenuBarPopover();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = undefined;
  }
  return menuBarSettings();
}

function initializeMenuBar() {
  if (initialized) return menuBarSettings();
  initialized = true;
  unsubscribeSessionEvents = subscribeMenuBarEvent((event) => {
    if (event.type === 'started') menuBarSessionStarted(event);
    else if (event.type === 'title') menuBarSessionTitle(event.id, event.title);
    else if (event.type === 'finished') menuBarSessionFinished(event);
    else if (event.type === 'attention') {
      if (state.setAttention(event)) refreshTray();
    } else if (event.type === 'attention-cleared') {
      if (state.clearAttention(event.id)) refreshTray();
    }
    else if (event.type === 'appearance') refreshMenuBarAppearance();
  });
  if (menuBarEnabled()) createTray();
  nativeTheme.on('updated', refreshMenuBarAppearance);
  return menuBarSettings();
}

function shutdownMenuBar() {
  nativeTheme.removeListener('updated', refreshMenuBarAppearance);
  initialized = false;
  unsubscribeSessionEvents?.();
  unsubscribeSessionEvents = undefined;
  hideMenuBarPopover();
  if (popover && !popover.isDestroyed()) popover.destroy();
  if (tray && !tray.isDestroyed()) tray.destroy();
  popover = undefined;
  tray = undefined;
}

function menuBarSessionStarted(input) {
  state.start(input);
  refreshTray();
}

function menuBarSessionTitle(id, title) {
  if (state.updateTitle(id, title)) refreshTray();
}

function menuBarSessionFinished(input) {
  const completed = state.finish(input);
  if (!completed || completed.status === 'cancelled') {
    refreshTray();
    return;
  }
  if (app.isQuitting) { refreshTray(); return; }
  const main = getWindow();
  if (!shouldPresentBackgroundNotification(main)) {
    refreshTray();
    return;
  }
  playCompletionChime();
  showCompletionNotification(completed);
  refreshTray();
}

function clearMenuBarRecent() {
  if (state.clearRecent()) refreshTray();
}

function menuBarSnapshot() {
  return snapshot();
}

/** Register the small, fixed IPC surface used by the renderer and popover. */
function registerMenuBarIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('pi:menu-bar-settings', () => menuBarSettings());
  ipcMain.handle('pi:menu-bar-set-visible', (_event, visible) => setMenuBarVisible(visible));
  ipcMain.handle('pi:menu-bar-state', () => menuBarSnapshot());
  ipcMain.on('pi:menu-bar-open-main', () => openMenuBarMain());
  ipcMain.on('pi:menu-bar-open-session', (_event, session) => openMenuBarSession(session));
  ipcMain.on('pi:menu-bar-session-seen', (_event, id) => {
    if (state.markSeen(id)) refreshTray();
  });
  ipcMain.on('pi:menu-bar-clear-recent', () => clearMenuBarRecent());
  ipcMain.handle('pi:menu-bar-stop-session', (_event, session) => stopMenuBarSession(session));
  ipcMain.on('pi:menu-bar-open-settings', () => openMenuBarSettings());
  ipcMain.on('pi:menu-bar-check-updates', () => checkMenuBarUpdates());
  ipcMain.on('pi:menu-bar-quit', () => { void requestMenuBarQuit(); });
  ipcMain.on('pi:menu-bar-hide', () => hideMenuBarPopover());
}

module.exports = {
  initializeMenuBar,
  shutdownMenuBar,
  registerMenuBarIpc,
  menuBarSettings,
  setMenuBarVisible,
  menuBarSnapshot,
  showMenuBarPopover,
  hideMenuBarPopover,
  openMenuBarMain,
  openMenuBarSettings,
  openMenuBarSession,
  stopMenuBarSession,
  requestMenuBarQuit,
  clearMenuBarRecent,
  menuBarSessionStarted,
  menuBarSessionTitle,
  menuBarSessionFinished,
  playCompletionChime,
};
