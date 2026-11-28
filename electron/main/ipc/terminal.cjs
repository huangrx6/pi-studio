const { ipcMain, webContents } = require('electron');
const { createTerminalSessionManager } = require('../services/terminal-sessions.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');

let terminalSessions;
const watchedSenders = new WeakSet();

function sendToRenderer(ownerId, channel, payload) {
  const target = webContents.fromId(ownerId);
  if (target && !target.isDestroyed()) target.send(channel, payload);
}

function manager() {
  if (!terminalSessions) {
    terminalSessions = createTerminalSessionManager({
      send: sendToRenderer,
      dataDirectory: studioDataDirectory(),
      batchOutput: true,
    });
  }
  return terminalSessions;
}

function watchSender(sender) {
  if (watchedSenders.has(sender)) return;
  watchedSenders.add(sender);
  const ownerId = sender.id;
  sender.once('destroyed', () => terminalSessions?.closeOwner(ownerId));
}

function registerTerminalIpc() {
  ipcMain.handle('pi:terminal-create', (event, payload = {}) => {
    const owner = require('../services/tool-window.cjs').assertToolTab(event, payload.id, 'terminal');
    watchSender(event.sender);
    return manager().create({ ...payload, cwd: owner.cwd || '', ownerId: event.sender.id });
  });
  // Keystrokes and resizes are latency-sensitive. A one-way channel avoids the
  // invoke round-trip that otherwise serializes every character behind a reply.
  ipcMain.on('pi:terminal-write', (event, { id, data } = {}) => {
    try {
      manager().write({ ownerId: event.sender.id, id, data });
    } catch {
      // Drop input for foreign or already-closed sessions instead of crashing.
    }
  });
  ipcMain.on('pi:terminal-resize', (event, { id, cols, rows } = {}) => {
    try {
      manager().resize({ ownerId: event.sender.id, id, cols, rows });
    } catch {
      // Geometry updates are best-effort while a session is exiting.
    }
  });
  ipcMain.handle('pi:terminal-close', (event, id) => (
    manager().close({ ownerId: event.sender.id, id })
  ));
}

function shutdownTerminalSessions() {
  terminalSessions?.shutdown();
  terminalSessions = undefined;
}

function closeTerminalForOwner(ownerId, id) {
  return terminalSessions?.close({ ownerId, id });
}

module.exports = { registerTerminalIpc, shutdownTerminalSessions, closeTerminalForOwner };
