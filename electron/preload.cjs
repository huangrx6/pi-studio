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
  setAppearance: (theme, palette, radiusStyle) => (
    ipcRenderer.invoke('pi:set-appearance', theme, palette, radiusStyle)
  ),
  windowState: () => ipcRenderer.invoke('pi:window-state'),
  onWindowState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('pi:window-state', handler);
    return () => ipcRenderer.removeListener('pi:window-state', handler);
  },
  updateState: () => ipcRenderer.invoke('pi:update-state'),
  checkForUpdates: (options) => ipcRenderer.invoke('pi:check-for-updates', options),
  downloadUpdate: () => ipcRenderer.invoke('pi:download-update'),
  installUpdate: () => ipcRenderer.invoke('pi:install-update'),
  menuBarSettings: () => ipcRenderer.invoke('pi:menu-bar-settings'),
  setMenuBarVisible: (enabled) => ipcRenderer.invoke('pi:menu-bar-set-visible', enabled),
  markMenuBarSessionSeen: (id) => ipcRenderer.send('pi:menu-bar-session-seen', id),
  chooseBackgroundMedia: (payload) => ipcRenderer.invoke('pi:background-media-choose', payload),
  removeBackgroundMedia: (url) => ipcRenderer.invoke('pi:background-media-remove', url),
  modeGet: (payload) => ipcRenderer.invoke('pi:mode-get', payload),
  modeSet: (payload) => ipcRenderer.invoke('pi:mode-set', payload),
  permissionPolicyGet: (payload) => ipcRenderer.invoke('pi:permission-policy-get', payload),
  permissionPolicySet: (payload) => ipcRenderer.invoke('pi:permission-policy-set', payload),
  permissionPolicyReset: (payload) => ipcRenderer.invoke('pi:permission-policy-reset', payload),
  permissionEvaluate: (payload) => ipcRenderer.invoke('pi:permission-evaluate', payload),
  confirmResponse: (payload) => ipcRenderer.send('pi:confirm-response', payload),
  state: (cwd) => ipcRenderer.invoke('pi:state', cwd),
  conversationList: () => ipcRenderer.invoke('pi:conversation-list'),
  createConversation: (payload) => ipcRenderer.invoke('pi:conversation-create', payload),
  conversationPage: (payload) => ipcRenderer.invoke('pi:conversation-page', payload),
  conversationOutline: (id) => ipcRenderer.invoke('pi:conversation-outline', id),
  conversationRequestTrace: (id, requestId) => ipcRenderer.invoke('pi:conversation-request-trace', { id, requestId }),
  conversationSnapshot: (id) => ipcRenderer.invoke('pi:conversation-snapshot', id),
  conversationSubmit: (payload) => ipcRenderer.invoke('pi:conversation-submit', payload),
  conversationEdit: (payload) => ipcRenderer.invoke('pi:conversation-edit', payload),
  conversationCompareStart: (payload) => ipcRenderer.invoke('pi:conversation-compare-start', payload),
  conversationCompareSnapshot: (payload) => ipcRenderer.invoke('pi:conversation-compare-snapshot', payload),
  conversationCompareAdopt: (payload) => ipcRenderer.invoke('pi:conversation-compare-adopt', payload),
  conversationCompareDiscard: (payload) => ipcRenderer.invoke('pi:conversation-compare-discard', payload),
  conversationConfigure: (payload) => ipcRenderer.invoke('pi:conversation-configure', payload),
  conversationInterrupt: (id) => ipcRenderer.invoke('pi:conversation-interrupt', { id }),
  conversationCompact: (payload) => ipcRenderer.invoke('pi:conversation-compact', payload),
  conversationAction: (payload) => ipcRenderer.invoke('pi:conversation-action', payload),
  conversationTaskGraph: (id) => ipcRenderer.invoke('pi:conversation-task-graph', id),
  sessionSubagents: (id) => ipcRenderer.invoke('pi:conversation-subagents', id),
  subagentTranscript: (payload) => ipcRenderer.invoke('pi:conversation-subagent-transcript', payload),
  deleteSubagent: (payload) => ipcRenderer.invoke('pi:conversation-subagent-delete', payload),
  replySubagentSupervisor: (payload) => ipcRenderer.invoke('pi:conversation-subagent-reply', payload),
  subscribeConversation: (id) => ipcRenderer.invoke('pi:conversation-subscribe', id),
  unsubscribeConversation: (id) => ipcRenderer.invoke('pi:conversation-unsubscribe', id),
  files: (cwd, path) => ipcRenderer.invoke('pi:files', { cwd, path }),
  file: (cwd, path) => ipcRenderer.invoke('pi:file', { cwd, path }),
  filePreview: (cwd, path) => ipcRenderer.invoke('pi:file-preview', { cwd, path }),
  turnDiffFile: (payload) => ipcRenderer.invoke('pi:turn-diff-file', payload),
  turnDiffAbsoluteFile: (payload) => ipcRenderer.invoke('pi:turn-diff-absolute-file', payload),
  filePreviewAbsolute: (payload) => ipcRenderer.invoke('pi:file-preview-absolute', payload),
  attachmentFile: (payload) => ipcRenderer.invoke('pi:attachment-file', payload),
  fileActions: (payload) => ipcRenderer.invoke('pi:file-actions', payload),
  openWith: (payload) => ipcRenderer.invoke('pi:open-with', payload),
  revealFile: (payload) => ipcRenderer.invoke('pi:reveal-file', payload),
  openExternal: (url) => ipcRenderer.invoke('pi:open-external', url),
  openLink: (url, mode) => ipcRenderer.invoke('pi:open-link', { url, mode }),
  terminalCreate: (payload) => ipcRenderer.invoke('pi:terminal-create', payload),
  terminalWrite: (id, data) => ipcRenderer.invoke('pi:terminal-write', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('pi:terminal-resize', { id, cols, rows }),
  terminalClose: (id) => ipcRenderer.invoke('pi:terminal-close', id),
  onTerminalEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:terminal-event', handler);
    return () => ipcRenderer.removeListener('pi:terminal-event', handler);
  },
  runtimeServices: (payload) => ipcRenderer.invoke('pi:runtime-services', payload),
  runtimeServiceStop: (payload) => ipcRenderer.invoke('pi:runtime-service-stop', payload),
  composerResources: (payload) => ipcRenderer.invoke('pi:conversation-resources', payload),
  searchFiles: (payload) => ipcRenderer.invoke('pi:search-files', payload),
  saveAttachment: (payload) => ipcRenderer.invoke('pi:save-attachment', payload),
  pickAttachments: (payload) => ipcRenderer.invoke('pi:pick-attachments', payload),
  saveUpload: (payload) => ipcRenderer.invoke('pi:save-upload', payload),
  copyImage: (payload) => ipcRenderer.invoke('pi:copy-image', payload),
  copyRichText: (payload) => ipcRenderer.invoke('pi:copy-rich-text', payload),
  chooseWorkspace: () => ipcRenderer.invoke('pi:choose-workspace'),
  models: (cwd) => ipcRenderer.invoke('pi:models', cwd),
  contextPolicy: (payload) => ipcRenderer.invoke('pi:context-policy', payload),
  usageSummary: (payload) => ipcRenderer.invoke('pi:usage-summary', payload),
  usageModels: (payload) => ipcRenderer.invoke('pi:usage-models', payload),
  providerModels: (providerId) => ipcRenderer.invoke('pi:provider-models', providerId),
  discoverProviderModels: (providerId) => ipcRenderer.invoke('pi:discover-provider-models', { providerId }),
  importProviderModels: (payload) => ipcRenderer.invoke('pi:import-provider-models', payload),
  providerConfig: (providerId) => ipcRenderer.invoke('pi:provider-config', providerId),
  listSecrets: () => ipcRenderer.invoke('pi:secrets-list'),
  setSecret: (payload) => ipcRenderer.invoke('pi:secret-set', payload),
  removeSecret: (name) => ipcRenderer.invoke('pi:secret-remove', name),
  mcpConfig: (name) => ipcRenderer.invoke('pi:mcp-config', name),
  testMcp: (input) => ipcRenderer.invoke('pi:test-mcp', input),
  testSavedMcp: (name) => ipcRenderer.invoke('pi:test-saved-mcp', name),
  startMcpOAuth: (name, cwd) => ipcRenderer.invoke('pi:mcp-oauth-start', { name, cwd }),
  logoutMcpOAuth: (name, cwd) => ipcRenderer.invoke('pi:mcp-oauth-logout', { name, cwd }),
  setEnabledModels: (payload) => ipcRenderer.invoke('pi:set-enabled-models', payload),
  addCustomModel: (payload) => ipcRenderer.invoke('pi:add-custom-model', payload),
  settings: (cwd) => ipcRenderer.invoke('pi:settings', cwd),
  conversationExtensionUiPreferences: () => ipcRenderer.invoke('pi:conversation-extension-ui-preferences'),
  saveConversationExtensionUiPreferences: (payload) => ipcRenderer.invoke('pi:save-conversation-extension-ui-preferences', payload),
  agentToolCatalog: (payload) => ipcRenderer.invoke('pi:agent-tool-catalog', payload),
  setAgentTools: (payload) => ipcRenderer.invoke('pi:set-agent-tools', payload),
  harnessSettings: (cwd) => ipcRenderer.invoke('pi:harness-settings', cwd),
  saveHarnessProfile: (payload) => ipcRenderer.invoke('pi:save-harness-profile', payload),
  selectHarnessProfile: (payload) => ipcRenderer.invoke('pi:select-harness-profile', payload),
  resetHarnessProfile: (payload) => ipcRenderer.invoke('pi:reset-harness-profile', payload),
  deleteHarnessProfile: (payload) => ipcRenderer.invoke('pi:delete-harness-profile', payload),
  saveRuntimePolicy: (payload) => ipcRenderer.invoke('pi:save-runtime-policy', payload),
  subagentSettings: (cwd) => ipcRenderer.invoke('pi:subagent-settings', cwd),
  subagentBudget: (payload) => ipcRenderer.invoke('pi:subagent-budget', payload),
  saveSubagentSettings: (payload) => ipcRenderer.invoke('pi:save-subagent-settings', payload),
  managedWorktrees: (payload) => ipcRenderer.invoke('pi:managed-worktrees', payload),
  managedWorktree: (id) => ipcRenderer.invoke('pi:managed-worktree', id),
  applyManagedWorktree: (id) => ipcRenderer.invoke('pi:apply-managed-worktree', id),
  discardManagedWorktree: (payload) => ipcRenderer.invoke('pi:discard-managed-worktree', payload),
  cleanupManagedWorktrees: () => ipcRenderer.invoke('pi:cleanup-managed-worktrees'),
  revealManagedWorktree: (id) => ipcRenderer.invoke('pi:reveal-managed-worktree', id),
  setKey: (payload) => ipcRenderer.invoke('pi:set-key', payload),
  setMcpEnabled: (payload) => ipcRenderer.invoke('pi:set-mcp-enabled', payload),
  setProviderEnabled: (payload) => ipcRenderer.invoke('pi:set-provider-enabled', payload),
  removeProvider: (payload) => ipcRenderer.invoke('pi:remove-provider', payload),
  refreshModels: (cwd) => ipcRenderer.invoke('pi:models-refresh', cwd),
  addProvider: (payload) => ipcRenderer.invoke('pi:add-provider', payload),
  addMcp: (payload) => ipcRenderer.invoke('pi:add-mcp', payload),
  refreshSkills: (cwd) => ipcRenderer.invoke('pi:skills-refresh', cwd),
  addSkill: (payload) => ipcRenderer.invoke('pi:add-skill', payload),
  pickSkillSourceDirectory: () => ipcRenderer.invoke('pi:pick-skill-source-directory'),
  pickSkillRegistryFile: () => ipcRenderer.invoke('pi:pick-skill-registry-file'),
  skillHub: (payload) => ipcRenderer.invoke('pi:skill-hub', payload),
  addSkillSource: (payload) => ipcRenderer.invoke('pi:add-skill-source', payload),
  setSkillSourceEnabled: (payload) => ipcRenderer.invoke('pi:set-skill-source-enabled', payload),
  removeSkillSource: (id) => ipcRenderer.invoke('pi:remove-skill-source', id),
  prepareSkillInstall: (payload) => ipcRenderer.invoke('pi:prepare-skill-install', payload),
  installPreparedSkill: (payload) => ipcRenderer.invoke('pi:install-prepared-skill', payload),
  disposePreparedSkill: (token) => ipcRenderer.invoke('pi:dispose-prepared-skill', token),
  addExtension: (payload) => ipcRenderer.invoke('pi:add-extension', payload),
  pickExtensionSource: (kind) => ipcRenderer.invoke('pi:pick-extension-source', { kind }),
  prepareExtensionInstall: (payload) => ipcRenderer.invoke('pi:extension-prepare', payload),
  checkExtensionUpdates: (payload) => ipcRenderer.invoke('pi:extensions-check-updates', payload),
  officialExtensions: (payload) => ipcRenderer.invoke('pi:official-extensions', payload),
  prepareOfficialExtension: (id) => ipcRenderer.invoke('pi:official-extension-prepare', { id }),
  setOfficialExtensionAutoUpdate: (payload) => ipcRenderer.invoke('pi:official-extension-auto-update', payload),
  refreshExtensionInstall: (token) => ipcRenderer.invoke('pi:extension-install-refresh', { token }),
  disposeExtensionInstallRecovery: (token) => ipcRenderer.invoke('pi:extension-install-recovery-dispose', { token }),
  installExtension: (payload) => ipcRenderer.invoke('pi:extension-install', payload),
  disposeExtensionInstall: (token) => ipcRenderer.invoke('pi:extension-dispose', { token }),
  rollbackExtension: (payload) => ipcRenderer.invoke('pi:extension-rollback', payload),
  refreshExtensionMutation: (token) => ipcRenderer.invoke('pi:extension-mutation-refresh', { token }),
  disposeExtensionMutationRecovery: (token) => ipcRenderer.invoke('pi:extension-mutation-recovery-dispose', { token }),
  extensionPublisherTrust: () => ipcRenderer.invoke('pi:extension-publisher-trust'),
  revokeExtensionPublisherKey: (payload) => ipcRenderer.invoke('pi:extension-publisher-revoke', payload),
  setExtensionRegistryUrl: (url) => ipcRenderer.invoke('pi:extension-registry-set', { url }),
  refreshMcp: (cwd) => ipcRenderer.invoke('pi:mcp-refresh', cwd),
  removeMcp: (name, cwd) => ipcRenderer.invoke('pi:remove-mcp', name, cwd),
  removeSkill: (path, cwd) => ipcRenderer.invoke('pi:remove-skill', path, cwd),
  setSkillTrusted: (payload) => ipcRenderer.invoke('pi:skill-trust', payload),
  removeExtension: (payload) => ipcRenderer.invoke('pi:remove-extension', payload),
  extensionsSnapshot: (cwd) => ipcRenderer.invoke('pi:extensions-snapshot', cwd),
  reloadExtensions: (cwd) => ipcRenderer.invoke('pi:extensions-reload', cwd),
  setExtensionEnabled: (payload) => ipcRenderer.invoke('pi:extensions-enable', payload),
  setExtensionTrusted: (payload) => ipcRenderer.invoke('pi:extensions-trust', payload),
  extensionsUi: (cwd) => ipcRenderer.invoke('pi:extensions-ui', cwd),
  openExtensionDataView: (payload) => ipcRenderer.invoke('pi:extension-data-view-open', payload),
  closeExtensionDataView: (subscriptionId) => ipcRenderer.invoke('pi:extension-data-view-close', subscriptionId),
  onExtensionDataView: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:extension-data-view', handler);
    return () => ipcRenderer.removeListener('pi:extension-data-view', handler);
  },
  runExtensionCommand: (payload) => ipcRenderer.invoke('pi:extensions-command', payload),
  onExtensionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:extensions-changed', handler);
    return () => ipcRenderer.removeListener('pi:extensions-changed', handler);
  },
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
  setThinkingLevel: (payload) => ipcRenderer.invoke('pi:set-thinking-level', payload),
  setDefaultThinkingLevel: (payload) => ipcRenderer.invoke('pi:set-default-thinking-level', payload),
  onConversationListChanged: (listener) => { const handler = () => listener(); ipcRenderer.on('pi:conversation-list-changed', handler); return () => ipcRenderer.removeListener('pi:conversation-list-changed', handler); },
  onConversationEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:conversation-event', handler);
    return () => ipcRenderer.removeListener('pi:conversation-event', handler);
  },
});
