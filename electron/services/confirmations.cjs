/**
 * 工具权限确认。
 *
 * pi-mode-switcher 在 tool_call 阶段调用 `ctx.ui.confirm(title, message)`，
 * 桌面端不再使用系统原生对话框，而是把请求转发给渲染进程，显示统一样式的
 * 风险确认卡片，再把用户的选择回传给扩展。
 *
 * 同一时间只允许一个确认框：扩展连续触发时排队，关闭窗口未响应按拒绝处理。
 */

const { randomUUID } = require('node:crypto');
const { getWindow } = require('../core/state.cjs');

/** 用户长时间不处理时按拒绝处理，避免工具调用永久挂起。 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

const queue = [];
let active = null;
let registered = false;

/** 注册渲染进程的响应通道；由 ipc 层在启动时调用一次。 */
function registerConfirmationIpc(ipcMain) {
  if (registered) return;
  registered = true;
  ipcMain.on('pi:confirm-response', (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') return;
    settle(payload.id, Boolean(payload.accepted));
  });
}

/**
 * 请求一次确认。
 * @returns Promise<boolean> 用户点「确认」为 true
 */
function requestConfirmation({ sessionId, title, message }) {
  return new Promise((resolve) => {
    queue.push({ id: randomUUID(), sessionId, title, message, resolve });
    pump();
  });
}

/** 显示队首请求；窗口不存在时直接拒绝全部等待项。 */
function pump() {
  if (active || queue.length === 0) return;
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    while (queue.length > 0) queue.shift().resolve(false);
    return;
  }

  active = queue.shift();
  active.win = win;
  active.timer = setTimeout(() => settle(active.id, false), CONFIRM_TIMEOUT_MS);
  active.onClosed = () => settle(active.id, false);
  win.once('closed', active.onClosed);
  win.webContents.send('pi:confirm-request', {
    id: active.id,
    sessionId: active.sessionId,
    title: active.title,
    message: active.message,
  });
}

/** 结束当前请求并继续下一个；stale 响应（旧 id）直接忽略。 */
function settle(id, accepted) {
  if (!active || active.id !== id) return;
  const current = active;
  active = null;
  clearTimeout(current.timer);
  try { current.win.removeListener('closed', current.onClosed); } catch { /* 窗口已销毁 */ }
  current.resolve(accepted);
  pump();
}

module.exports = { registerConfirmationIpc, requestConfirmation };
