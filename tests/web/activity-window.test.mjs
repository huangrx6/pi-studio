import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_OUTPUT_EXPAND_STEP,
  ACTIVITY_OUTPUT_SOFT_LIMIT,
  clampActivityText,
} from '../../web/src/features/conversation/activity-window.ts';

test('clampActivityText prefers a line break near the limit', () => {
  const body = ['alpha', 'x'.repeat(100), 'beta', 'y'.repeat(20_000)].join('\n');
  const clamped = clampActivityText(body, 200);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.omitted > 0);
  assert.equal(clampActivityText('short').truncated, false);
});

test('expand step is larger than the first soft window', () => {
  assert.ok(ACTIVITY_OUTPUT_EXPAND_STEP > ACTIVITY_OUTPUT_SOFT_LIMIT);
});
