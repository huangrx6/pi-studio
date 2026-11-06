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

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, protocol } = require('electron');
const { installApplicationShutdown } = require('./core/app-lifecycle.cjs');
const { installSingleInstanceGuard } = require('./core/single-instance.cjs');
const { createStartupGate } = require('./core/startup-gate.cjs');
const { initializeStudioModels } = require('./core/studio-models.cjs');
const { getStudioDatabase } = require('./core/studio-db.cjs');
const { closeDurableRuntime, initializeDurableRuntime } = require('./runtime/durable-runtime.cjs');
const { closeConversationWatches } = require('./runtime/conversations.cjs');
const { cleanupOrphanedAttachmentDirectories } = require('./services/attachments.cjs');
const { shutdownTemporaryChats } = require('./services/temporary-chat.cjs');
const { registerIpc } = require('./ipc/index.cjs');
const { shutdownTerminalSessions } = require('./ipc/terminal.cjs');
const { createWindow, showMainWindow, installMenu, watchSystemTheme } = require('./window.cjs');
const { BACKGROUND_SCHEME } = require('./background-media.cjs');
const { registerBackgroundProtocol } = require('./services/background.cjs');
const { installBrowserSessionGuards } = require('./services/browser-session.cjs');
const {
  initializeMenuBar,
  registerMenuBarIpc,
  shutdownMenuBar,
} = require('./services/menu-bar.cjs');
const {
  initializeUpdater,
  openAndCheckForUpdates,
  shutdownUpdater,
  updaterOwnsApplicationQuit,
} = require('./services/updater.cjs');

// Tests and QA can run complete packaged applications without sharing the
// production Chromium profile, SQLite database, or single-instance lock.
if (process.env.PI_STUDIO_USER_DATA) {
  const userData = path.resolve(process.env.PI_STUDIO_USER_DATA);
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}

let startupGate;
const primaryInstance = installSingleInstanceGuard(app, () => {
  if (startupGate?.requestReveal()) showMainWindow();
});

if (primaryInstance) {
  // IPC registration is synchronous. It happens before any asynchronous
  // database/runtime work so activation cannot expose a renderer without
  // handlers.
  registerIpc();
  registerMenuBarIpc();

  // Must be registered before app.ready so <img>/<video> can treat these URLs
  // as secure, streamable resources in development and packaged builds.
  protocol.registerSchemesAsPrivileged([{
    scheme: BACKGROUND_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);

  installApplicationShutdown({
    app,
    updaterOwnsQuit: updaterOwnsApplicationQuit,
    stopUi: () => {
      shutdownMenuBar();
      shutdownUpdater();
    },
    steps: [
      [
        { label: 'conversation watches', run: closeConversationWatches, timeoutMs: 3_000 },
        { label: 'temporary chats', run: shutdownTemporaryChats, timeoutMs: 3_000 },
        { label: 'terminal sessions', run: shutdownTerminalSessions, timeoutMs: 2_000 },
      ],
      [{ label: 'Durable runtime', run: closeDurableRuntime, timeoutMs: 8_000 }],
    ],
  });

  // macOS norm: closing every window leaves Pi Studio running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Dock activation may arrive before model and Durable startup finishes. The
  // gate defers it instead of creating a renderer against a half-ready main.
  app.on('activate', () => {
    if (app.isQuitting) return;
    if (startupGate?.requestReveal()) showMainWindow();
  });

  // The right-panel browser embeds untrusted pages: deny popups, block
  // non-http(s) navigation and keep those pages out of the app's session.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.protocol === 'http:' || target.protocol === 'https:') {
          void contents.loadURL(target.href);
        }
      } catch {
        // Ignore malformed popup targets.
      }
      return { action: 'deny' };
    });
    const allowNavigation = (url) => {
      if (url === 'about:blank') return true;
      try {
        const protocol = new URL(url).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    };
    contents.on('will-navigate', (event, url) => {
      if (!allowNavigation(url)) event.preventDefault();
    });
    // Programmatic loads (loadURL) skip `will-navigate`; this catches them too.
    contents.on('will-frame-navigate', (event) => {
      if (!allowNavigation(event.url)) event.preventDefault();
    });
  });

  startupGate = createStartupGate({
    initialize: async () => {
      await app.whenReady();
      // macOS 开发模式下 Dock 图标取自项目资源
      if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
      }
      // Database and credential paths depend on app.getPath('userData').
      await initializeStudioModels();
      try {
        const conversations = getStudioDatabase().listConversations({ includeArchived: true });
        const cleanup = cleanupOrphanedAttachmentDirectories(
          conversations.flatMap((conversation) => [conversation.id, conversation.publicId]),
        );
        if (cleanup.failed > 0) {
          console.warn(`[pi-studio] ${cleanup.failed} orphaned attachment directories could not be cleaned`);
        }
      } catch (error) {
        // Attachment cleanup is best effort and must not make saved chat data
        // or an otherwise healthy startup unavailable.
        console.warn('[pi-studio] attachment cleanup skipped', error);
      }
      await initializeDurableRuntime();
    },
    ready: () => {
      if (app.isQuitting) return;
      // 系统外观变化时同步窗口底色
      watchSystemTheme();
      registerBackgroundProtocol();
      installBrowserSessionGuards();
      installMenu({ onCheckForUpdates: openAndCheckForUpdates });
      createWindow();
      initializeMenuBar();
      initializeUpdater();
    },
    failed: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[pi-studio] startup failed', error);
      try {
        dialog.showErrorBox(
          'Pi Studio 无法启动',
          `${detail}\n\n请确认旧实例已经完全退出后重试。如果问题持续，请保留应用数据目录中的数据库文件以便恢复。`,
        );
      } finally {
        app.quit();
      }
    },
  });

  void startupGate.start();
}
