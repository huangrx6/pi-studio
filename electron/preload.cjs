const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  state: () => ipcRenderer.invoke('pi:state'),
  createSession: (cwd) => ipcRenderer.invoke('pi:session-create', cwd),
  session: (id) => ipcRenderer.invoke('pi:session', id),
  prompt: (payload) => ipcRenderer.invoke('pi:prompt', payload),
  files: (cwd, path) => ipcRenderer.invoke('pi:files', { cwd, path }),
  file: (cwd, path) => ipcRenderer.invoke('pi:file', { cwd, path }),
  chooseWorkspace: () => ipcRenderer.invoke('pi:choose-workspace'),
  onPrompt: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:prompt-event', handler);
    return () => ipcRenderer.removeListener('pi:prompt-event', handler);
  },
});
