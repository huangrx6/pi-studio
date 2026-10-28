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

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWindow, agentDir } = require('../core/state.cjs');
const { requestConfirmation } = require('./confirmations.cjs');
const { stripAnsi } = require('../core/serialize.cjs');
const { createFooterHost, cells, normalizePanel } = require('./footer-host.cjs');
const { createSurfaceHost } = require('./extension-surface.cjs');

/** 每个会话的扩展 UI 状态：statuses（状态栏条目）与 footer（底部一行）。 */
const extensionUIStates = new Map();
/** renderer 在扩展绑定完成前发来的尺寸信息，绑定后补发一次。 */
const footerResizes = new Map();
/** 渲染层返回的输入框 / 编辑器结果：id → resolve。 */
const pendingDialogs = new Map();
/** 渲染层返回的扩展选择器结果：id → resolve。 */
const pendingSelects = new Map();

/** IPC：接收选择器结果。 */
function extensionSelectResult(id, value) {
  const resolve = pendingSelects.get(id);
  if (!resolve) return false;
  pendingSelects.delete(id);
  resolve(value);
  return true;
}

/** IPC：接收渲染层的输入框结果，唤醒扩展的 input()/editor()。 */
function extensionDialogResult(id, value) {
  const resolve = pendingDialogs.get(id);
  if (!resolve) return false;
  pendingDialogs.delete(id);
  resolve(value);
  return true;
}


