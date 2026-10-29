const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piMenuBarApi', {
  state: () => ipcRenderer.invoke('pi:menu-bar-state'),
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('pi:menu-bar-updated', handler);
    return () => ipcRenderer.removeListener('pi:menu-bar-updated', handler);
  },
  openMain: () => ipcRenderer.send('pi:menu-bar-open-main'),
  openSession: (session) => ipcRenderer.send('pi:menu-bar-open-session', session),
  clearRecent: () => ipcRenderer.send('pi:menu-bar-clear-recent'),
  hide: () => ipcRenderer.send('pi:menu-bar-hide'),
});
