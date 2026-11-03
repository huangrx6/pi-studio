const assert = require('node:assert/strict');
const test = require('node:test');

const { scanStopReason } = require('../../electron/services/durable-conversations.cjs');

const base = {
  messageLimit: 200,
  scanLimit: 2_000,
  hasTarget: false,
  reachedTarget: true,
  hasMoreEntries: true,
};

test('plain paging stops as soon as the page is full', () => {
  assert.equal(scanStopReason({ ...base, count: 80 }), 'continue');
  assert.equal(scanStopReason({ ...base, count: 200 }), 'complete');
  assert.equal(scanStopReason({ ...base, count: 200, hasMoreEntries: false }), 'complete');
});

test('a target entry keeps the scan going past the page size until it is reached', () => {
  // 回归：entry id 比消息条数涨得快，页满了但目标还没出现时必须继续扫描，
  // 否则调用方会拿到不含目标的窗口，点大纲就没有反应。
  assert.equal(
    scanStopReason({ ...base, count: 200, hasTarget: true, reachedTarget: false }),
    'continue',
  );
  assert.equal(
    scanStopReason({ ...base, count: 260, hasTarget: true, reachedTarget: false }),
    'continue',
  );
  assert.equal(
    scanStopReason({ ...base, count: 260, hasTarget: true, reachedTarget: true }),
    'complete',
  );
});

test('the scan still stops at its hard limit when the target never appears', () => {
  assert.equal(
    scanStopReason({ ...base, count: 2_000, hasTarget: true, reachedTarget: false }),
    'limit',
  );
  assert.equal(scanStopReason({ ...base, count: 2_000 }), 'limit');
});

test('running out of entries ends the scan without a cursor', () => {
  assert.equal(
    scanStopReason({ ...base, count: 40, hasMoreEntries: false }),
    'exhausted',
  );
  assert.equal(
    scanStopReason({ ...base, count: 40, hasTarget: true, reachedTarget: false, hasMoreEntries: false }),
    'exhausted',
  );
});
