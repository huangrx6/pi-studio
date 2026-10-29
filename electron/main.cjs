/**
 * Electron 主进程入口。
 *
 * 这里只做三件事：
 *  1. 应用生命周期（ready / activate / window-all-closed）
 *  2. 初始化 Studio SQLite、模型目录与 Pi Durable harness
 *  3. 装配：注册 IPC、安装菜单、创建窗口
 *
 * 具体能力拆分在：
 *  - core/       共享状态、消息序列化、附件标记
 *  - services/   会话、模型、设置、附件、文件、macOS 应用
 *  - ipc/        按域注册的 IPC 处理器
 *  - window.cjs  窗口、菜单、主题
 */

const path = require('node:path');
const { app, protocol } = require('electron');
const { initializeStudioModels } = require('./core/studio-models.cjs');
const { closeDurableRuntime, initializeDurableRuntime } = require('./services/durable-runtime.cjs');
const { closeConversationWatches } = require('./services/durable-conversations.cjs');
const { shutdownTemporaryChats } = require('./services/temporary-chat.cjs');
const { registerIpc } = require('./ipc/index.cjs');
const { createWindow, showMainWindow, installMenu, watchSystemTheme } = require('./window.cjs');
const { BACKGROUND_SCHEME } = require('./background-media.cjs');
const { registerBackgroundProtocol } = require('./services/background.cjs');
const {
  initializeMenuBar,
  registerMenuBarIpc,
  shutdownMenuBar,
} = require('./services/menu-bar.cjs');
const {
  initializeUpdater,
  openAndCheckForUpdates,
  shutdownUpdater,
} = require('./services/updater.cjs');

// Must be registered before app.ready so <img>/<video> can treat these URLs as
// secure, streamable resources in both the Vite dev server and packaged builds.
protocol.registerSchemesAsPrivileged([{
  scheme: BACKGROUND_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

app.whenReady().then(async () => {
  // macOS 开发模式下 Dock 图标取自项目资源
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }

  // Database and credential paths depend on app.getPath('userData').
  await initializeStudioModels();
  await initializeDurableRuntime();

  // 系统外观变化时同步窗口底色
  watchSystemTheme();

  // 先注册媒体协议与 IPC 再建窗口，避免窗口加载完成后首屏请求落空
  registerBackgroundProtocol();
  registerIpc();
  registerMenuBarIpc();
  installMenu({ onCheckForUpdates: openAndCheckForUpdates });
  createWindow();
  initializeMenuBar();
  initializeUpdater();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

let shutdownPromise;
let shutdownComplete = false;

app.on('will-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    await closeConversationWatches().catch((error) => {
      console.error('[pi-studio] failed to close conversation watches', error);
    });
    await shutdownTemporaryChats().catch((error) => {
      console.error('[pi-studio] failed to close temporary chats', error);
    });
    await closeDurableRuntime().catch((error) => {
      console.error('[pi-studio] failed to close Durable runtime', error);
    });
    shutdownUpdater();
    shutdownMenuBar();
    shutdownComplete = true;
    app.quit();
  })();
});

// macOS norm: closing every window leaves Pi Studio running.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clicking the Dock icon reveals the hidden workspace.
app.on('activate', () => {
  showMainWindow();
});
