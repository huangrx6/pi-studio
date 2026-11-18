const { ipcMain } = require('electron');
const { networkService } = require('../services/network.cjs');

function registerNetworkIpc(waitForStartup) {
  const handle = (channel, run) => ipcMain.handle(channel, async (_event, payload) => {
    await waitForStartup();
    return run(networkService(), payload);
  });
  handle('pi:network-settings', network => network.snapshot());
  handle('pi:network-save', (network, settings) => network.save(settings));
  handle('pi:network-detect', (network, settings) => network.inspect(settings));
  handle('pi:network-test', (network, settings) => network.inspect(settings, true));
}

module.exports = { registerNetworkIpc };
