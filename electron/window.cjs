/**
 * 窗口与应用菜单。
 *
 * 窗口创建时要先确定主题偏好（Studio SQLite 里的 theme），
 * 因为窗口的 backgroundColor 必须在创建时就给出，否则启动会闪白。
 */

const { app, BrowserWindow, Menu, nativeTheme, screen, shell } = require('electron');
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
  getWindowBounds,
  setWindowBounds,
} = require('./core/app-settings.cjs');
const {
  MIN_WINDOW_SIZE,
  centerWindowBounds,
  resolveWindowBounds,
} = require('./core/window-bounds.cjs');
const { getStudioDatabase } = require('./core/studio-db.cjs');
const { themeBackground } = require('./theme.cjs');
const { publishMenuBarEvent } = require('./menu-bar-events.cjs');
const { isAllowedLocalHtmlUrl } = require('./services/local-html.cjs');

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
   * refused before a guest process starts. Local browser targets are limited
   * to existing, non-protected .html/.htm files.
   */
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = String(params?.src || '');
    const trusted = webPreferences?.partition === 'persist:pi-browser'
      && !webPreferences?.preload
      && !params?.preload
      && webPreferences?.nodeIntegration !== true;
    const allowedSource = /^(https?:|about:blank$)/i.test(src) || isAllowedLocalHtmlUrl(src);
    if (!trusted || !allowedSource) {
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
 * 主窗口可用的工作区：主屏优先，其余按系统顺序。菜单栏与 Dock 已经由
 * workArea 扣掉，窗口不会压在它们下面。
 */
function windowWorkAreas() {
  const primary = screen.getPrimaryDisplay().workArea;
  const sameArea = (area) => area.x === primary.x
    && area.y === primary.y
    && area.width === primary.width
    && area.height === primary.height;
  return [
    primary,
    ...screen.getAllDisplays().map((display) => display.workArea).filter((area) => !sameArea(area)),
  ];
}

/** 记住最后一次普通窗口矩形；全屏时保留进入全屏前的位置。 */
function persistWindowBounds(win) {
  if (win.isDestroyed() || win.isFullScreen()) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  setWindowBounds({ ...bounds, maximized: win.isMaximized() });
}

/** 把主窗口放回主屏中央，并忘记保存过的位置。 */
function resetWindowBounds() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) {
    // 全屏过渡期间的 setBounds 会被系统忽略，等退出全屏后再居中。
    win.once('leave-full-screen', () => resetWindowBounds());
    win.setFullScreen(false);
    return;
  }
  if (win.isMaximized()) win.unmaximize();
  const bounds = centerWindowBounds(windowWorkAreas()[0]);
  win.setBounds(bounds);
  setWindowBounds({ ...bounds, maximized: false });
  win.focus();
}

/**
 * 渲染进程需要知道窗口是否处于原生全屏：全屏时系统隐藏了 macOS 的红黄绿
 * 窗口按钮，标题行不再需要为它们留空。
 */
function windowState(win = getWindow()) {
  return { fullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()) };
}

/** 把原生窗口状态变化推给渲染进程；首帧由渲染进程主动查询。 */
function publishWindowState(win) {
  if (win.isDestroyed()) return;
  win.webContents.send('pi:window-state', windowState(win));
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
  const restored = resolveWindowBounds(getWindowBounds(), windowWorkAreas());

  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    titleBarStyle: 'hiddenInset',
    // hiddenInset 的默认纵向内缩会让原生红绿灯低于 44px 标题行的中心线。
    // 直接在窗口层校准原生控件，避免在渲染层给网页按钮叠加补偿位移。
    trafficLightPosition: { x: 16, y: 15 },
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
  if (restored.maximized) win.maximize();
  win.on('enter-full-screen', () => publishWindowState(win));
  win.on('leave-full-screen', () => publishWindowState(win));
  // 拖动和缩放会连续触发事件：去抖后再写 SQLite，窗口隐藏或退出时立即落盘。
  let boundsTimer = null;
  const scheduleBoundsSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => { boundsTimer = null; persistWindowBounds(win); }, 400);
  };
  const flushBounds = () => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    persistWindowBounds(win);
  };
  win.on('resize', scheduleBoundsSave);
  win.on('move', scheduleBoundsSave);
  win.on('maximize', flushBounds);
  win.on('unmaximize', flushBounds);
  win.on('close', flushBounds);
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
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
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
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: '重置窗口位置', click: () => resetWindowBounds() }, { type: 'separator' }, { role: 'front' }] },
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

module.exports = { createWindow, showMainWindow, installMenu, applyAppearance, watchSystemTheme, windowState };
