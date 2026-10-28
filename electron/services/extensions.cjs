/**
 * 扩展（Extension）相关：扩展目录扫描 + 扩展 UI 桥接。
 *
 * Pi 的扩展本来是为终端（TUI）写的，这里提供一套「空实现 + 必要能力」的
 * uiContext，让扩展在桌面环境里也能工作：
 *  - select / confirm  用原生对话框
 *  - notify            转成窗口内的通知
 *  - setStatus         记录状态并推给前端
 *  - setFooter         渲染扩展自己的 footer 文本
 * 其它 TUI 专属能力（编辑器、overlay、主题等）保持 no-op。
 */

const { dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { getWindow, agentDir } = require('../core/state.cjs');
const { stripAnsi } = require('../core/serialize.cjs');

/** 每个会话的扩展 UI 状态：statuses（状态栏条目）与 footer（底部一行）。 */
const extensionUIStates = new Map();

/**
 * 为一个会话创建 uiContext。
 * Pi 的 bindExtensions 会把它交给扩展使用。
 */
function createExtensionUI(sessionId) {
  const statuses = new Map();
  const state = { statuses, footer: '', render: undefined };
  extensionUIStates.set(sessionId, state);

  let footerComponent;
  const send = (channel, payload) => getWindow()?.webContents.send(channel, { sessionId, ...payload });

  /** 把扩展 footer 组件渲染成一行纯文本（去掉 ANSI 颜色）。 */
  const renderFooter = () => {
    if (!footerComponent) {
      state.footer = '';
      send('pi:extension-footer', { text: '' });
      return;
    }
    try {
      const line = stripAnsi(footerComponent.render(120)?.[0] || '');
      state.footer = line;
      send('pi:extension-footer', { text: line });
    } catch {
      state.footer = '';
      send('pi:extension-footer', { text: '' });
    }
  };

  // 扩展里常见的 TUI 依赖：只提供 render 触发与固定尺寸，避免扩展报错
  const stubTui = {
    mode: 'regular',
    terminal: { columns: 120, rows: 40 },
    requestRender: renderFooter,
    showOverlay: undefined,
    addInputListener: undefined,
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text, appearance: 'dark' };
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
      if (!getWindow()) return false;
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: 'Pi Studio',
        message: stripAnsi(title),
        detail: stripAnsi(message),
        buttons: ['取消', '确认'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    async input() {
      return undefined;
    },
    notify(message, type = 'info') {
      send('pi:extension-notify', { message: stripAnsi(message), type });
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      if (text === undefined || text === null || text === '') statuses.delete(key);
      else statuses.set(key, stripAnsi(text));
      send('pi:extension-status', { key, text: text === undefined || text === null ? '' : stripAnsi(text) });
      renderFooter();
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter(factory) {
      try {
        footerComponent?.dispose?.();
      } catch {
        /* 旧组件可能已经失效 */
      }
      footerComponent = undefined;
      if (typeof factory === 'function') {
        try {
          footerComponent = factory(stubTui, theme, footerData);
        } catch (error) {
          send('pi:extension-notify', {
            message: `Footer 渲染失败：${error instanceof Error ? error.message : String(error)}`,
            type: 'warning',
          });
        }
      }
      renderFooter();
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
  return state ? { statuses: [...state.statuses], footer: state.footer } : { statuses: [], footer: '' };
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

module.exports = { createExtensionUI, extensionState, listExtensions };
