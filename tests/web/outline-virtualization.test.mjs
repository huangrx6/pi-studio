import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTLINE_OVERSCAN,
  OUTLINE_ROW_HEIGHT,
  OUTLINE_VIRTUAL_THRESHOLD,
  visibleOutlineRange,
} from '../../web/src/features/conversation/outline-virtualization.ts';

test('short outlines mount every tick', () => {
  assert.deepEqual(
    visibleOutlineRange(OUTLINE_VIRTUAL_THRESHOLD, 0, 200),
    { start: 0, end: OUTLINE_VIRTUAL_THRESHOLD },
  );
});

test('long outlines only mount the visible band with overscan', () => {
  const count = OUTLINE_VIRTUAL_THRESHOLD + 40;
  const scrollTop = 25 * OUTLINE_ROW_HEIGHT;
  const viewportHeight = 12 * OUTLINE_ROW_HEIGHT;
  const range = visibleOutlineRange(count, scrollTop, viewportHeight);
  assert.equal(range.start, Math.max(0, 25 - OUTLINE_OVERSCAN));
  assert.equal(range.end, Math.min(count, 25 + 12 + OUTLINE_OVERSCAN));
  assert.ok(range.end - range.start < count);
});

test('range clamps at the ends', () => {
  const count = 200;
  assert.deepEqual(visibleOutlineRange(count, 0, 50), {
    start: 0,
    end: Math.min(count, Math.ceil(50 / OUTLINE_ROW_HEIGHT) + OUTLINE_OVERSCAN),
  });
  const nearEnd = visibleOutlineRange(count, 190 * OUTLINE_ROW_HEIGHT, 40);
  assert.equal(nearEnd.end, count);
  assert.ok(nearEnd.start < count);
});
