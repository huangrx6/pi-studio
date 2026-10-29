/** IPC for Studio's SQLite-backed tool-approval policy. */

const { ipcMain } = require('electron');
const {
  MODES,
  modeAvailable,
  policyState,
  previewToolCall,
  readMode,
  resetPolicy,
  writeMode,
  writePolicy,
} = require('../services/mode.cjs');

function registerModeIpc() {
  ipcMain.handle('pi:mode-get', async (_event, payload = {}) => {
    const state = policyState(payload);
    return { ...state, available: modeAvailable(), mode: readMode(payload) };
  });

  // Durable's permission hook reads SQLite before every tool call. No command
  // is injected into the transcript and no restart is required.
  ipcMain.handle('pi:mode-set', async (_event, { mode, ...context } = {}) => {
    if (!MODES.includes(mode)) throw new Error('无效的权限模式');
    const state = writeMode(mode, context);
    return { ...state, mode, applied: true };
  });

  ipcMain.handle('pi:permission-policy-get', async (_event, payload = {}) => policyState(payload));
  ipcMain.handle('pi:permission-policy-set', async (_event, payload = {}) => writePolicy(payload));
  ipcMain.handle('pi:permission-policy-reset', async (_event, payload = {}) => resetPolicy(payload));
  ipcMain.handle('pi:permission-evaluate', async (_event, payload = {}) => previewToolCall(payload));
}

module.exports = { registerModeIpc };
