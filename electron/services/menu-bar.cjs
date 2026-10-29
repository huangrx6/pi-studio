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
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
} = require('electron');
const {
  configPath,
  getWindow,
  readConfig,
  writeConfig,
} = require('../core/state.cjs');
const { createMenuBarState } = require('../menu-bar-state.cjs');
const { subscribeMenuBarEvent } = require('../menu-bar-events.cjs');
const { themeBackground } = require('../theme.cjs');
const { showMainWindow } = require('../window.cjs');
const { openAndCheckForUpdates } = require('./updater.cjs');

const POPOVER_WIDTH = 372;
const POPOVER_HEIGHT = 452;
const THEMES = new Set(['light', 'dark', 'system']);
const state = createMenuBarState();

let initialized = false;
let tray;
let popover;
let popoverReady;
let ipcRegistered = false;
let unsubscribeSessionEvents;

function storedTheme() {
  const theme = readConfig(configPath(), {}).theme;
  return THEMES.has(theme) ? theme : 'light';
}

function menuBarEnabled() {
  return readConfig(configPath(), {}).menuBarEnabled !== false;
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
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    enabled: menuBarEnabled(),
  });
}

function broadcast() {
  if (!popover || popover.isDestroyed() || popover.webContents.isLoading()) return;
  popover.webContents.send('pi:menu-bar-updated', snapshot());
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const current = snapshot();
  const runningCount = current.running.length;
  const title = runningCount > 0 ? String(runningCount) : current.unreadCount > 0 ? '✓' : '';
  if (process.platform === 'darwin') tray.setTitle(title, { fontType: 'monospacedDigit' });
  if (runningCount > 0) {
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

function positionPopover() {
  if (!tray || !popover || tray.isDestroyed() || popover.isDestroyed()) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const { workArea } = display;
  const x = Math.max(
    workArea.x + 8,
    Math.min(
      Math.round(trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2),
      workArea.x + workArea.width - POPOVER_WIDTH - 8,
    ),
  );
  const below = trayBounds.y < workArea.y + workArea.height / 2;
  const preferredY = below ? trayBounds.y + trayBounds.height + 6 : trayBounds.y - POPOVER_HEIGHT - 6;
  const y = Math.max(workArea.y + 8, Math.min(preferredY, workArea.y + workArea.height - POPOVER_HEIGHT - 8));
  popover.setPosition(x, y, false);
}

function ensurePopover() {
  if (popover && !popover.isDestroyed()) return popover;
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
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
    if (popover && !popover.isDestroyed()) popover.hide();
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

async function showMenuBarPopover({ automatic = false } = {}) {
  if (!menuBarEnabled()) return;
  const win = ensurePopover();
  await popoverReady;
  if (win.isDestroyed()) return;
  positionPopover();
  win.setBackgroundColor(themeBackground(storedTheme(), nativeTheme.shouldUseDarkColors));
  if (automatic) win.showInactive();
  else win.show();
  broadcast();
}

function hideMenuBarPopover() {
  if (popover && !popover.isDestroyed()) popover.hide();
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(trayImage(false));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => {
    if (popover?.isVisible()) hideMenuBarPopover();
    else void showMenuBarPopover();
  });
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: '打开 Pi Studio', click: () => openMenuBarMain() },
      { label: '设置…', click: () => openMenuBarSettings() },
      { label: '检查更新…', click: () => { hideMenuBarPopover(); openAndCheckForUpdates(); } },
      { type: 'separator' },
      { label: '退出 Pi Studio', click: () => app.quit() },
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
  state.markSeen();
  hideMenuBarPopover();
  sendToMain('pi:open-main');
  refreshTray();
}

function openMenuBarSettings() {
  state.markSeen();
  hideMenuBarPopover();
  sendToMain('pi:open-settings');
  refreshTray();
}

function openMenuBarSession(input = {}) {
  if (typeof input.id !== 'string' || !input.id) return;
  state.markSeen();
  hideMenuBarPopover();
  sendToMain('pi:open-session', {
    id: input.id,
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    title: typeof input.title === 'string' ? input.title : '会话',
  });
  refreshTray();
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
  const config = readConfig(configPath(), {});
  if (config.menuBarEnabled !== enabled) writeConfig(configPath(), { ...config, menuBarEnabled: enabled });
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
  });
  if (menuBarEnabled()) createTray();
  nativeTheme.on('updated', () => {
    refreshTray();
    if (popover && !popover.isDestroyed()) {
      popover.setBackgroundColor(themeBackground(storedTheme(), nativeTheme.shouldUseDarkColors));
    }
  });
  return menuBarSettings();
}

function shutdownMenuBar() {
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
  refreshTray();
  if (!completed || completed.status === 'cancelled' || !menuBarEnabled()) return;
  const main = getWindow();
  const backgrounded = !main || main.isDestroyed() || !main.isVisible() || !main.isFocused();
  if (backgrounded && process.platform === 'darwin') app.dock?.bounce('informational');
  // The completion card is part of the requested workflow, including while
  // the main window is visible. showInactive keeps typing focus in the editor.
  if (!app.isQuitting) void showMenuBarPopover({ automatic: true });
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
  ipcMain.on('pi:menu-bar-clear-recent', () => clearMenuBarRecent());
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
  clearMenuBarRecent,
  menuBarSessionStarted,
  menuBarSessionTitle,
  menuBarSessionFinished,
};
