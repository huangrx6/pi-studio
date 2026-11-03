import assert from 'node:assert/strict';
import test from 'node:test';

import { compactTokens, contextUsage, usageTokens } from '../../web/src/features/conversation/context-usage.ts';

test('a request\'s context size adds input, cache and output', () => {
  assert.equal(usageTokens({ input: 1_000, output: 200, cacheRead: 3_000, cacheWrite: 50 }), 4_250);
  assert.equal(usageTokens({ input: 900, output: 100 }), 1_000);
  // Providers that only report a total still produce a reading.
  assert.equal(usageTokens({ totalTokens: 12_345 }), 12_345);
  assert.equal(usageTokens(undefined), 0);
  assert.equal(usageTokens({ input: 'x', output: -5 }), 0);
});

test('the newest usage reading wins and becomes a percentage of the window', () => {
  const messages = [
    { role: 'user', timestamp: 1 },
    { role: 'assistant', timestamp: 2, usage: { input: 20_000, output: 1_000, cacheRead: 4_000, cacheWrite: 0 } },
    { role: 'user', timestamp: 3 },
    { role: 'assistant', timestamp: 4, usage: { input: 60_000, output: 2_000, cacheRead: 10_000, cacheWrite: 0 } },
  ];
  assert.deepEqual(contextUsage(messages, 128_000), {
    usedTokens: 72_000,
    contextWindow: 128_000,
    percent: 56,
    at: 4,
  });
  // No window means no percentage, but the reading is still reported.
  assert.deepEqual(contextUsage(messages, 0), {
    usedTokens: 72_000,
    contextWindow: 0,
    percent: 0,
    at: 4,
  });
  assert.equal(contextUsage([], 128_000), null);
  assert.equal(contextUsage([{ role: 'user', timestamp: 1 }], 128_000), null);
  // A compaction leaves a smaller reading behind, so the gauge drops with it.
  assert.deepEqual(
    contextUsage([
      { role: 'assistant', timestamp: 4, usage: { input: 60_000, output: 2_000, cacheRead: 10_000, cacheWrite: 0 } },
      { role: 'assistant', timestamp: 5, usage: { input: 6_400, output: 300, cacheRead: 0, cacheWrite: 0 } },
    ], 128_000).percent,
    5,
  );
});

test('percent is capped at 100 when a reading exceeds the window', () => {
  const usage = contextUsage([{ role: 'assistant', usage: { input: 300_000 } }], 128_000);
  assert.equal(usage.percent, 100);
});

test('token labels stay compact across magnitudes', () => {
  assert.equal(compactTokens(940), '940');
  assert.equal(compactTokens(12_400), '12.4k');
  assert.equal(compactTokens(108_800), '109k');
  assert.equal(compactTokens(1_048_576), '1.0M');
  assert.equal(compactTokens(12_000_000), '12M');
  assert.equal(compactTokens(undefined), '0');
});
