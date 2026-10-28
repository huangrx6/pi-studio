/**
 * IPC：权限模式。
 * 读取/切换 pi-mode-switcher 的批准方式，供输入框左侧的模式选择器使用。
 */

const { ipcMain } = require('electron');
const { findManager, ensureAgent } = require('../services/sessions.cjs');
const { MODES, readMode, writeMode, modeAvailable, rememberPendingMode } = require('../services/mode.cjs');

function registerModeIpc() {
  // 当前模式 + 扩展是否可用（不可用时不显示入口）
  ipcMain.handle('pi:mode-get', async () => ({ available: modeAvailable(), mode: readMode() }));

  // 切换模式：写配置；有会话时立即用 /mode 命令更新扩展内存状态。
  ipcMain.handle('pi:mode-set', async (_event, { mode, sessionId }) => {
    if (!MODES.includes(mode)) throw new Error('无效的权限模式');
    writeMode(mode);

    if (!sessionId) {
      // 还没有会话：等第一次 ensureAgent 建好会话后再补发 /mode。
      rememberPendingMode(mode);
      return { mode };
    }

    const found = await findManager(sessionId);
    if (!found) throw new Error('会话不存在');
    const session = await ensureAgent(sessionId, found.manager, found.cwd);
    try {
      await session.prompt(`/mode ${mode}`);
    } catch (error) {
      // 扩展没装或命令被改：配置已保存，下一次会话会读取新值。
      return { mode, applied: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { mode, applied: true };
  });
}

module.exports = { registerModeIpc };
