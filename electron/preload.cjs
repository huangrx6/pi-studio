const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  state: () => ipcRenderer.invoke('pi:state'),
  createSession: (cwd) => ipcRenderer.invoke('pi:session-create', cwd),
  session: (id) => ipcRenderer.invoke('pi:session', id),
  prompt: (payload) => ipcRenderer.invoke('pi:prompt', payload),
  files: (cwd, path) => ipcRenderer.invoke('pi:files', { cwd, path }),
  file: (cwd, path) => ipcRenderer.invoke('pi:file', { cwd, path }),
  chooseWorkspace: () => ipcRenderer.invoke('pi:choose-workspace'),
  models: () => ipcRenderer.invoke('pi:models'),
  settings: (cwd) => ipcRenderer.invoke('pi:settings', cwd),
  setKey: (payload) => ipcRenderer.invoke('pi:set-key', payload),
  setMcpEnabled: (payload) => ipcRenderer.invoke('pi:set-mcp-enabled', payload),
  addProvider: (payload) => ipcRenderer.invoke('pi:add-provider', payload),
  addMcp: (payload) => ipcRenderer.invoke('pi:add-mcp', payload),
  addSkill: (payload) => ipcRenderer.invoke('pi:add-skill', payload),
  addExtension: (payload) => ipcRenderer.invoke('pi:add-extension', payload),
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('pi:open-settings', handler);
    return () => ipcRenderer.removeListener('pi:open-settings', handler);
  },
  setModel: (modelRef) => ipcRenderer.invoke('pi:set-model', modelRef),
  onPrompt: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:prompt-event', handler);
    return () => ipcRenderer.removeListener('pi:prompt-event', handler);
  },
});
