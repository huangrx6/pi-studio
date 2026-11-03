const { ipcMain } = require('electron');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  createRuntimeServiceScanner,
  selectRegisteredRoots,
} = require('../services/runtime-services.cjs');

function requestedRoots({ cwd, roots } = {}) {
  return [
    ...(typeof cwd === 'string' ? [cwd] : []),
    ...(Array.isArray(roots) ? roots.filter((value) => typeof value === 'string') : []),
  ].slice(0, 12);
}

function registeredWorkspaceRoots() {
  return getStudioDatabase().listWorkspaces().map((workspace) => workspace.cwd);
}

function registerRuntimeServicesIpc() {
  const scanner = createRuntimeServiceScanner();
  ipcMain.handle('pi:runtime-services', (_event, payload = {}) => {
    const roots = selectRegisteredRoots(requestedRoots(payload), registeredWorkspaceRoots());
    return scanner.scan({ roots });
  });
  ipcMain.handle('pi:runtime-service-stop', (_event, payload = {}) => {
    const roots = selectRegisteredRoots(requestedRoots(payload), registeredWorkspaceRoots());
    return scanner.stop({ roots, pid: payload.pid, port: payload.port });
  });
}

module.exports = { registerRuntimeServicesIpc };
