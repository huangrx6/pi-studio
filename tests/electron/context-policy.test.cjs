const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_AUTO_COMPACT_PERCENT,
  autoCompactOverrides,
  autoCompactReserveTokens,
  normalizeAutoCompactPercent,
} = require('../../electron/core/context-policy.cjs');

test('auto compact percent keeps 0 as "off" and clamps everything else into range', () => {
  assert.equal(normalizeAutoCompactPercent(undefined), DEFAULT_AUTO_COMPACT_PERCENT);
  assert.equal(normalizeAutoCompactPercent(''), DEFAULT_AUTO_COMPACT_PERCENT);
  assert.equal(normalizeAutoCompactPercent(Number.NaN), DEFAULT_AUTO_COMPACT_PERCENT);
  assert.equal(normalizeAutoCompactPercent(0), 0);
  assert.equal(normalizeAutoCompactPercent('0'), 0);
  assert.equal(normalizeAutoCompactPercent(30), 50);
  assert.equal(normalizeAutoCompactPercent('72'), 72);
  assert.equal(normalizeAutoCompactPercent(99.8), 95);
});

test('the percent maps onto the exact share of each context window', () => {
  assert.equal(autoCompactReserveTokens(128_000, 85), 19_200);
  assert.equal(autoCompactReserveTokens(128_000, 85) + 108_800, 128_000);
  assert.equal(autoCompactReserveTokens(1_000_000, 90), 100_000);
  assert.equal(autoCompactReserveTokens(64_000, 50), 32_000);
  // Tiny windows keep room for the answer instead of collapsing to zero.
  assert.equal(autoCompactReserveTokens(4_000, 95), 2_048);
  assert.equal(autoCompactReserveTokens(0, 85), undefined);
  assert.equal(autoCompactReserveTokens(128_000, 0), undefined);
});

test('per-model overrides cover known windows only and stay empty when disabled', () => {
  const models = [
    { providerId: 'demo', modelId: 'window-200k', contextWindow: 200_000 },
    { providerId: 'demo', modelId: 'unknown-window' },
    { providerId: 'other', modelId: 'window-8k', contextWindow: 8_000 },
  ];
  assert.deepEqual(autoCompactOverrides(models, 85), {
    'demo/window-200k': { reserveTokens: 30_000 },
    'other/window-8k': { reserveTokens: 2_048 },
  });
  assert.deepEqual(autoCompactOverrides(models, 0), {});
  assert.deepEqual(autoCompactOverrides(undefined, 85), {});
});
