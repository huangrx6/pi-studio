/**
 * 工具权限确认。
 *
 * Durable 工具 Hook 在执行可能修改工作区的工具前请求确认。桌面端把请求
 * 转发给渲染进程，显示统一样式的风险确认卡片，再把用户的选择回传给 Hook。
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
    settle(payload.id, {
      accepted: Boolean(payload.accepted),
      remember: ['session', 'workspace', 'always'].includes(payload.remember)
        ? payload.remember
        : undefined,
    });
  });
}

/**
 * 请求一次确认。
 * @returns Promise<boolean> 用户点「确认」为 true
 */
function requestConfirmation({ sessionId, title, message }) {
  return requestPolicyConfirmation({ sessionId, title, message })
    .then((result) => result.accepted);
}

/**
 * 请求一次带风险上下文的确认，并返回用户是否希望记住此决定。
 * `remember` 只表示用户选择的范围，实际规则仍由权限引擎收窄后写入。
 */
function requestPolicyConfirmation({
  sessionId,
  cwd,
  tool,
  decision,
  explanation,
  risk,
  rememberScopes,
  title,
  message,
}) {
  return new Promise((resolve) => {
    queue.push({
      id: randomUUID(),
      sessionId,
      cwd,
      tool,
      decision,
      explanation,
      risk,
      rememberScopes,
      title,
      message,
      resolve,
    });
    pump();
  });
}

/** 显示队首请求；窗口不存在时直接拒绝全部等待项。 */
function pump() {
  if (active || queue.length === 0) return;
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    while (queue.length > 0) queue.shift().resolve({ accepted: false });
    return;
  }

  active = queue.shift();
  active.win = win;
  active.timer = setTimeout(() => settle(active.id, { accepted: false, timedOut: true }), CONFIRM_TIMEOUT_MS);
  active.onClosed = () => settle(active.id, { accepted: false, windowClosed: true });
  win.once('closed', active.onClosed);
  win.webContents.send('pi:confirm-request', {
    id: active.id,
    sessionId: active.sessionId,
    cwd: active.cwd,
    tool: active.tool,
    decision: active.decision,
    explanation: active.explanation,
    risk: active.risk,
    rememberScopes: active.rememberScopes,
    title: active.title,
    message: active.message,
  });
}

/** 结束当前请求并继续下一个；stale 响应（旧 id）直接忽略。 */
function settle(id, result) {
  if (!active || active.id !== id) return;
  const current = active;
  active = null;
  clearTimeout(current.timer);
  try { current.win.removeListener('closed', current.onClosed); } catch { /* 窗口已销毁 */ }
  current.resolve(typeof result === 'boolean' ? { accepted: result } : result);
  pump();
}

module.exports = {
  registerConfirmationIpc,
  requestConfirmation,
  requestPolicyConfirmation,
};