/** 桌面端输入序列 → Pi TUI 的键名。 */
const KEY_IDS = {
  '\r': 'enter', '\n': 'enter', '\x1b': 'escape', '\t': 'tab', '\x7f': 'backspace', '\x03': 'ctrl+c', '\x0a': 'ctrl+j',
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[5~': 'pageUp', '\x1b[6~': 'pageDown', '\x1b[H': 'home', '\x1b[F': 'end',
};

/** Pi TUI 常用动作的默认键位；custom 组件依赖 matches() 做语义判断。 */
const DEFAULT_KEYS = {
  'tui.select.up': ['up'],
  'tui.select.down': ['down'],
  'tui.select.pageUp': ['pageUp'],
  'tui.select.pageDown': ['pageDown'],
  'tui.select.confirm': ['enter'],
  'tui.select.cancel': ['escape', 'ctrl+c'],
  'tui.input.tab': ['tab'],
  'tui.input.submit': ['enter'],
  'tui.input.newLine': ['shift+enter', 'ctrl+j'],
  'tui.editor.cursorLineStart': ['home', 'ctrl+a'],
  'tui.editor.cursorLineEnd': ['end', 'ctrl+e'],
  'tui.editor.deleteCharBackward': ['backspace'],
};

/**
 * 给 custom 组件的最小 KeybindingsManager 兼容层。
 * 只覆盖 Pi TUI 的常用键位；扩展自定义键位不会生效，但不会阻断基础交互。
 */
function createKeybindings() {
  const idFor = (data) => {
    if (KEY_IDS[data]) return KEY_IDS[data];
    if (data.length === 1 && data.charCodeAt(0) >= 1 && data.charCodeAt(0) <= 26) {
      return `ctrl+${String.fromCharCode(data.charCodeAt(0) + 96)}`;
    }
    return data;
  };
  return {
    matches(data, action) { return (DEFAULT_KEYS[action] || []).includes(idFor(String(data || ''))); },
    getKeys(action) { return [...(DEFAULT_KEYS[action] || [])]; },
    get(action) { return DEFAULT_KEYS[action] || []; },
    getDefinition(action) { return { defaultKeys: DEFAULT_KEYS[action] || [] }; },
  };
}

/**
 * 为一个会话创建 uiContext。
 * Pi 的 bindExtensions 会把它交给扩展使用。
 */
function createExtensionUI(sessionId) {
  const statuses = new Map();
  const state = { statuses, footer: '', widgets: new Map(), custom: null, customHost: null, header: null, headerHost: null, terminalInputs: new Set(), working: { message: '', visible: true }, editorText: '' };
  extensionUIStates.set(sessionId, state);

  const send = (channel, payload) => getWindow()?.webContents.send(channel, { sessionId, ...payload });
  const host = createFooterHost((payload) => {
    state.footer = payload.text;
    send('pi:extension-footer', payload);
  });
  state.host = host;
  const publishWidgets = () => send('pi:extension-widgets', {
    widgets: [...state.widgets.values()].map(({ key, placement, lines }) => ({ key, placement, lines })),
  });
  const publishCustom = () => send('pi:extension-custom', { custom: state.custom });
  const publishWorking = () => send('pi:extension-working', { working: state.working });
  const publishHeader = () => send('pi:extension-header', { header: state.header });
  /** 让渲染层弹一个输入框 / 多行编辑器，并把结果回传给扩展。 */
  const requestDialog = (kind, title, extra = {}) => new Promise((resolve) => {
    const id = randomUUID();
    pendingDialogs.set(id, resolve);
    send('pi:extension-dialog', { id, kind, title: stripAnsi(title), ...extra });
  });
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

  /** 扩展选择器统一用应用内对话框；options 只做展示，不做业务解析。 */
  const choose = (title, options, opts = {}) => {
    if (!getWindow()) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = randomUUID();
      pendingSelects.set(id, resolve);
      send('pi:extension-select', { id, title: stripAnsi(title), options: options.map((option) => stripAnsi(String(option))) });
      if (opts?.timeout) {
        setTimeout(() => {
          if (!pendingSelects.has(id)) return;
          pendingSelects.delete(id);
          send('pi:extension-select-close', { id });
          resolve(undefined);
        }, opts.timeout);
      }
      opts?.signal?.addEventListener?.('abort', () => {
        if (!pendingSelects.has(id)) return;
        pendingSelects.delete(id);
        send('pi:extension-select-close', { id });
        resolve(undefined);
      }, { once: true });
    });
  };

  const ui = {
    select: choose,
    async confirm(title, message) {
      // 交给渲染进程显示统一样式的风险确认卡片；窗口关闭或超时按拒绝处理。
      return requestConfirmation({ sessionId, title: stripAnsi(title), message: stripAnsi(message) });
    },
    async input(title, placeholder) {
      return requestDialog('input', title, { placeholder: stripAnsi(placeholder || '') });
    },
    notify(message, type = 'info') {
      const text = stripAnsi(message);
      // The mode selector already shows the applied mode. Keep failures and
      // unrelated extension notifications, including those during streaming.
      if (type === 'info' && /^权限模式\s*·\s*(请求批准|帮我批准|完全(?:访问)?权限)$/.test(text.trim())) return;
      send('pi:extension-notify', { message: text, type });
    },
    onTerminalInput(handler) {
      if (typeof handler !== 'function') return () => {};
      state.terminalInputs.add(handler);
      return () => state.terminalInputs.delete(handler);
    },
    setStatus(key, text) {
      if (text === undefined || text === null || text === '') statuses.delete(key);
      else statuses.set(key, stripAnsi(text));
      send('pi:extension-status', { key, text: text === undefined || text === null ? '' : stripAnsi(text) });
      // 只有真的挂了自定义 footer 时才重新渲染；否则状态更新不需要惊动扩展。
      if (state.host.active) renderFooter();
    },
    setWorkingMessage(message) {
      state.working.message = message ? stripAnsi(message) : '';
      publishWorking();
    },
    setWorkingVisible(visible) {
      state.working.visible = visible !== false;
      publishWorking();
    },
    setWorkingIndicator(options) {
      // 桌面端用自己的加载指示器；这里只记录扩展是否要求隐藏。
      state.working.visible = options?.frames ? options.frames.length > 0 : state.working.visible;
      publishWorking();
    },
    setHiddenThinkingLabel() {},
    setWidget(key, content, options) {
      const placement = options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor';
      const previous = state.widgets.get(key);
      previous?.host?.dispose?.();
      if (content === undefined || content === null) {
        state.widgets.delete(key);
        publishWidgets();
        return;
      }
      if (typeof content === 'function') {
        const entry = { key, placement, lines: [] };
        entry.host = createSurfaceHost((snapshot) => {
          entry.lines = snapshot.lines;
          publishWidgets();
        });
        state.widgets.set(key, entry);
        entry.host.set(content);
        publishWidgets();
        return;
      }
      const lines = Array.isArray(content) ? content : [String(content)];
      state.widgets.set(key, { key, placement, lines: lines.map((line) => cells(String(line))) });
      publishWidgets();
    },
    setFooter(factory) {
      try { host.set(factory, footerData); }
      catch (error) {
        host.set(undefined, footerData);
        send('pi:extension-notify', { message: `Footer 渲染失败：${error.message}`, type: 'warning' });
      }
    },
    setHeader(factory) {
      state.headerHost?.dispose?.();
      state.headerHost = null;
      state.header = null;
      if (typeof factory === 'function') {
        const host = createSurfaceHost((snapshot) => {
          state.header = snapshot.raw.length > 0 ? { lines: snapshot.lines, interactive: snapshot.interactive } : null;
          publishHeader();
        });
        state.headerHost = host;
        host.set(factory);
      }
      publishHeader();
    },
    setTitle(title) {
      if (title) getWindow()?.setTitle(stripAnsi(title));
    },
    /**
     * custom 组件是终端与桌面共用的那套 pi-tui Component：
     * 这里把它渲染成通用浮层，键盘 / 鼠标事件原样回传；done() 的结果 resolve。
     */
    async custom(factory, options = {}) {
      if (typeof factory !== 'function' || !getWindow()) return undefined;
      return new Promise((resolve) => {
        const id = randomUUID();
        let done = false;
        state.customHost?.dispose?.();
        // 扩展可以指定终端列宽 / 最大高度；桌面端据此换算像素，位置仍由宿主决定。
        const overlayOptions = (typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions) || {};
        const width = typeof overlayOptions.width === 'number' || typeof overlayOptions.width === 'string' ? overlayOptions.width : undefined;
        const maxHeight = typeof overlayOptions.maxHeight === 'number' || typeof overlayOptions.maxHeight === 'string' ? overlayOptions.maxHeight : undefined;
        const host = createSurfaceHost((snapshot) => {
          if (done) return;
          const panel = snapshot.raw.length > 0 ? normalizePanel(snapshot.raw) : null;
          state.custom = panel ? { id, ...panel, overlay: Boolean(options.overlay), width, maxHeight, interactive: snapshot.interactive } : null;
          publishCustom();
        });
        state.customHost = host;
        state.custom = { id, lines: [], overlay: Boolean(options.overlay), width, maxHeight, interactive: false };
        publishCustom();
        const finish = (result) => {
          if (done) return;
          done = true;
          if (state.customHost === host) {
            state.customHost = null;
            state.custom = null;
            publishCustom();
          }
          host.dispose();
          resolve(result);
        };
        try {
          const component = factory(host.tui, host.theme, createKeybindings(), finish);
          Promise.resolve(component).then((value) => { if (!done) host.set(() => value); }).catch(() => finish(undefined));
        } catch { finish(undefined); }
      });
    },
    pasteToEditor(text) {
      send('pi:extension-editor-paste', { text: stripAnsi(String(text ?? '')) });
    },
    setEditorText(text) {
      state.editorText = stripAnsi(String(text ?? ''));
      send('pi:extension-editor-set', { text: state.editorText });
    },
    getEditorText() {
      return state.editorText;
    },
    async editor(title, prefill) {
      return requestDialog('editor', title, { prefill: stripAnsi(prefill || '') });
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
  if (!state) return { statuses: [], footer: '', widgets: [], custom: null, header: null, working: { message: '', visible: true } };
  return {
    statuses: [...state.statuses],
    footer: state.footer,
    view: state.host.view,
    widgets: [...state.widgets.values()].map(({ key, placement, lines }) => ({ key, placement, lines })),
    custom: state.custom,
    header: state.header,
    working: state.working,
  };
}

/**
 * 所有扩展 surface 的统一输入入口。
 * surface: footer | widget | custom；payload 与终端组件坐标一致。
 */
function extensionAction(sessionId, input = {}) {
  const state = extensionUIStates.get(sessionId);
  if (!state) return { lines: [] };
  if (input.surface === 'widget') {
    const widget = state.widgets.get(input.key);
    if (widget?.host) return widget.host.action(input);
    return { lines: widget?.lines || [], raw: [], interactive: false };
  }
  if (input.surface === 'header') {
    return state.headerHost?.action(input) ?? { lines: state.header?.lines || [] };
  }
  if (input.surface === 'custom') {
    // onTerminalInput 是全局输入监听，custom 浮层获得焦点时优先转给它。
    if (input.type === 'key' && state.terminalInputs.size > 0) {
      const data = input.sequence || input.key;
      for (const handler of state.terminalInputs) if (handler(data)?.consume) return { lines: [] };
    }
    return state.customHost?.action(input) ?? { lines: [] };
  }
  return state.host.action(input);
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
  return extensionAction(sessionId, { ...input, surface: 'footer' });
}
function updateEditorText(sessionId, text) {
  const state = extensionUIStates.get(sessionId);
  if (state) state.editorText = String(text ?? '');
}

module.exports = { createExtensionUI, extensionState, extensionAction, extensionDialogResult, extensionSelectResult, updateEditorText, footerAction, listExtensions };
