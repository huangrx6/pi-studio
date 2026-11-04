const assert = require('node:assert/strict');
const test = require('node:test');

const { scanStopReason } = require('../../electron/runtime/conversations.cjs');

const base = { messageLimit: 200, hasMoreEntries: true };

test('a scan stops as soon as the page is full', () => {
  assert.equal(scanStopReason({ ...base, count: 80 }), 'continue');
  assert.equal(scanStopReason({ ...base, count: 199 }), 'continue');
  assert.equal(scanStopReason({ ...base, count: 200 }), 'limit');
});

test('running out of entries ends the scan without a cursor', () => {
  assert.equal(scanStopReason({ ...base, count: 40, hasMoreEntries: false }), 'exhausted');
  assert.equal(scanStopReason({ ...base, count: 0, hasMoreEntries: false }), 'exhausted');
});
