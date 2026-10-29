/**
 * Process-local Electron state.
 *
 * This module intentionally contains no Pi configuration, credentials,
 * sessions, model runtime, or JSON-file helpers. Durable owns agent state and
 * Studio SQLite owns application preferences.
 */

const DEV = process.env.PI_STUDIO_DEV === '1';
const DEFAULT_CWD = process.env.PI_WORKSPACE ?? process.cwd();

let mainWindow;

function getWindow() {
  return mainWindow;
}

function setWindow(win) {
  mainWindow = win;
}

module.exports = {
  DEFAULT_CWD,
  DEV,
  getWindow,
  setWindow,
};
