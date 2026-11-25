const { getWindow } = require('../core/state.cjs');
const { refreshExtensionDataViews } = require('./extension-data-view.cjs');

const WORKBENCH_REFRESH_SCOPES = Object.freeze(['all', 'extensions', 'files', 'git', 'sessions']);

async function refreshWorkbenchViews(raw = {}) {
  const requestedScope = typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim() : 'all';
  if (!WORKBENCH_REFRESH_SCOPES.includes(requestedScope)) {
    throw new Error(`刷新范围无效：${requestedScope}`);
  }
  const extensionId = typeof raw.extensionId === 'string' ? raw.extensionId.trim().slice(0, 120) : '';
  const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId.trim().slice(0, 160) : '';

  let refreshedDataViews = 0;
  if (requestedScope === 'all' || requestedScope === 'extensions') {
    refreshedDataViews = await refreshExtensionDataViews({ extensionId, sourceId });
  }

  let windowNotified = false;
  const win = getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try {
      win.webContents.send('pi:workbench-refresh', {
        scope: requestedScope,
        ...(extensionId ? { extensionId } : {}),
        ...(sourceId ? { sourceId } : {}),
      });
      windowNotified = true;
    } catch {
      // Closing a window must not fail an agent refresh call.
    }
  }

  return {
    refreshed: true,
    scope: requestedScope,
    refreshedDataViews,
    windowNotified,
  };
}

module.exports = {
  WORKBENCH_REFRESH_SCOPES,
  refreshWorkbenchViews,
};
