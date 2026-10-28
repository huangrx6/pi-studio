const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  state: (cwd) => ipcRenderer.invoke('pi:state', cwd),
  createSession: (cwd) => ipcRenderer.invoke('pi:session-create', cwd),
  session: (id) => ipcRenderer.invoke('pi:session', id),
  prompt: (payload) => ipcRenderer.invoke('pi:prompt', payload),
  files: (cwd, path) => ipcRenderer.invoke('pi:files', { cwd, path }),
  file: (cwd, path) => ipcRenderer.invoke('pi:file', { cwd, path }),
  fileActions: (payload) => ipcRenderer.invoke('pi:file-actions', payload),
  openWith: (payload) => ipcRenderer.invoke('pi:open-with', payload),
  revealFile: (payload) => ipcRenderer.invoke('pi:reveal-file', payload),
  chooseWorkspace: () => ipcRenderer.invoke('pi:choose-workspace'),
  models: (cwd) => ipcRenderer.invoke('pi:models', cwd),
  providerModels: (providerId) => ipcRenderer.invoke('pi:provider-models', providerId),
  providerConfig: (providerId) => ipcRenderer.invoke('pi:provider-config', providerId),
  mcpConfig: (name) => ipcRenderer.invoke('pi:mcp-config', name),
  setEnabledModels: (models) => ipcRenderer.invoke('pi:set-enabled-models', models),
  addCustomModel: (payload) => ipcRenderer.invoke('pi:add-custom-model', payload),
  addPackage: (source) => ipcRenderer.invoke('pi:add-package', source),
  removePackage: (source) => ipcRenderer.invoke('pi:remove-package', source),
  settings: (cwd) => ipcRenderer.invoke('pi:settings', cwd),
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
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:open-settings', handler);
    return () => ipcRenderer.removeListener('pi:open-settings', handler);
  },
  setModel: (modelRef, cwd) => ipcRenderer.invoke('pi:set-model', modelRef, cwd),
  setThinkingLevel: (payload) => ipcRenderer.invoke('pi:set-thinking-level', payload),
  onPrompt: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:prompt-event', handler);
    return () => ipcRenderer.removeListener('pi:prompt-event', handler);
  },
});
