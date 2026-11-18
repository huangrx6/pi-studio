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
  stopSession: (session) => ipcRenderer.invoke('pi:menu-bar-stop-session', session),
  openSettings: () => ipcRenderer.send('pi:menu-bar-open-settings'),
  checkUpdates: () => ipcRenderer.send('pi:menu-bar-check-updates'),
  clearRecent: () => ipcRenderer.send('pi:menu-bar-clear-recent'),
  quit: () => ipcRenderer.send('pi:menu-bar-quit'),
  hide: () => ipcRenderer.send('pi:menu-bar-hide'),
});
