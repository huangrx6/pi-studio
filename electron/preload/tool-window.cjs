const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The tool host is trusted local UI. Guest pages and extension iframes get no bridge.
if (process.isMainFrame) {
  const subscribe = channel => listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
  const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
  const api = {
    platform: process.platform,
    terminalCreate: invoke('pi:terminal-create'),
    terminalWrite: (id, data) => ipcRenderer.send('pi:terminal-write', { id, data }),
    terminalResize: (id, cols, rows) => ipcRenderer.send('pi:terminal-resize', { id, cols, rows }),
    terminalClose: invoke('pi:terminal-close'),
    onTerminalEvent: subscribe('pi:terminal-event'),
    filePathOf: file => webUtils.getPathForFile(file),
    openLink: invoke('pi:tool-window-external'),
    openExternal: invoke('pi:tool-window-external'),
    extensionsUi: invoke('pi:extensions-ui'),
    openExtensionDataView: invoke('pi:extension-data-view-open'),
    closeExtensionDataView: invoke('pi:extension-data-view-close'),
    invokeExtensionView: invoke('pi:extension-view-invoke'),
    onExtensionDataView: subscribe('pi:extension-data-view'),
    onExtensionsChanged: subscribe('pi:extensions-changed'),
    runExtensionCommand: invoke('pi:extensions-command'),
    onBrowserCommand: subscribe('pi:browser-command'),
    onBrowserEvent: subscribe('pi:browser-event'),
  };
  for (const [name, channel] of Object.entries({
    browserDownloads: 'downloads', browserDownloadCancel: 'download-cancel',
    browserDownloadClear: 'download-clear', browserDownloadReveal: 'download-reveal',
    browserDownloadOpen: 'download-open', browserDownloadsFolder: 'downloads-folder',
    browserClearData: 'clear-data', browserAdvancedSettings: 'advanced-settings',
    browserExternalSessions: 'external-sessions', browserExternalDetach: 'external-detach',
    browserTabRegister: 'tab-register', browserTabUnregister: 'tab-unregister',
    browserTabUpdate: 'tab-update',
    browserControlState: 'control-state',
    browserControlPause: 'control-pause', browserSitePolicies: 'site-policies',
    browserSitePolicyUpsert: 'site-policy-upsert', browserSitePolicyRemove: 'site-policy-remove',
  })) api[name] = invoke('pi:browser-' + channel);
  contextBridge.exposeInMainWorld('piApi', api);
  contextBridge.exposeInMainWorld('toolWindowApi', {
    drag: invoke('pi:tool-window-drag'),
    state: invoke('pi:tool-window-state'),
    onState: subscribe('pi:tool-window-state-changed'),
    command: invoke('pi:tool-window-command'),
  });
}
