import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOLLOW_BOTTOM_THRESHOLD,
  distanceFromBottom,
  isNearBottom,
  resolveAutoFollow,
  shouldReleaseFollowOnWheel,
} from '../../web/src/lib/chat-scroll.mjs';

test('distance and follow threshold use the rendered viewport, not a 2px clamp', () => {
  const metrics = { scrollTop: 664, clientHeight: 300, scrollHeight: 1000 };
  assert.equal(distanceFromBottom(metrics), 36);
  assert.equal(isNearBottom(metrics), true);
  assert.equal(isNearBottom({ ...metrics, scrollTop: 663.9 }), false);
  assert.equal(FOLLOW_BOTTOM_THRESHOLD, 36);
});

test('overscroll is clamped to zero', () => {
  assert.equal(distanceFromBottom({ scrollTop: 800, clientHeight: 300, scrollHeight: 1000 }), 0);
});

test('any upward wheel component outside nested scrollers releases follow', () => {
  assert.equal(shouldReleaseFollowOnWheel({ deltaX: 0, deltaY: -4, nestedScrollable: false }), true);
  assert.equal(shouldReleaseFollowOnWheel({ deltaX: 0, deltaY: 4, nestedScrollable: false }), false);
  assert.equal(shouldReleaseFollowOnWheel({ deltaX: 8, deltaY: -4, nestedScrollable: false }), true);
  assert.equal(shouldReleaseFollowOnWheel({ deltaX: 0, deltaY: -4, nestedScrollable: true }), false);
});

test('programmatic and no-op scrolls never change follow mode', () => {
  assert.equal(resolveAutoFollow({
    following: true,
    nearBottom: false,
    userInitiated: false,
    movedTowardStart: true,
  }), true);
  assert.equal(resolveAutoFollow({
    following: false,
    nearBottom: true,
    userInitiated: false,
    movedTowardStart: false,
  }), false);
});

test('a small upward move releases immediately while downward intent can re-arm', () => {
  assert.equal(resolveAutoFollow({
    following: true,
    nearBottom: true,
    userInitiated: true,
    movedTowardStart: true,
  }), false);
  assert.equal(resolveAutoFollow({
    following: false,
    nearBottom: true,
    userInitiated: true,
    movedTowardStart: false,
  }), true);
});
