import assert from 'node:assert/strict';
import test from 'node:test';
import { contextUsagePresentation } from '../../web/src/features/conversation/context-usage.ts';
const usage = { usedTokens: 40_000, contextWindow: 100_000, percent: 40 };
const policy = { modelRef: 'qa/model', contextWindow: 200_000, autoCompactPercent: 85, compactAtTokens: 170_000 };

test('displayed denominator determines percent even if the reading carries an old window', () => {
  const view = contextUsagePresentation(usage, policy);
  assert.equal(view.percent, 20); assert.match(view.detail, /40.0k \/ 200k/);
});
test('explicitly unknown model window does not resurrect the reading window', () => {
  const view = contextUsagePresentation(usage, { ...policy, contextWindow: 0, compactAtTokens: null });
  assert.equal(view.known, false); assert.equal(view.percent, 0); assert.equal(view.tone, 'neutral');
  assert.match(view.compactionHint, /窗口未知/); assert.doesNotMatch(view.compactionHint, /已关闭/);
});
test('unread policy and disabled proportional compaction are distinct', () => {
  assert.match(contextUsagePresentation(usage, null).compactionHint, /尚未读取/);
  const view = contextUsagePresentation(usage, { ...policy, compactAtTokens: null });
  assert.match(view.compactionHint, /未启用/); assert.doesNotMatch(view.compactionHint, /未配置窗口/);
  assert.equal(view.tone, 'neutral');
});
test('effective token threshold drives warnings when reserved tokens change configured ratio', () => {
  const small = { modelRef: 'qa/small', contextWindow: 4096, autoCompactPercent: 85, compactAtTokens: 2048 };
  const view = contextUsagePresentation({ ...usage, usedTokens: 2048 }, small);
  assert.equal(view.percent, 50); assert.equal(view.tone, 'critical'); assert.match(view.compactionHint, /50%/);
  assert.equal(contextUsagePresentation({ ...usage, usedTokens: 1800 }, small).tone, 'warning');
  assert.equal(contextUsagePresentation({ ...usage, usedTokens: 1000 }, small).tone, 'neutral');
});
test('missing usage remains unknown and estimates are marked as estimates', () => {
  assert.equal(contextUsagePresentation(null, policy).known, false);
  assert.match(contextUsagePresentation(usage, policy).label, /估算/);
  assert.equal(contextUsagePresentation({ ...usage, usedTokens: 300_000 }, policy).percent, 100);
});
