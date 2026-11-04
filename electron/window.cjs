/**
 * 窗口与应用菜单。
 *
 * 窗口创建时要先确定主题偏好（Studio SQLite 里的 theme），
 * 因为窗口的 backgroundColor 必须在创建时就给出，否则启动会闪白。
 */

const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DEV, getWindow, setWindow } = require('./core/state.cjs');
const { normalizeExternalHttpUrl } = require('./core/external-url.cjs');
const {
  isTrustedRendererUrl,
  rendererContentSecurityPolicy,
} = require('./core/web-security.cjs');
const {
  PALETTES,
  RADIUS_STYLES,
  THEMES,
  getPalette,
  getRadiusStyle,
  getTheme,
} = require('./core/app-settings.cjs');
const { getStudioDatabase } = require('./core/studio-db.cjs');
const { themeBackground } = require('./theme.cjs');
const { publishMenuBarEvent } = require('./menu-bar-events.cjs');

const configuredCspSessions = new WeakSet();

function installRendererSecurity(win, rendererUrl) {
  const session = win.webContents.session;
  if (!configuredCspSessions.has(session)) {
    const filter = DEV
      ? { urls: ['http://127.0.0.1:5180/*'] }
      : { urls: ['file://*/*'] };
    session.webRequest.onHeadersReceived(filter, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [rendererContentSecurityPolicy({ dev: DEV })],
        },
      });
    });
    configuredCspSessions.add(session);
  }

  win.webContents.on('will-navigate', (event, target) => {
    if (!isTrustedRendererUrl(target, {
      dev: DEV,
      devUrl: 'http://127.0.0.1:5180/',
      productionUrl: rendererUrl,
    })) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(normalizeExternalHttpUrl(url));
    } catch {
      // Deny malformed and non-HTTP popup targets.
    }
    return { action: 'deny' };
  });
  /**
   * Only the right-panel browser may attach a guest: it must use Studio's own
   * partition, carry no preload and stay sandboxed with node disabled. Anything
   * else (a future stray <webview> in extension UI, a model-driven URL) is
   * refused before a guest process starts.
   */
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = String(params?.src || '');
    const trusted = webPreferences?.partition === 'persist:pi-browser'
      && !webPreferences?.preload
      && !params?.preload
      && webPreferences?.nodeIntegration !== true;
    if (!trusted || !/^(https?:|about:blank$)/i.test(src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    delete params.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
}

/**
 * 创建主窗口。
 * 开发模式连 Vite dev server，生产模式加载打包后的 web-dist。
 */
function createWindow() {
  const existing = getWindow();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return existing;
  }

  const preference = getTheme();
  nativeTheme.themeSource = preference;

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: themeBackground(preference, nativeTheme.shouldUseDarkColors),
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The right-panel browser hosts untrusted pages in its own process and
      // partition; the renderer only gets navigation controls.
      webviewTag: true,
    },
  });

  setWindow(win);
  const rendererUrl = DEV
    ? 'http://127.0.0.1:5180/'
    : pathToFileURL(path.join(__dirname, '..', 'web-dist', 'index.html')).href;
  installRendererSecurity(win, rendererUrl);
  win.on('close', (event) => {
    // Closing the main window keeps renderer state and in-flight agent turns
    // alive. A real application quit sets this flag before Electron closes it.
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (getWindow() === win) setWindow(null);
  });
  if (DEV) void win.loadURL(rendererUrl);
  else void win.loadURL(rendererUrl);
  return win;
}

/** Reveal the existing main window or recreate it after a real close. */
function showMainWindow() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

/** 安装应用菜单（macOS 上带应用菜单、检查更新与「设置…」快捷键）。 */
function installMenu({ onCheckForUpdates } = {}) {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: 'Pi Studio',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: '检查更新…', click: () => onCheckForUpdates?.() },
            { type: 'separator' },
            { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => getWindow()?.webContents.send('pi:open-settings') },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 切换主题、配色与圆角：持久化到 Studio SQLite，同步窗口底色并通知菜单栏。
 */
function applyAppearance(theme, palette, radiusStyle) {
  if (!THEMES.has(theme)) throw new Error('无效的主题');
  if (palette !== undefined && !PALETTES.has(palette)) throw new Error('无效的配色方案');
  if (radiusStyle !== undefined && !RADIUS_STYLES.has(radiusStyle)) {
    throw new Error('无效的圆角风格');
  }
  const db = getStudioDatabase();
  const nextPalette = palette === undefined ? getPalette() : palette;
  const nextRadiusStyle = radiusStyle === undefined ? getRadiusStyle() : radiusStyle;
  db.setSetting('studio.app.theme', theme);
  db.setSetting('studio.app.palette', nextPalette);
  db.setSetting('studio.app.radiusStyle', nextRadiusStyle);
  nativeTheme.themeSource = theme;
  const win = getWindow();
  if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground(theme, nativeTheme.shouldUseDarkColors));
  publishMenuBarEvent({
    type: 'appearance',
    theme,
    palette: nextPalette,
    radiusStyle: nextRadiusStyle,
  });
}

/** 系统外观变化时同步窗口底色（跟随系统或手动切换都会触发）。 */
function watchSystemTheme() {
  nativeTheme.on('updated', () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(themeBackground(nativeTheme.themeSource, nativeTheme.shouldUseDarkColors));
    }
  });
}

module.exports = { createWindow, showMainWindow, installMenu, applyAppearance, watchSystemTheme };
