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
const os = require('node:os');
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
const { flushConversationFileCleanup } = require('./services/conversation-file-cleanup.cjs');
const { shutdownTemporaryChats } = require('./services/temporary-chat.cjs');
const { startPlanScheduler, stopPlanScheduler } = require('./services/plan-scheduler.cjs');
const { registerIpc } = require('./ipc/index.cjs');
const { shutdownTerminalSessions } = require('./ipc/terminal.cjs');
const { stopDesktopControlHelper } = require('./services/desktop-control/index.cjs');
const { createWindow, showMainWindow, installMenu, watchSystemTheme } = require('./window.cjs');
const { BACKGROUND_SCHEME } = require('./background-media.cjs');
const { EXTENSION_VIEW_SCHEME } = require('./core/extension-view.cjs');
const { registerBackgroundProtocol } = require('./services/background.cjs');
const { registerExtensionViewProtocol } = require('./services/extension-view-protocol.cjs');
const { initializeBrowserService } = require('./services/browser/index.cjs');
const { initializeNetwork } = require('./services/network.cjs');
const { isAllowedLocalHtmlUrl } = require('./services/local-html.cjs');
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

// Electron 的 userData（Chromium 缓存、Cookies、单实例锁）留在系统默认位置；
// Studio 自己的数据放在 ~/.pi-studio，由 core/studio-paths.cjs 统一提供。
// PI_STUDIO_USER_DATA 覆盖时两者合一，供测试与 QA 使用一次性目录。
const {
  cleanLegacyChromiumData,
  migrateStudioData,
  migrateStudioLayout,
  pruneEmptyManagedDirectories,
} = require('./core/user-data.cjs');
const { STUDIO_DATA_DIRECTORY } = require('./core/studio-paths.cjs');
const studioData = path.join(os.homedir(), STUDIO_DATA_DIRECTORY);
if (process.env.PI_STUDIO_USER_DATA) {
  const override = path.resolve(process.env.PI_STUDIO_USER_DATA);
  fs.mkdirSync(override, { recursive: true });
  app.setPath('userData', override);
} else {
  try {
    // 首次升级：把旧 userData 里的 Studio 条目复制过来（旧目录保留）。
    const result = migrateStudioData({ legacy: app.getPath('userData'), target: studioData });
    if (result.migrated) console.log(`Studio 数据已迁移到 ${studioData}`);
    const removed = cleanLegacyChromiumData({ target: studioData });
    if (removed.length > 0) console.log(`已清理误搬的 Chromium 文件：${removed.join('、')}`);
    const layout = migrateStudioLayout({ target: studioData });
    if (layout.moved.length > 0) console.log(`已整理 Studio 目录结构：${layout.moved.length} 项`);
    const pruned = pruneEmptyManagedDirectories({ target: studioData });
    if (pruned.length > 0) console.log(`已修剪 ${pruned.length} 个空托管目录`);
  } catch (error) {
    console.error('Studio 数据目录准备失败：', error);
  }
  fs.mkdirSync(studioData, { recursive: true });
}

let startupGate;
const primaryInstance = installSingleInstanceGuard(app, () => {
  if (startupGate?.requestReveal()) showMainWindow();
});

if (primaryInstance) {
  // IPC registration is synchronous. It happens before any asynchronous
  // database/runtime work so activation cannot expose a renderer without
  // handlers.
  registerIpc(async () => {
    await startupGate.start();
    if (startupGate.status !== 'ready' || app.isQuitting) throw new Error('Pi Studio 未能完成启动');
  });
  registerMenuBarIpc();
  require('./services/tool-window.cjs').registerToolWindowIpc();

  // Must be registered before app.ready so <img>/<video> can treat these URLs
  // as secure, streamable resources in development and packaged builds.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BACKGROUND_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      scheme: EXTENSION_VIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);

  installApplicationShutdown({
    app,
    updaterOwnsQuit: updaterOwnsApplicationQuit,
    stopUi: () => {
      shutdownMenuBar();
      shutdownUpdater();
    },
    steps: [
      [{ label: 'scheduled plans', run: stopPlanScheduler, timeoutMs: 8_000 }],
      [
        { label: 'conversation watches', run: closeConversationWatches, timeoutMs: 3_000 },
        { label: 'temporary chats', run: shutdownTemporaryChats, timeoutMs: 3_000 },
        { label: 'terminal sessions', run: shutdownTerminalSessions, timeoutMs: 2_000 },
        { label: 'computer use helper', run: stopDesktopControlHelper, timeoutMs: 2_000 },
      ],
      [{ label: 'Durable runtime', run: closeDurableRuntime, timeoutMs: 8_000 }],
    ],
  });

  // macOS norm: closing every window leaves Pi Studio running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Coalesce Dock activation while the launch screen is visible.
  app.on('activate', () => {
    if (app.isQuitting) return;
    if (startupGate?.requestReveal()) showMainWindow();
  });

  // The tool panel browser embeds untrusted pages: deny popups, block
  // unsupported navigation and keep those pages out of the app's session.
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
        return protocol === 'http:' || protocol === 'https:' || isAllowedLocalHtmlUrl(url);
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
      if (app.isQuitting) return;
      // macOS 开发模式下 Dock 图标取自项目资源
      if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, '../../assets/icon.png'));
      }
      // Paint the launch screen in the actual window while its runtime starts.
      registerBackgroundProtocol();
      registerExtensionViewProtocol();
      initializeBrowserService();
      createWindow();
      await initializeNetwork();
      // Database and credential paths depend on app.getPath('userData').
      await initializeStudioModels();
      try {
        const cleanup = cleanupOrphanedAttachmentDirectories(getStudioDatabase().attachmentSessionIds());
        if (cleanup.failed > 0) {
          console.warn(`[pi-studio] ${cleanup.failed} orphaned attachment directories could not be cleaned`);
        }
      } catch (error) {
        // Attachment cleanup is best effort and must not make saved chat data
        // or an otherwise healthy startup unavailable.
        console.warn('[pi-studio] attachment cleanup skipped', error);
      }
      try {
        flushConversationFileCleanup(getStudioDatabase());
      } catch (error) {
        console.warn('[pi-studio] 会话文件清理将在下次启动时重试', error.code || error.name);
      }
      await initializeDurableRuntime();
      if (!app.isQuitting) startPlanScheduler(require('electron').powerMonitor);
    },
    ready: ({ requestedBeforeReady }) => {
      if (app.isQuitting) return;
      // 系统外观变化时同步窗口底色
      watchSystemTheme();
      installMenu({ onCheckForUpdates: openAndCheckForUpdates });
      if (requestedBeforeReady) showMainWindow();
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
