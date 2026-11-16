/**
 * Read-only token usage analytics for the Settings page.
 */

const { ipcMain } = require('electron');
const { usageAnalyticsSnapshot, usageModelMix } = require('../services/usage-analytics.cjs');

function registerUsageIpc() {
  ipcMain.handle('pi:usage-summary', async (_event, payload = {}) => (
    usageAnalyticsSnapshot({
      days: payload?.days,
      workspace: payload?.workspace,
      includeRemoved: payload?.includeRemoved !== false,
      now: Date.now(),
    })
  ));
  ipcMain.handle('pi:usage-models', async (_event, payload = {}) => (
    usageModelMix({
      all: payload?.all === true,
      sinceDay: payload?.sinceDay,
      untilDay: payload?.untilDay,
      days: payload?.days,
      workspace: payload?.workspace,
      includeRemoved: payload?.includeRemoved !== false,
      now: Date.now(),
    })
  ));
}

module.exports = { registerUsageIpc };
