/**
 * 扩展（Extension）相关：扩展目录扫描 + 扩展 UI 桥接。
 *
 * Pi 的扩展本来是为终端（TUI）写的，这里提供一套「空实现 + 必要能力」的
 * uiContext，让扩展在桌面环境里也能工作：
 *  - select / confirm  用原生对话框
 *  - notify            转成窗口内的通知
 *  - setStatus         记录状态并推给前端
 *  - setFooter         渲染扩展自己的 footer 文本
 * footer 的鼠标、键盘与 overlay 通过通用终端组件宿主桥接到桌面浮层。
 */

const { dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { getWindow, agentDir } = require('../core/state.cjs');
const { requestConfirmation } = require('./confirmations.cjs');
const { stripAnsi } = require('../core/serialize.cjs');
const { createFooterHost } = require('./footer-host.cjs');

/** 每个会话的扩展 UI 状态：statuses（状态栏条目）与 footer（底部一行）。 */
const extensionUIStates = new Map();
/** renderer 在扩展绑定完成前发来的尺寸信息，绑定后补发一次。 */
const footerResizes = new Map();

/**
 * 为一个会话创建 uiContext。
 * Pi 的 bindExtensions 会把它交给扩展使用。
 */
function createExtensionUI(sessionId) {
  const statuses = new Map();
  const state = { statuses, footer: '' };
  extensionUIStates.set(sessionId, state);

  const send = (channel, payload) => getWindow()?.webContents.send(channel, { sessionId, ...payload });
  const host = createFooterHost((payload) => {
    state.footer = payload.text;
    send('pi:extension-footer', payload);
  });
  state.host = host;
  // 打开会话时 renderer 会先按实际宽度发 resize；那一刻扩展可能还没绑定，
  // 这里补发一次，避免 footer 一直按默认 120 列渲染。
  const pendingResize = footerResizes.get(sessionId);
  if (pendingResize) host.action(pendingResize);
  const renderFooter = host.render;
  const theme = host.theme;
  const footerData = {
    getExtensionStatuses: () => new Map(statuses),
    onBranchChange: () => () => {},
  };

  /** 用原生选择框实现扩展的 select。 */
  const choose = async (title, options) => {
    if (!getWindow()) return undefined;
    const buttons = [...options.map(String), '取消'];
    const result = await dialog.showMessageBox(getWindow(), {
      type: 'question',
      title: 'Pi Studio',
      message: stripAnsi(title),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    return result.response === buttons.length - 1 ? undefined : options[result.response];
  };

  const ui = {
    select: choose,
    async confirm(title, message) {
      // 交给渲染进程显示统一样式的风险确认卡片；窗口关闭或超时按拒绝处理。
      return requestConfirmation({ sessionId, title: stripAnsi(title), message: stripAnsi(message) });
    },
    async input() {
      return undefined;
    },
    notify(message, type = 'info') {
      const text = stripAnsi(message);
      // The mode selector already shows the applied mode. Keep failures and
      // unrelated extension notifications, including those during streaming.
      if (type === 'info' && /^权限模式\s*·\s*(请求批准|帮我批准|完全(?:访问)?权限)$/.test(text.trim())) return;
      send('pi:extension-notify', { message: text, type });
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      if (text === undefined || text === null || text === '') statuses.delete(key);
      else statuses.set(key, stripAnsi(text));
      send('pi:extension-status', { key, text: text === undefined || text === null ? '' : stripAnsi(text) });
      // 只有真的挂了自定义 footer 时才重新渲染；否则状态更新不需要惊动扩展。
      if (state.host.active) renderFooter();
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter(factory) {
      try { host.set(factory, footerData); }
      catch (error) {
        host.set(undefined, footerData);
        send('pi:extension-notify', { message: `Footer 渲染失败：${error.message}`, type: 'warning' });
      }
    },
    setHeader() {},
    setTitle() {},
    async custom() {
      return undefined;
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return '';
    },
    async editor() {
      return undefined;
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    theme,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
  return ui;
}

/** IPC 用：读取某个会话的扩展状态。 */
function extensionState(sessionId) {
  const state = extensionUIStates.get(sessionId);
  return state ? { statuses: [...state.statuses], footer: state.footer, view: state.host.view } : { statuses: [], footer: '' };
}

/** 扩展可能出现的两个位置：用户级与项目级。 */
function extensionRoots(cwd) {
  return [
    { scope: 'user', root: path.join(agentDir(), 'extensions') },
    { scope: 'project', root: path.join(cwd, '.pi', 'extensions') },
  ];
}

/**
 * 扫描扩展目录。
 * 目录型扩展要求存在 index.ts / index.js，单文件扩展直接算一个。
 */
function listExtensions(cwd) {
  const items = [];
  for (const { scope, root } of extensionRoots(cwd)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const target = path.join(root, entry.name);
      const isDirectory = entry.isDirectory();
      const entryFile = isDirectory
        ? ['index.ts', 'index.js'].map((name) => path.join(target, name)).find((value) => fs.existsSync(value))
        : target;
      if (!entryFile) continue;
      items.push({ name: entry.name, scope, path: target, kind: isDirectory ? 'directory' : 'file' });
    }
  }
  return items;
}

function footerAction(sessionId, input) {
  if (input?.type === 'resize' && sessionId) footerResizes.set(sessionId, input);
  return extensionUIStates.get(sessionId)?.host.action(input);
}
module.exports = { createExtensionUI, extensionState, footerAction, listExtensions };
