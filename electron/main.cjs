/**
 * Electron 主进程入口。
 *
 * 这里只做三件事：
 *  1. 应用生命周期（ready / activate / window-all-closed）
 *  2. 加载 Pi SDK 与持久化配置
 *  3. 装配：注册 IPC、安装菜单、创建窗口
 *
 * 具体能力拆分在：
 *  - core/       共享状态、消息序列化、附件标记
 *  - services/   会话、模型、设置、附件、文件、macOS 应用
 *  - ipc/        按域注册的 IPC 处理器
 *  - window.cjs  窗口、菜单、主题
 */

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { loadPi, loadConfig } = require('./core/state.cjs');
const { registerIpc } = require('./ipc/index.cjs');
const { createWindow, installMenu, watchSystemTheme } = require('./window.cjs');

app.whenReady().then(async () => {
  // macOS 开发模式下 Dock 图标取自项目资源
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }

  // Pi SDK 必须在 ready 之后加载；config 依赖 userData 路径
  await loadPi();
  loadConfig();

  // 系统外观变化时同步窗口底色
  watchSystemTheme();

  // 先注册 IPC 再建窗口，避免窗口加载完成后首屏请求落空
  registerIpc();
  installMenu();
  createWindow();
});

// macOS 习惯：关闭所有窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 点击 Dock 图标且没有窗口时重新创建
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
