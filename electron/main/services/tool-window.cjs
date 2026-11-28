const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { WebContentsView, ipcMain, shell } = require('electron');
const { DEV, getWindow } = require('../core/state.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { resolveBrowserOpenUrl } = require('./browser/open-target.cjs');
const { normalizeExternalHttpUrl } = require('../core/external-url.cjs');
const { isAllowedLocalHtmlUrl } = require('./local-html.cjs');
const { installRendererSecurity, showMainWindow } = require('../window.cjs');
const { fitToolBounds, dragToolBounds, placementForBounds } = require('./tool-window-bounds.cjs');

const groups = new Set();
let context = { key: 'studio', title: 'Pi Studio' };
let activeKey = context.key;
let toolView;
let host;
let loading;
let pendingReveal = false;
const anchors = new WeakMap();
let attached = false;
let maximized = false;
let placement = { offsetX: 0, offsetY: 0 };
let drag;
const dragHandles = new Set(['move', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

function toolContents() {
  const contents = toolView?.webContents;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

function assertSender(event, contents) {
  if (!contents || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
    throw new Error('工具面板请求来源无效');
  }
}

function visible() {
  return Boolean(attached && host && !host.isDestroyed() && host.isVisible() && !host.isMinimized());
}

function state() {
  return { groups: [...groups], key: activeKey, maximized, visible: visible() };
}

function publish() {
  toolContents()?.send('pi:tool-window-state-changed', state());
}

function publishVisibility() {
  publish();
  if (host && !host.isDestroyed()) host.webContents.send('pi:tool-window-visibility', visible());
}

function browserUrl(value, cwd) {
  if (!value || value === 'about:blank') return 'about:blank';
  const url = resolveBrowserOpenUrl(value, cwd);
  if (isAllowedLocalHtmlUrl(url)) return url;
  return normalizeExternalHttpUrl(url, 65536);
}

function groupByKey(key) {
  for (const group of groups) if (group.context.key === key) return group;
}

function groupFor(owner) {
  let group = groupByKey(owner.key);
  if (!group) {
    const saved = getStudioDatabase().getSessionLayout(owner.key, 'tools');
    const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : []).filter(tab =>
      tab && typeof tab.id === 'string' && ['terminal', 'browser', 'extension'].includes(tab.kind));
    const active = saved?.active === '' || tabs.some(tab => tab.id === saved?.active) ? saved.active : tabs[0]?.id || '';
    group = { mountId: randomUUID(), context: owner, tabs, active };
    groups.add(group);
  } else {
    group.context = owner;
  }
  return group;
}

function save(group) {
  getStudioDatabase().setSessionLayout(group.context.key, 'tools', {
    active: group.active,
    tabs: group.tabs.map(({ id, kind, title, url, panelId }) => ({ id, kind, title, url, panelId })),
  });
}

function openTab(group, request) {
  if (!request || !['browser', 'terminal', 'extension'].includes(request.kind)) throw new Error('未知工具');
  let tab;
  const { kind } = request;
  if (kind === 'extension') {
    if (typeof request.panelId !== 'string' || !request.panelId || request.panelId.length > 300) throw new Error('请选择插件');
    tab = group.tabs.find(item => item.kind === kind && item.panelId === request.panelId);
  }
  const url = kind === 'browser' ? browserUrl(request.url, group.context.cwd) : undefined;
  if (kind === 'browser' && !request.newTab) {
    tab = group.tabs.find(item => item.kind === 'browser' && (item.url === url || (!request.url && request.library)));
  }
  if (!tab) {
    const titles = {
      terminal: '终端',
      browser: url === 'about:blank' ? '新标签页' : '浏览器',
      extension: typeof request.title === 'string' && request.title.trim() ? request.title.trim().slice(0, 160) : '插件',
    };
    tab = { id: randomUUID(), kind, title: titles[kind] };
    if (kind === 'browser') tab.url = url;
    if (kind === 'extension') tab.panelId = request.panelId;
    group.tabs.push(tab);
  }
  if (request.loadGuest) tab.loadGuest = true;
  if (request.library === 'history' || request.library === 'downloads') tab.libraryRequest = { id: randomUUID(), view: request.library };
  group.active = tab.id;
  save(group);
  return tab;
}

function viewArea() {
  const [width, height] = host.getContentSize();
  const zoom = host.webContents.getZoomFactor();
  const anchor = anchors.get(host);
  const x = Math.max(0, Math.min(width - 1, Math.round((anchor?.x ?? 0) * zoom)));
  const y = Math.max(0, Math.min(height - 1, Math.round((anchor?.y ?? 0) * zoom)));
  return { x, y, zoom,
    width: Math.max(1, Math.min(width - x, Math.round((anchor?.width ?? width / zoom) * zoom))),
    height: Math.max(1, Math.min(height - y, Math.round((anchor?.height ?? height / zoom) * zoom))),
  };
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function fitView() {
  if (!toolView || !host || host.isDestroyed()) return;
  const area = viewArea();
  if (drag && (drag.area.zoom !== area.zoom || !sameBounds(drag.area, area))) drag = undefined;
  const bounds = fitToolBounds(area, placement, maximized);
  if (!sameBounds(toolView.getBounds(), bounds)) toolView.setBounds(bounds);
}

function dragView({ phase, handle, x, y }) {
  if (!attached || !dragHandles.has(handle) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (phase === 'start') {
    if (!maximized || handle !== 'move') drag = { handle, x, y, area: viewArea(), bounds: toolView.getBounds(), placement, maximized };
    return;
  }
  if (!drag || drag.handle !== handle) return;
  const start = drag;
  if (phase === 'end' || phase === 'cancel') drag = undefined;
  if (phase !== 'update' && phase !== 'end') return;
  // Use the original bounds so hitting a limit and reversing tracks the pointer.
  const bounds = dragToolBounds(start.area, start.bounds, handle, Math.round(x - start.x), Math.round(y - start.y));
  const atStart = sameBounds(bounds, start.bounds);
  placement = atStart ? start.placement : placementForBounds(start.area, bounds, start.placement, handle);
  const wasMaximized = maximized;
  maximized = atStart && start.maximized;
  if (!sameBounds(toolView.getBounds(), bounds)) toolView.setBounds(bounds);
  if (maximized !== wasMaximized) publish();
}

function hideTools() {
  pendingReveal = false;
  drag = undefined;
  if (!attached || !host || host.isDestroyed()) return;
  attached = false;
  host.contentView.removeChildView(toolView);
  if (host.isVisible() && !host.isMinimized()) host.webContents.focus();
  publishVisibility();
}

function loadView() {
  if (toolView) return loading;
  const main = getWindow();
  if (!main || main.isDestroyed()) throw new Error('主窗口不可用');
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, '../../preload/tool-window.cjs'),
    sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: true,
  } });
  toolView = view;
  host = main;
  const contents = view.webContents;
  view.setBackgroundColor('#00000000');
  const handleShortcut = (event, input) => {
    if (!attached || input.type !== 'keyDown' || input.alt || input.isComposing
      || !(process.platform === 'darwin' ? input.meta : input.control)) return;
    const key = input.key.toLowerCase();
    if (!(key === 'w' && !input.shift || key === 't' && !input.shift || key === 'b' && input.shift)) return;
    event.preventDefault();
    if (input.isAutoRepeat) return;
    if (key === 'w') return hideTools();
    openTab(groupFor(context), { kind: key === 't' ? 'terminal' : 'browser', newTab: true });
    contents.focus();
    publish();
  };
  contents.on('before-input-event', handleShortcut);
  contents.on('did-attach-webview', (_event, guest) => guest.on('before-input-event', handleShortcut));
  fitView();
  const url = DEV ? 'http://127.0.0.1:5180/tools.html' : pathToFileURL(path.join(__dirname, '../../../dist/renderer/tools.html')).href;
  installRendererSecurity(contents, url);
  const visibilityEvents = ['show', 'hide', 'minimize', 'restore'];
  for (const event of visibilityEvents) main.on(event, publishVisibility);
  main.on('resize', fitView);
  const close = () => { if (!contents.isDestroyed()) contents.close(); };
  contents.once('render-process-gone', close);
  main.once('closed', close);
  contents.once('destroyed', () => {
    for (const event of visibilityEvents) main.removeListener(event, publishVisibility);
    main.removeListener('resize', fitView);
    main.removeListener('closed', close);
    if (toolView !== view) return;
    if (attached && !main.isDestroyed()) main.contentView.removeChildView(view);
    toolView = undefined;
    host = undefined;
    loading = undefined;
    attached = false;
    pendingReveal = false;
    maximized = false;
    placement = { offsetX: 0, offsetY: 0 };
    drag = undefined;
    groups.clear();
    if (!main.isDestroyed()) main.webContents.send('pi:tool-window-visibility', false);
  });
  loading = contents.loadURL(url).catch(error => { close(); throw error; });
  return loading;
}

async function reveal() {
  pendingReveal = true;
  await loadView();
  if (!pendingReveal || !toolContents() || host.isDestroyed()) return;
  pendingReveal = false;
  showMainWindow();
  if (!attached) {
    host.contentView.addChildView(toolView);
    attached = true;
    fitView();
  }
  toolView.webContents.focus();
  publishVisibility();
}

async function openTools(request, owner = context) {
  const group = groupFor(owner);
  const tab = request ? openTab(group, request) : null;
  if (owner.key === context.key) {
    activeKey = owner.key;
    await reveal();
  } else {
    groupFor(context);
    await loadView();
    publish();
  }
  return tab?.id;
}

function findToolTab(id) {
  for (const group of groups.values()) {
    const tab = group.tabs.find(item => item.id === id);
    if (tab) return { group, tab };
  }
}

function closeTabs(group, ids, keepId) {
  if (keepId !== undefined && !group.tabs.some(tab => tab.id === keepId)) return;
  const closing = new Set(ids);
  closing.delete(keepId);
  const previous = group.tabs;
  const tabs = previous.filter(tab => !closing.has(tab.id));
  if (tabs.length === previous.length) return;
  let active = group.active;
  if (closing.has(active)) {
    const index = previous.findIndex(tab => tab.id === active);
    active = previous.slice(0, index).findLast(tab => !closing.has(tab.id))?.id ?? tabs[0]?.id ?? '';
  }
  // A failed layout write must leave the user's running terminals available for a retry.
  save({ ...group, tabs, active });
  Object.assign(group, { tabs, active });
  for (const tab of previous) {
    if (toolView && tab.kind === 'terminal' && closing.has(tab.id)) {
      require('../ipc/terminal.cjs').closeTerminalForOwner(toolView.webContents.id, tab.id);
    }
  }
  publish();
}

async function command(key, value) {
  const group = groupByKey(key);
  if (!group) {
    if (value.kind === 'update') return;
    throw new Error('工具所属的会话已变更，请重新执行操作');
  }
  if (value.kind === 'update') {
    const tab = group.tabs.find(item => item.id === value.id);
    if (!tab) return;
    const title = String(value.title ?? tab.title).slice(0, 160);
    const url = tab.kind === 'browser' && value.url !== undefined ? browserUrl(value.url) : tab.url;
    if (tab.title === title && tab.url === url && !value.acknowledged) return;
    Object.assign(tab, { title, url });
    if (value.acknowledged === tab.libraryRequest?.id) delete tab.libraryRequest;
  } else {
    if (key !== activeKey) throw new Error('工具面板已切换到另一个会话');
    if (value.kind === 'open') {
      openTab(group, { ...value.request, newTab: value.request?.kind === 'browser' && !value.request?.url });
      publish();
      return;
    }
    if (value.kind === 'start') group.active = '';
    else if (value.kind === 'activate' && group.tabs.some(tab => tab.id === value.id)) group.active = value.id;
    else if (value.kind === 'close') return closeTabs(group, [value.id]);
    else if (value.kind === 'close-tabs' && Array.isArray(value.ids)) return closeTabs(group, value.ids, value.keepId);
    else if (value.kind === 'restart') {
      const tab = group.tabs.find(item => item.kind === 'terminal' && item.id === value.id);
      if (!tab) return;
      require('../ipc/terminal.cjs').closeTerminalForOwner(toolView.webContents.id, tab.id);
      tab.id = randomUUID();
      group.active = tab.id;
    } else if (value.kind === 'hide') { hideTools(); return; }
    else if (value.kind === 'maximize') {
      drag = undefined;
      maximized = !maximized;
      fitView();
      publish();
      return;
    } else if (value.kind === 'status-detail') {
      if (key !== context.key) throw new Error('请先切回此工具所属的对话');
      hideTools();
      showMainWindow().webContents.send('pi:extension-panel-requested', { panelId: value.panelId, ownerKey: key, sessionId: context.sessionId });
      return;
    } else if (value.kind === 'action') {
      if (key !== context.key) throw new Error('请先切回此工具所属的对话');
      if (key === 'studio' && ['prompt', 'file'].includes(value.action?.kind)) throw new Error('请先选择要接收内容的对话');
      if (key.startsWith('room:') && value.action?.kind === 'prompt') throw new Error('团队群聊暂不支持从工具面板发送提示词');
      hideTools();
      const win = showMainWindow();
      win.webContents.send('pi:tool-window-action', { ...value.action, ownerKey: key });
      return;
    } else return;
  }
  save(group);
  publish();
}

async function dispatchBrowserCommand(command) {
  if (command.type === 'open') {
    const owner = command.owner ? (groupByKey(command.owner.key)?.context || command.owner) : context;
    return openTools({ kind: 'browser', url: command.url, newTab: command.newTab, loadGuest: true }, owner);
  }
  const match = findToolTab(command.tabId);
  if (!match) return;
  if (command.type === 'close-tab') return closeTabs(match.group, [match.tab.id]);
  if (command.type === 'focus' || command.type === 'reveal') {
    match.group.active = match.tab.id;
    save(match.group);
    if (match.group.context.key === context.key) await reveal();
    else publish();
    return;
  }
  toolContents()?.send('pi:browser-command', command);
}

function browserConversationOwner(id, temporary) {
  const db = getStudioDatabase();
  if (temporary) {
    const row = db.db.prepare('SELECT id, title FROM temporary_chats WHERE durable_id = ?').get(id);
    if (row) return { key: 'temporary:' + row.id, title: row.title };
  } else {
    const row = db.getConversation(String(id));
    if (row) return { key: 'conversation:' + row.publicId, title: row.title, cwd: row.workspace, sessionId: row.publicId };
  }
  throw new Error('无法确定浏览器标签所属的会话');
}

function assertToolTab(event, id, kind) {
  assertSender(event, toolContents());
  const match = findToolTab(id);
  if (!match || match.tab.kind !== kind) throw new Error('工具标签已关闭');
  return match.group.context;
}

// A draft becomes the new conversation while its native guests and PTYs stay mounted.
function adoptDraftTools(cwd, publicId, title) {
  const oldKey = 'draft:' + cwd;
  const key = 'conversation:' + publicId;
  const group = groupByKey(oldKey);
  if (group) {
    // Keep the native webview's ancestor in the same DOM position. Reordering
    // a mounted webview in Chromium destroys and recreates its guest.
    group.context = { ...group.context, key, cwd, sessionId: publicId, title };
    require('./browser/tabs.cjs').adoptBrowserTabs(oldKey, key);
  }
  if (context.key === oldKey) context = { ...context, key, cwd, sessionId: publicId, title };
  if (activeKey === oldKey) activeKey = key;
  if (toolView) publish();
}

function forgetToolWindowOwners(keys) {
  for (const key of keys) {
    const group = groupByKey(key);
    if (!group) continue;
    for (const tab of group.tabs) {
      if (tab.kind === 'terminal' && toolView) require('../ipc/terminal.cjs').closeTerminalForOwner(toolView.webContents.id, tab.id);
    }
    groups.delete(group);
    if (key === context.key) { context = { key: 'studio', title: 'Pi Studio' }; activeKey = context.key; }
  }
  if (toolView) { groupFor(context); publish(); }
}

function registerToolWindowIpc() {
  ipcMain.handle('pi:tool-window-context', (event, next) => {
    assertSender(event, getWindow()?.webContents);
    if (typeof next?.key !== 'string' || !next.key || next.key.length > 8192) throw new Error('无效会话');
    if (next.key !== context.key) pendingReveal = false;
    context = { key: next.key, title: String(next.title || 'Pi Studio'), cwd: next.cwd, sessionId: next.sessionId, workspaces: next.workspaces };
    activeKey = context.key;
    if (toolView) {
      groupFor(context);
      publish();
    }
  });
  ipcMain.handle('pi:tool-window-anchor', (event, rect) => {
    const main = getWindow();
    assertSender(event, main?.webContents);
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error('无效的工具面板位置');
    anchors.set(main, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    fitView();
  });
  ipcMain.handle('pi:tool-window-open', (event, request) => {
    assertSender(event, getWindow()?.webContents);
    return openTools(request);
  });
  ipcMain.handle('pi:tool-window-hide', event => {
    assertSender(event, getWindow()?.webContents);
    hideTools();
  });
  ipcMain.handle('pi:tool-window-drag', (event, gesture) => {
    assertSender(event, toolContents());
    if (gesture) dragView(gesture);
  });
  ipcMain.handle('pi:tool-window-toggle', event => {
    assertSender(event, getWindow()?.webContents);
    return attached || pendingReveal ? hideTools() : openTools();
  });
  ipcMain.handle('pi:tool-window-visible', event => {
    assertSender(event, getWindow()?.webContents);
    return visible();
  });
  ipcMain.handle('pi:tool-window-command', (event, key, next) => {
    assertSender(event, toolContents());
    return command(key, next);
  });
  ipcMain.handle('pi:tool-window-state', event => { assertSender(event, toolContents()); return state(); });
  ipcMain.handle('pi:tool-window-external', (event, url) => {
    assertSender(event, toolContents());
    return shell.openExternal(normalizeExternalHttpUrl(url));
  });
}

module.exports = { toolContents, registerToolWindowIpc, dispatchBrowserCommand, browserConversationOwner, assertToolTab, adoptDraftTools, forgetToolWindowOwners };
