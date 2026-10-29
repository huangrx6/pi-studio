/**
 * Read-only token usage analytics for the Settings page.
 */

const { ipcMain } = require('electron');
const { usageAnalyticsSnapshot } = require('../services/usage-analytics.cjs');

function registerUsageIpc() {
  ipcMain.handle('pi:usage-summary', async (_event, payload = {}) => (
    usageAnalyticsSnapshot({
      days: payload?.days,
      now: Date.now(),
    })
  ));
}

module.exports = { registerUsageIpc };
