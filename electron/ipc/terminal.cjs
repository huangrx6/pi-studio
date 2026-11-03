const { ipcMain, webContents } = require('electron');
const { createTerminalSessionManager } = require('../services/terminal-sessions.cjs');

let terminalSessions;
const watchedSenders = new WeakSet();

function sendToRenderer(ownerId, channel, payload) {
  const target = webContents.fromId(ownerId);
  if (target && !target.isDestroyed()) target.send(channel, payload);
}

function manager() {
  if (!terminalSessions) terminalSessions = createTerminalSessionManager({ send: sendToRenderer });
  return terminalSessions;
}

function watchSender(sender) {
  if (watchedSenders.has(sender)) return;
  watchedSenders.add(sender);
  sender.once('destroyed', () => manager().closeOwner(sender.id));
}

function registerTerminalIpc() {
  ipcMain.handle('pi:terminal-create', (event, payload = {}) => {
    watchSender(event.sender);
    return manager().create({ ...payload, ownerId: event.sender.id });
  });
  ipcMain.handle('pi:terminal-write', (event, { id, data } = {}) => (
    manager().write({ ownerId: event.sender.id, id, data })
  ));
  ipcMain.handle('pi:terminal-resize', (event, { id, cols, rows } = {}) => (
    manager().resize({ ownerId: event.sender.id, id, cols, rows })
  ));
  ipcMain.handle('pi:terminal-close', (event, id) => (
    manager().close({ ownerId: event.sender.id, id })
  ));
}

function shutdownTerminalSessions() {
  terminalSessions?.shutdown();
  terminalSessions = undefined;
}

module.exports = { registerTerminalIpc, shutdownTerminalSessions };
