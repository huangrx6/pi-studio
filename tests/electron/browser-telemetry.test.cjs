const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearTabTelemetry,
  normalizeConsoleLevel,
  readConsoleEntries,
  readNetworkEntries,
  recordConsoleEntry,
  recordNetworkComplete,
  recordNetworkError,
  recordNetworkStart,
} = require('../../electron/main/services/browser/telemetry.cjs');

test('console telemetry captures, filters, summarizes and clears bounded entries', () => {
  const wcId = 9901;
  clearTabTelemetry(wcId, 'all');
  recordConsoleEntry(wcId, { level: 0, message: 'debug tick', source: 'app.js', line: 10 });
  recordConsoleEntry(wcId, { level: 1, message: 'app mounted', source: 'app.js', line: 22 });
  recordConsoleEntry(wcId, { level: 2, message: 'deprecated prop', source: 'ui.js', line: 44 });
  recordConsoleEntry(wcId, { level: 3, message: 'TypeError: undefined', source: 'api.js', line: 88 });

  assert.equal(normalizeConsoleLevel('warn'), 'warning');
  assert.equal(normalizeConsoleLevel(3), 'error');

  const all = readConsoleEntries(wcId);
  assert.equal(all.summary.total, 4);
  assert.equal(all.summary.errors, 1);
  assert.equal(all.summary.warnings, 1);
  assert.equal(all.entries.length, 4);

  const errors = readConsoleEntries(wcId, { level: 'error' });
  assert.equal(errors.entries.length, 1);
  assert.match(errors.entries[0].message, /TypeError/);

  const warnAndAbove = readConsoleEntries(wcId, { level: 'warning' });
  assert.equal(warnAndAbove.entries.length, 2);

  const searched = readConsoleEntries(wcId, { search: 'deprecated', clear: true });
  assert.equal(searched.entries.length, 1);
  assert.equal(readConsoleEntries(wcId).summary.total, 0);
});

test('network telemetry pairs start/complete/error and filters failures cleanly', () => {
  const wcId = 9902;
  clearTabTelemetry(wcId, 'all');

  recordNetworkStart({ id: 1, webContentsId: wcId, url: 'http://localhost:5173/api/users', method: 'GET', resourceType: 'xhr', timestamp: 1000 });
  recordNetworkComplete({ id: 1, webContentsId: wcId, url: 'http://localhost:5173/api/users', method: 'GET', resourceType: 'xhr', statusCode: 200, timestamp: 1045 });

  recordNetworkStart({ id: 2, webContentsId: wcId, url: 'http://localhost:5173/api/save', method: 'POST', resourceType: 'xhr', timestamp: 2000 });
  recordNetworkComplete({ id: 2, webContentsId: wcId, url: 'http://localhost:5173/api/save', method: 'POST', resourceType: 'xhr', statusCode: 500, timestamp: 2120 });

  recordNetworkStart({ id: 3, webContentsId: wcId, url: 'http://localhost:5173/api/offline', method: 'GET', resourceType: 'fetch', timestamp: 3000 });
  recordNetworkError({ id: 3, webContentsId: wcId, url: 'http://localhost:5173/api/offline', method: 'GET', resourceType: 'fetch', error: 'net::ERR_CONNECTION_REFUSED', timestamp: 3020 });

  // ERR_ABORTED is ignored as normal navigation noise.
  recordNetworkError({ id: 4, webContentsId: wcId, url: 'http://localhost:5173/cancel', error: 'net::ERR_ABORTED', timestamp: 3050 });

  const all = readNetworkEntries(wcId);
  assert.equal(all.summary.total, 3);
  assert.equal(all.summary.failed, 2);
  assert.equal(all.entries[0].durationMs, 45);
  assert.equal(all.entries[1].statusCode, 500);
  assert.equal(all.entries[2].error, 'net::ERR_CONNECTION_REFUSED');

  const failedOnly = readNetworkEntries(wcId, { failedOnly: true });
  assert.equal(failedOnly.entries.length, 2);

  const byUrl = readNetworkEntries(wcId, { urlIncludes: '/api/save', clear: true });
  assert.equal(byUrl.entries.length, 1);
  assert.equal(readNetworkEntries(wcId).summary.total, 0);
});
