/**
 * 窗口与应用菜单。
 *
 * 窗口创建时要先确定主题偏好（config.json 里的 theme），
 * 因为窗口的 backgroundColor 必须在创建时就给出，否则启动会闪白。
 */

const { BrowserWindow, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const { DEV, getWindow, setWindow, configPath, readJson } = require('./core/state.cjs');
const { readConfig, writeConfig } = require('./settings-config.cjs');
const { themeBackground } = require('./theme.cjs');

/** 允许的主题偏好值。 */
const THEMES = ['light', 'dark', 'system'];

/**
 * 创建主窗口。
 * 开发模式连 Vite dev server，生产模式加载打包后的 web-dist。
 */
function createWindow() {
  const storedTheme = readJson(configPath(), {}).theme;
  const preference = THEMES.includes(storedTheme) ? storedTheme : 'light';
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
    },
  });

  setWindow(win);
  if (DEV) void win.loadURL('http://127.0.0.1:5180');
  else void win.loadFile(path.join(__dirname, '..', 'web-dist', 'index.html'));
}

/** 安装应用菜单（macOS 上带应用菜单与「设置…」快捷键）。 */
function installMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: 'Pi Studio',
          submenu: [
            { role: 'about' },
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
 * 切换主题：持久化到 config.json，并同步窗口底色。
 * 主题由渲染进程触发（设置页）。
 */
function applyTheme(theme) {
  if (!THEMES.includes(theme)) throw new Error('无效的主题');
  const config = readConfig(configPath(), {});
  if (config.theme !== theme) writeConfig(configPath(), { ...config, theme });
  nativeTheme.themeSource = theme;
  const win = getWindow();
  if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground(theme, nativeTheme.shouldUseDarkColors));
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

module.exports = { createWindow, installMenu, applyTheme, watchSystemTheme };
