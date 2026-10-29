/**
 * 预加载脚本：把主进程能力以 `window.piApi` 暴露给渲染进程。
 *
 * 只暴露白名单方法（不做通用 invoke 转发），渲染进程无法访问任意通道。
 * 通道名需要与 electron/ipc/*.cjs 中注册的保持一致。
 *
 * 分组：主题与状态 / 会话 / 文件 / 附件 / 模型 / 设置 / 事件订阅。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  temporaryModel: (payload) => ipcRenderer.invoke('pi:temporary-model', payload),
  temporaryPrompt: (payload) => ipcRenderer.invoke('pi:temporary-prompt', payload),
  temporaryStop: (id) => ipcRenderer.invoke('pi:temporary-stop', id),
  temporaryClose: (id) => ipcRenderer.invoke('pi:temporary-close', id),
  onTemporary: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:temporary-event', handler); return () => ipcRenderer.removeListener('pi:temporary-event', handler); },
  setTheme: (theme) => ipcRenderer.invoke('pi:set-theme', theme),
  updateState: () => ipcRenderer.invoke('pi:update-state'),
  checkForUpdates: (options) => ipcRenderer.invoke('pi:check-for-updates', options),
  downloadUpdate: () => ipcRenderer.invoke('pi:download-update'),
  installUpdate: () => ipcRenderer.invoke('pi:install-update'),
  menuBarSettings: () => ipcRenderer.invoke('pi:menu-bar-settings'),
  setMenuBarVisible: (enabled) => ipcRenderer.invoke('pi:menu-bar-set-visible', enabled),
  chooseBackgroundMedia: (payload) => ipcRenderer.invoke('pi:background-media-choose', payload),
  removeBackgroundMedia: (url) => ipcRenderer.invoke('pi:background-media-remove', url),
  modeGet: () => ipcRenderer.invoke('pi:mode-get'),
  modeSet: (payload) => ipcRenderer.invoke('pi:mode-set', payload),
  confirmResponse: (payload) => ipcRenderer.send('pi:confirm-response', payload),
  state: (cwd) => ipcRenderer.invoke('pi:state', cwd),
  createSession: (cwd) => ipcRenderer.invoke('pi:session-create', cwd),
  session: (id, limit) => ipcRenderer.invoke('pi:session', id, limit),
  sessionOutline: (id) => ipcRenderer.invoke('pi:session-outline', id),
  sessionSubagents: (id) => ipcRenderer.invoke('pi:session-subagents', id),
  subagentTranscript: (payload) => ipcRenderer.invoke('pi:subagent-transcript', payload),
  sidebarAction: (payload) => ipcRenderer.invoke('pi:sidebar-action', payload),
  prompt: (payload) => ipcRenderer.invoke('pi:prompt', payload),
  files: (cwd, path) => ipcRenderer.invoke('pi:files', { cwd, path }),
  file: (cwd, path) => ipcRenderer.invoke('pi:file', { cwd, path }),
  turnDiffFile: (payload) => ipcRenderer.invoke('pi:turn-diff-file', payload),
  fileAbsolute: (path) => ipcRenderer.invoke('pi:file-absolute', path),
  fileActions: (payload) => ipcRenderer.invoke('pi:file-actions', payload),
  openWith: (payload) => ipcRenderer.invoke('pi:open-with', payload),
  revealFile: (payload) => ipcRenderer.invoke('pi:reveal-file', payload),
  openExternal: (url) => ipcRenderer.invoke('pi:open-external', url),
  openLink: (url, mode) => ipcRenderer.invoke('pi:open-link', { url, mode }),
  composerResources: (payload) => ipcRenderer.invoke('pi:composer-resources', payload),
  searchFiles: (payload) => ipcRenderer.invoke('pi:search-files', payload),
  saveAttachment: (payload) => ipcRenderer.invoke('pi:save-attachment', payload),
  queuePrompt: (payload) => ipcRenderer.invoke('pi:queue-prompt', payload),
  runExtensionCommand: (payload) => ipcRenderer.invoke('pi:run-extension-command', payload),
  pickAttachments: (payload) => ipcRenderer.invoke('pi:pick-attachments', payload),
  saveUpload: (payload) => ipcRenderer.invoke('pi:save-upload', payload),
  chooseWorkspace: () => ipcRenderer.invoke('pi:choose-workspace'),
  models: (cwd) => ipcRenderer.invoke('pi:models', cwd),
  providerModels: (providerId) => ipcRenderer.invoke('pi:provider-models', providerId),
  discoverProviderModels: (providerId) => ipcRenderer.invoke('pi:discover-provider-models', { providerId }),
  importProviderModels: (payload) => ipcRenderer.invoke('pi:import-provider-models', payload),
  providerConfig: (providerId) => ipcRenderer.invoke('pi:provider-config', providerId),
  mcpConfig: (name) => ipcRenderer.invoke('pi:mcp-config', name),
  setEnabledModels: (models) => ipcRenderer.invoke('pi:set-enabled-models', models),
  addCustomModel: (payload) => ipcRenderer.invoke('pi:add-custom-model', payload),
  addPackage: (source) => ipcRenderer.invoke('pi:add-package', source),
  removePackage: (source) => ipcRenderer.invoke('pi:remove-package', source),
  settings: (cwd) => ipcRenderer.invoke('pi:settings', cwd),
  agentToolCatalog: (payload) => ipcRenderer.invoke('pi:agent-tool-catalog', payload),
  setAgentTools: (payload) => ipcRenderer.invoke('pi:set-agent-tools', payload),
  subagentSettings: (cwd) => ipcRenderer.invoke('pi:subagent-settings', cwd),
  saveSubagentSettings: (payload) => ipcRenderer.invoke('pi:save-subagent-settings', payload),
  setKey: (payload) => ipcRenderer.invoke('pi:set-key', payload),
  setMcpEnabled: (payload) => ipcRenderer.invoke('pi:set-mcp-enabled', payload),
  addProvider: (payload) => ipcRenderer.invoke('pi:add-provider', payload),
  addMcp: (payload) => ipcRenderer.invoke('pi:add-mcp', payload),
  addSkill: (payload) => ipcRenderer.invoke('pi:add-skill', payload),
  addExtension: (payload) => ipcRenderer.invoke('pi:add-extension', payload),
  removeMcp: (name) => ipcRenderer.invoke('pi:remove-mcp', name),
  removeSkill: (path) => ipcRenderer.invoke('pi:remove-skill', path),
  removeExtension: (path) => ipcRenderer.invoke('pi:remove-extension', path),
  removeCustomModel: (payload) => ipcRenderer.invoke('pi:remove-custom-model', payload),
  // ---- 主进程 → 渲染进程 的事件订阅（返回取消订阅函数）----
  onConfirmRequest: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:confirm-request', handler); return () => ipcRenderer.removeListener('pi:confirm-request', handler); },
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:open-settings', handler);
    return () => ipcRenderer.removeListener('pi:open-settings', handler);
  },
  onOpenUpdate: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:open-update', handler);
    return () => ipcRenderer.removeListener('pi:open-update', handler);
  },
  onUpdateState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:update-state', handler);
    return () => ipcRenderer.removeListener('pi:update-state', handler);
  },
  onOpenMain: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:open-main', handler);
    return () => ipcRenderer.removeListener('pi:open-main', handler);
  },
  onOpenSession: (listener) => {
    const handler = (_event, session) => listener(session);
    ipcRenderer.on('pi:open-session', handler);
    return () => ipcRenderer.removeListener('pi:open-session', handler);
  },
  onRuntimeRefresh: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:runtime-refresh', handler);
    return () => ipcRenderer.removeListener('pi:runtime-refresh', handler);
  },
  setModel: (modelRef, cwd) => ipcRenderer.invoke('pi:set-model', modelRef, cwd),
  setDefaultModel: (modelRef, cwd) => ipcRenderer.invoke('pi:set-default-model', modelRef, cwd),
  setSessionModel: (payload) => ipcRenderer.invoke('pi:set-session-model', payload),
  setSessionThinking: (payload) => ipcRenderer.invoke('pi:set-session-thinking', payload),
  setThinkingLevel: (payload) => ipcRenderer.invoke('pi:set-thinking-level', payload),
  setDefaultThinkingLevel: (payload) => ipcRenderer.invoke('pi:set-default-thinking-level', payload),
  footerAction: (payload) => ipcRenderer.invoke('pi:footer-action', payload),
  extensionAction: (payload) => ipcRenderer.invoke('pi:extension-action', payload),
  extensionDialogResult: (payload) => ipcRenderer.invoke('pi:extension-dialog-result', payload),
  extensionSelectResult: (payload) => ipcRenderer.invoke('pi:extension-select-result', payload),
  editorTextChanged: (payload) => ipcRenderer.send('pi:editor-text', payload),
  sessionFocus: (sessionId) => ipcRenderer.send('pi:session-focus', sessionId),
  onSessionsChanged: (listener) => { const handler = () => listener(); ipcRenderer.on('pi:sessions-changed', handler); return () => ipcRenderer.removeListener('pi:sessions-changed', handler); },
  extensionState: (sessionId) => ipcRenderer.invoke('pi:extension-state', sessionId),
  onExtensionStatus: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-status', handler); return () => ipcRenderer.removeListener('pi:extension-status', handler); },
  onExtensionFooter: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-footer', handler); return () => ipcRenderer.removeListener('pi:extension-footer', handler); },
  onExtensionWidgets: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-widgets', handler); return () => ipcRenderer.removeListener('pi:extension-widgets', handler); },
  onExtensionCustom: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-custom', handler); return () => ipcRenderer.removeListener('pi:extension-custom', handler); },
  onExtensionDialog: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-dialog', handler); return () => ipcRenderer.removeListener('pi:extension-dialog', handler); },
  onExtensionSelect: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-select', handler); return () => ipcRenderer.removeListener('pi:extension-select', handler); },
  onExtensionSelectClose: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-select-close', handler); return () => ipcRenderer.removeListener('pi:extension-select-close', handler); },
  onExtensionHeader: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-header', handler); return () => ipcRenderer.removeListener('pi:extension-header', handler); },
  onExtensionWorking: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-working', handler); return () => ipcRenderer.removeListener('pi:extension-working', handler); },
  onExtensionEditorSet: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-editor-set', handler); return () => ipcRenderer.removeListener('pi:extension-editor-set', handler); },
  onExtensionEditorPaste: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-editor-paste', handler); return () => ipcRenderer.removeListener('pi:extension-editor-paste', handler); },
  onExtensionNotify: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('pi:extension-notify', handler); return () => ipcRenderer.removeListener('pi:extension-notify', handler); },
  onPrompt: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:prompt-event', handler);
    return () => ipcRenderer.removeListener('pi:prompt-event', handler);
  },
});
